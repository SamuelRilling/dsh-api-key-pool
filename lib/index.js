'use strict'
/**
 * dsh-api-key-pool — API Key 轮换池（服务端）
 * Designed & built by 小哲 (xiaozhe7772222) 🐧
 *
 * 用 agent/request 瀑布在请求发出前注入 Key 到 process.env，
 * 用 agent/request-error 瀑布记录失败并切换。
 *
 * 注入：llm（agent/request 瀑布）、webServer（REST 接口）
 */
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs')
const { dirname, join } = require('node:path')

const name = 'api-key-pool'
const inject = ['llm', 'webServer']

const API_BASE = '/dsh-api-key-pool'
const CONFIG_FILE = join(__dirname, '..', 'pool-config.json')

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

function apply(ctx, config) {
  const cfg = config || {}
  const pools = new Map()
  const probeTimers = new Map()
  const lifetime = new AbortController()

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

  // init pools
  for (const [provider, pcfg] of Object.entries(mergedConfig.pools || {})) {
    const env = pcfg.apiKeyEnv || `${provider.toUpperCase()}_API_KEY`
    const keys = Array.isArray(pcfg.keys) ? pcfg.keys.filter(Boolean) : []
    if (keys.length === 0) continue
    const cooldown = pcfg.cooldownMs || cfg.defaultCooldownMs || 30000
    pools.set(provider, {
      env, keys, cooldown, idx: 0,
      states: new Map(keys.map(k => [k, { failCount: 0, cooldownUntil: 0 }])),
    })
  }
  log(ctx, 'info', `loaded ${pools.size} pools: ${[...pools.keys()].join(', ') || '(none)'}`)

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
        log(ctx, 'info', `key ${mask(key)} for '${provider}' finished cooldown`)
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

  // ── agent/request 瀑布：注入 Key ──
  ctx.on('agent/request', async (payload, next) => {
    const base = await next()
    const provider = base?.provider
    const key = pickKey(provider)
    if (!key) return base
    applyKeyToEnv(provider, key)
    log(ctx, 'info', `injected key ${mask(key)} for '${provider}'`)
    return base
  })

  // ── agent/request-error 瀑布：标记失败 ──
  ctx.on('agent/request-error', async (payload, next) => {
    const code = String(payload?.failure?.code || payload?.code || '')
    const provider = payload?.provider
    if (provider && /401|403|429/.test(code)) {
      const pool = pools.get(provider)
      if (pool) {
        const currentKey = process.env[pool.env]
        if (currentKey && pool.keys.includes(currentKey)) {
          markFailed(provider, currentKey, code)
        }
      }
    }
    return next()
  })

  // ── REST 接口 ──
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
            states: Object.fromEntries([...p.states].map(([k, s]) => [mask(k), { failCount: s.failCount, cooldownUntil: s.cooldownUntil }])),
          }
        }
        sendJson(res, 200, { pools: out, defaultCooldownMs: cfg.defaultCooldownMs || 30000 })
      } else if (req.method === 'POST') {
        const body = await readJson(req)
        const provider = body.provider
        const action = body.action
        if (!provider || !pools.has(provider)) { sendJson(res, 404, { error: `no pool for '${provider}'` }); return }
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

module.exports = { name, inject, apply }