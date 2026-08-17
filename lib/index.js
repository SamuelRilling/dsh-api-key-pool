'use strict'
/**
 * dsh-api-key-pool v2 — 全局 API Key 轮换池（服务端）
 *
 * v2 升级：
 * 1. 自动发现 settings.yaml 里所有 llm-pi-ai provider（含 opencode 等自定义），
 *    每个 provider 都可配置多个 Key 轮换，不限于单个模型。
 * 2. 自动适配新旧厂商模式：捕获 "developer is not one of" 类 400 错误后，
 *    自动为该 provider 写入 compat.supportsDeveloperRole=false（商汤等旧网关）。
 * 3. 与 dsh-opencode-zen 联动：opencode 的 key 轮换也走本池。
 *
 * 注入：llm（agent/request 瀑布）、webServer（REST 接口）、settings
 */
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs')
const { dirname, join } = require('node:path')
const { homedir } = require('node:os')
const { load: loadYaml } = (() => { try { return require('js-yaml') } catch { return { load: (s) => { try { return JSON.parse(s) } catch { return {} } } } } })()
const name = 'api-key-pool'
const inject = ['llm', 'webServer']
const API_BASE = '/dsh-api-key-pool'
const CONFIG_FILE = join(__dirname, '..', 'pool-config.json')
const SETTINGS_FILE = join(homedir(), '.dsh', 'settings.yaml')

function log(ctx, level, msg) {
  try { ctx.logger[level](`[api-key-pool] ${msg}`) } catch { /* noop */ }
}
function mask(key) {
  if (!key) return ''
  if (key.length <= 8) return key.slice(0, 2) + '****'
  return key.slice(0, 6) + '****' + key.slice(-4)
}
function readJson(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}
function sendJson(res, code, data) {
  const payload = JSON.stringify(data)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}
function stringify(o) { return JSON.stringify(o ?? null) }
function patchSettingsYaml(mutateFn) {
  try {
    if (!existsSync(SETTINGS_FILE)) return false
    const raw = readFileSync(SETTINGS_FILE, 'utf8')
    mutateFn(raw)
    return true
  } catch (e) { log(null, 'warn', `patch settings failed: ${e.message}`); return false }
}

function apply(ctx, config) {
  const cfg = config || {}
  const pools = new Map()
  const probeTimers = new Map()
  const lifetime = new AbortController()
  const modeOverrides = new Map() // provider -> 'legacy'|'modern'，运行时记住
  // ── 加载持久化配置 ──
  const persisted = (() => {
    try { return existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {} } catch { return {} }
  })()
  const mergedConfig = { pools: { ...(cfg.pools || {}) } }
  for (const [provider, entry] of Object.entries(persisted.pools || {})) {
    if (!mergedConfig.pools[provider]) mergedConfig.pools[provider] = {}
    mergedConfig.pools[provider].apiKeyEnv = entry.apiKeyEnv || mergedConfig.pools[provider].apiKeyEnv
    mergedConfig.pools[provider].keys = entry.keys || []
  }
  function persistPools() {
    try {
      mkdirSync(dirname(CONFIG_FILE), { recursive: true })
      const out = { pools: {} }
      for (const [provider, p] of pools) {
        out.pools[provider] = { apiKeyEnv: p.env, keys: p.keys }
      }
      writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2), 'utf8')
    } catch (e) {
      log(ctx, 'warn', `persist failed: ${e.message}`)
    }
  }
  // 自动发现 settings.yaml 的 provider
  function discoverProviders() {
    try {
      const raw = readFileSync(SETTINGS_FILE, 'utf8')
      const doc = (loadYaml && typeof loadYaml === 'function') ? loadYaml(raw) : {}
      const providers = doc && doc['llm-pi-ai'] && doc['llm-pi-ai'].providers
      if (!providers || typeof providers !== 'object') return []
      return Object.keys(providers)
    } catch (e) { log(ctx, 'warn', `discoverProviders failed: ${e.message}`); return [] }
  }
  // 初始化池：合并持久化 + cfg；未在池里但出现在 settings 的 provider 也建空池
  const allProviders = new Set([...Object.keys(mergedConfig.pools || {}), ...discoverProviders()])
  for (const provider of allProviders) {
    if (pools.has(provider)) continue
    const pcfg = mergedConfig.pools?.[provider] || {}
    const env = pcfg.apiKeyEnv || `${provider.toUpperCase()}_API_KEY`
    const keys = Array.isArray(pcfg.keys) ? pcfg.keys.filter(Boolean) : []
    const autoKeys = (process.env[env] ? [process.env[env]].filter((k) => k && k !== 'public') : [])
    const dedup = [...new Set([...keys, ...autoKeys])]
    const cooldown = pcfg.cooldownMs || cfg.defaultCooldownMs || 30000
    pools.set(provider, {
      env, keys: dedup, cooldown, idx: 0,
      states: new Map(dedup.map(k => [k, { failCount: 0, cooldownUntil: 0 }])),
    })
    if (dedup.length > 0) log(ctx, 'info', `pool '${provider}': ${dedup.length} keys(auto+cfg)`)
  }
  log(ctx, 'info', `v2 loaded ${pools.size} pools: ${[...pools.keys()].join(', ') || '(none)'}`)
  function pickKey(provider) {
    const pool = pools.get(provider)
    if (!pool) return undefined
    const now = Date.now()
    const live = pool.keys.filter(k => (pool.states.get(k)?.cooldownUntil || 0) <= now)
    if (live.length === 0) {
      log(ctx, 'warn', `pool '${provider}': all keys cooling`)
      return pool.keys[pool.idx % pool.keys.length]
    }
    for (let i = 0; i < live.length; i++) {
      const key = live[(pool.idx + i) % live.length]
      const realIdx = pool.keys.indexOf(key)
      if (realIdx >= 0) { pool.idx = (realIdx + 1) % pool.keys.length; return key }
    }
    return pool.keys[0]
  }
  function markSuccess(provider, key) {
    const pool = pools.get(provider)
    if (!pool || !key) return
    const st = pool.states.get(key)
    if (st) { st.failCount = 0; st.cooldownUntil = 0 }
    if (probeTimers.has(key)) { clearTimeout(probeTimers.get(key)); probeTimers.delete(key) }
  }
  function markFailed(provider, key, reason) {
    const pool = pools.get(provider)
    if (!pool || !key) return
    const st = pool.states.get(key)
    if (!st) return
    st.failCount += 1
    const backoff = pool.cooldown * Math.min(st.failCount, 5)
    st.cooldownUntil = Date.now() + backoff
    log(ctx, 'warn', `key ${mask(key)} for '${provider}' failed (${reason}), cooldown ${backoff}ms`)
    if (probeTimers.has(key)) clearTimeout(probeTimers.get(key))
    if (!lifetime.signal.aborted) {
      probeTimers.set(key, setTimeout(() => {
        probeTimers.delete(key)
        st.failCount = 0  // 冷却期满，归零失败计数
        st.cooldownUntil = 0
        log(ctx, 'info', `key ${mask(key)} for '${provider}' finished cooldown, failCount reset`)
    }, backoff + 100))
    }
  }
  function applyKeyToEnv(provider, key) {
    const pool = pools.get(provider)
    if (!pool || !key) return
    const envName = pool.env
    const old = process.env[envName]
    process.env[envName] = key
    return () => {
      if (old === undefined) delete process.env[envName]
      else process.env[envName] = old
    }
  }
  // ── 商汤等旧网关自动适配：写 compat.supportsDeveloperRole=false ──
  function markLegacyProvider(provider) {
    if (modeOverrides.get(provider) === 'legacy') return
    modeOverrides.set(provider, 'legacy')
    log(ctx, 'info', `provider '${provider}' flagged LEGACY(no developer role), patching settings.yaml`)
    try {
      const raw = readFileSync(SETTINGS_FILE, 'utf8')
      const doc = loadYaml ? loadYaml(raw) : {}
      const prov = doc?.llm-pi-ai?.providers?.[provider]
      if (prov) {
        prov.compat = prov.compat || {}
        prov.compat.supportsDeveloperRole = false
        if (typeof prov.models === 'object' && prov.models && !Array.isArray(prov.models)) {
          // 兼容 provider.models 为对象的情况
        }
        // 写回：用简单文本替换方式改 provider 的 compat 段
        const lines = raw.split('\n')
        let out = []
        let inTarget = false, inCompat = false, patchedCompat = false
        for (const line of lines) {
          const trimmed = line.trim()
          if (/^    [A-Za-z0-9_-]+:/.test(line) && !/^      /.test(line)) {
            inTarget = (line.trim().replace(/:.*$/, '') === provider)
            if (inTarget) { inCompat = false }
          }
          if (inTarget && /^      compat:/.test(line)) { inCompat = true; patchedCompat = true }
          if (inTarget && inCompat && (line.startsWith('      ') === false || !line.startsWith('      '))) { inCompat = false }
          if (inTarget && inCompat && /supportsDeveloperRole:/.test(line) && !line.trim().startsWith('#')) {
            out.push(indentCompat(line, false))
            continue
          }
          out.push(line)
        }
        if (!patchedCompat) {
          // 在 provider 段结束前插入 compat
          const res = insertCompat(lines, provider)
          out = res
        }
        writeFileSync(SETTINGS_FILE, out.join('\n'), 'utf8')
        log(ctx, 'info', `settings.yaml patched for '${provider}': compat.supportsDeveloperRole=false`)
        // 尝试运行时刷新 llm-pi-ai 配置
        try {
          const settingsSvc = ctx.get('settings')
          if (settingsSvc && typeof settingsSvc.update === 'function') {
            settingsSvc.update('llm-pi-ai', { providers: { [provider]: { compat: { supportsDeveloperRole: false } } } }).catch((e) => log(ctx, 'warn', `live update failed: ${e.message}`))
          }
        } catch (e) { log(ctx, 'warn', `settings svc update skipped: ${e.message}`) }
      }
    } catch (e) { log(ctx, 'warn', `legacy patch error: ${e.message}`) }
  }
  function indentCompat(line, isFalse) {
    const ind = '          '
    const k = 'supportsDeveloperRole:'
    const v = isFalse ? 'false' : 'false'
    if (line.includes(k)) {
      return line.replace(new RegExp(`(${k})\\s*(true|false)`), `$1 ${v}`)
    }
    return ind + k + ' ' + v
  }
  function insertCompat(lines, provider) {
    const out = []
    let inTarget = false, inserted = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()
      if (/^    [A-Za-z0-9_-]+:/.test(line) && !/^      /.test(line)) {
        inTarget = (trimmed.replace(/:.*$/, '') === provider)
      }
      out.push(line)
      if (inTarget && !inserted && (i + 1 >= lines.length || /^    [A-Za-z0-9_-]+:/.test(lines[i + 1] || '') || /^[A-Za-z0-9_-]+:/.test(lines[i + 1] || ''))) {
        out.push('      compat:')
        out.push('        supportsDeveloperRole: false')
        inserted = true
        inTarget = false
      }
    }
    if (!inserted) {
      out.push('      compat:')
      out.push('        supportsDeveloperRole: false')
    }
    return out
  }
  // ── 每个 provider 的 env 写入串行锁（防止并发覆盖） ──
  const envQueues = new Map()

  function withEnvSerial(provider, fn) {
    const prev = envQueues.get(provider) || Promise.resolve()
    const next = prev.then(fn, fn)
    envQueues.set(provider, next)
    return next
  }

  // ── agent/request 瀑布：先选 Key → 设 env → 再请求 ──
  ctx.on('agent/request', async (payload, next) => {
    // agent/request 瀑布的 payload 只有 { turn, step, signal }，provider 在瀑布
    // 返回值（LlmCallConfig）里。先调用 next() 获得当前 provider，再注入 key。
    const config = await next()
    const provider = config?.provider
    if (!provider) return config
    const key = pickKey(provider)
    if (!key) return config
    return withEnvSerial(provider, () => {
      applyKeyToEnv(provider, key)
      log(ctx, 'info', `injected key ${mask(key)} for '${provider}'`)
      return config
    })
  })
  // ── agent/request-error 瀑布：标记失败 + 商汤兼容 ──
  ctx.on('agent/request-error', async (payload, next) => {
    const code = String(payload?.failure?.code || payload?.code || '')
    const rawMsg = String(payload?.failure?.message || payload?.message || '')
    const provider = payload?.provider
    // pi-ai 分类错误码（非 HTTP 状态码）
    // RATE_LIMIT=429, AUTH=401/403, QUOTA_EXCEEDED=无余额, TIMEOUT=超时, TRANSPORT=网络
    // v2.0.1: 宁多勿漏 — 任何 4xx/5xx 状态码、或消息含限流/配额/超时/鉴权关键词都触发轮换
    const RETRYABLE_CODES = ['RATE_LIMIT', 'AUTH', 'QUOTA_EXCEEDED', 'TIMEOUT', 'TRANSPORT']
    const origCode = code.replace(/\D/g, '')
    const isRetryable = RETRYABLE_CODES.includes(code) ||
      (origCode.length >= 3 && origCode[0] >= '4') ||  // 任何 4xx/5xx
      /rate|limit|quota|exhaust|throttl|429|too many|timeout|timed.?out|auth|credential|permission|denied|forbidden|unavailable|busy/i.test(rawMsg)
    if (provider && isRetryable) {
      const pool = pools.get(provider)
      if (pool) {
        const currentKey = process.env[pool.env]
        if (currentKey && pool.keys.includes(currentKey)) {
          markFailed(provider, currentKey, code)
          // 标记 key 失败后，让 agent loop 重试（走 agent/request 重新选 key）
          log(ctx, 'info', `key ${mask(currentKey)} failed (${code}), retrying with next key...`)
        }
      }
      return { kind: 'retry' }
    }
    // 商汤等旧网关：developer 角色不被支持 → 自动标记 legacy
    if (provider && /400/.test(code) && /developer is not one of|role.*developer|developer.*role/i.test(rawMsg)) {
      log(ctx, 'info', `provider '${provider}' rejects developer role, auto-switching to legacy mode`)
      markLegacyProvider(provider)
    }
    return next()
  })
  // ── REST 接口 ──
  function getLlmProviders() {
    try {
      return discoverProviders()
    } catch { return [] }
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${API_BASE}/llm-providers`,
    handler: async (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return }
      sendJson(res, 200, { providers: getLlmProviders() })
    },
  }), 'api-key-pool: llm-providers route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${API_BASE}/pools`,
    handler: async (req, res) => {
      if (req.method === 'GET') {
        const out = {}
        for (const [provider, p] of pools) {
          out[provider] = {
            apiKeyEnv: p.env,
            keys: p.keys,
            maskedKeys: p.keys.map(mask),
            mode: modeOverrides.get(provider) || 'auto',
            states: Object.fromEntries([...p.states].map(([k, s]) => [mask(k), { failCount: s.failCount, cooldownUntil: s.cooldownUntil }])),
          }
        }
        sendJson(res, 200, { pools: out, defaultCooldownMs: cfg.defaultCooldownMs || 30000, providers: getLlmProviders() })
      } else if (req.method === 'POST') {
        const body = await readJson(req)
        const provider = body.provider
        const action = body.action
        if (action === 'addProvider') {
          if (!provider) { sendJson(res, 400, { error: 'provider name required' }); return }
          if (pools.has(provider)) { sendJson(res, 409, { error: `provider '${provider}' already exists` }); return }
          const env = body.apiKeyEnv || `${provider.toUpperCase()}_API_KEY`
          const keys = body.key ? [body.key] : []
          pools.set(provider, { env, keys, cooldown: cfg.defaultCooldownMs || 30000, idx: 0, states: new Map(keys.map(k => [k, { failCount: 0, cooldownUntil: 0 }])) })
          persistPools()
          sendJson(res, 200, { ok: true, pool: { provider, apiKeyEnv: env, keys } }); return
        } else if (action === 'removeProvider') {
          if (!provider || !pools.has(provider)) { sendJson(res, 404, { error: `no pool for '${provider}'` }); return }
          pools.delete(provider)
          persistPools()
          sendJson(res, 200, { ok: true }); return
        } else if (!provider || !pools.has(provider)) {
          sendJson(res, 404, { error: `no pool for '${provider}'` }); return
        }
        const pool = pools.get(provider)
        if (action === 'add' && body.key) {
          if (!pool.keys.includes(body.key)) { pool.keys.push(body.key); pool.states.set(body.key, { failCount: 0, cooldownUntil: 0 }) }
          persistPools(); sendJson(res, 200, { ok: true, count: pool.keys.length })
        } else if (action === 'remove' && body.key) {
          pool.keys = pool.keys.filter(k => k !== body.key)
          pool.states.delete(body.key)
          persistPools(); sendJson(res, 200, { ok: true, count: pool.keys.length })
        } else if (action === 'update' && Array.isArray(body.keys)) {
          pool.keys = body.keys.filter(Boolean)
          pool.states = new Map(pool.keys.map(k => [k, { failCount: 0, cooldownUntil: 0 }]))
          pool.idx = 0
          persistPools(); sendJson(res, 200, { ok: true, count: pool.keys.length })
        } else if (action === 'reset') {
          pool.states = new Map(pool.keys.map(k => [k, { failCount: 0, cooldownUntil: 0 }]))
          sendJson(res, 200, { ok: true })
        } else {
          sendJson(res, 400, { error: `unknown action '${action}'` })
        }
      } else {
        sendJson(res, 405, { error: 'method not allowed' })
      }
    },
  }), 'api-key-pool: pools route')
  ctx.effect(() => () => {
    lifetime.abort()
    for (const t of probeTimers.values()) clearTimeout(t)
    probeTimers.clear()
  })
}
module.exports = { name, inject, apply, patchSettingsYaml, mask }