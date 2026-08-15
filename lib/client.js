// dsh-api-key-pool client: settings panel card for managing API key pools
// Designed & built by 小哲 (xiaozhe7772222) 🐧
// Architecture: client card calls host REST API via fetch, renders key management UI
window.__ModuleLoader__.load({
  id: 'dsh-api-key-pool',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useMemo, useCallback, useEffect } = React

    // ── locale ──────────────────────────────────────────────────────────
    const NS = 'dsh-api-key-pool'
    const zh = {
      nav: 'API Key 池',
      desc: '管理每个供应商的 API Key 池，自动轮换和故障切换。保存后立即生效。',
      addKey: '+ 添加 Key',
      remove: '移除',
      reset: '重置冷却',
      refresh: '刷新状态',
      keys: 'Key 列表',
      poolFor: (p) => `供应商：${p}`,
      envHint: '环境变量名',
      status: '状态',
      healthy: '健康',
      cooling: '冷却中',
      cooldownUntil: (t) => `冷却至 ${t}`,
      failCount: (n) => `失败 ${n} 次`,
      noKeys: '暂无 Key，请在下方添加',
      operationOk: '操作成功',
      operationFail: '操作失败',
      loading: '加载中…',
    }

    // ── styles ──────────────────────────────────────────────────────────
    function installStyles() {
      const css = document.createElement('style')
      css.textContent = `
        .akp-card { font-family: inherit; }
        .akp-card h3 { margin: 0 0 8px 0; font-size: 14px; font-weight: 600; }
        .akp-card p { margin: 0 0 12px 0; font-size: 12px; opacity: 0.7; }
        .akp-pool { margin-bottom: 16px; padding: 12px; border: 1px solid var(--border-color, #ddd); border-radius: 8px; }
        .akp-pool-title { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .akp-pool-name { font-weight: 600; font-size: 13px; }
        .akp-pool-env { font-size: 11px; opacity: 0.6; }
        .akp-key-row { display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: 12px; }
        .akp-key-masked { flex: 1; font-family: monospace; font-size: 11px; }
        .akp-key-status { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .akp-key-status.healthy { background: #4caf50; }
        .akp-key-status.cooling { background: #ff9800; }
        .akp-key-remove { cursor: pointer; opacity: 0.5; font-size: 10px; }
        .akp-key-remove:hover { opacity: 1; }
        .akp-add-row { display: flex; gap: 6px; margin-top: 8px; }
        .akp-add-row input { flex: 1; padding: 4px 8px; font-size: 12px; border: 1px solid var(--border-color, #ddd); border-radius: 4px; background: var(--input-bg, #fff); color: var(--text-color, #333); }
        .akp-add-row button { padding: 4px 12px; font-size: 12px; border: 1px solid var(--accent-color, #1976d2); background: var(--accent-color, #1976d2); color: #fff; border-radius: 4px; cursor: pointer; }
        .akp-add-row button:disabled { opacity: 0.5; }
        .akp-actions { display: flex; gap: 8px; margin-top: 8px; }
        .akp-actions button { padding: 4px 10px; font-size: 11px; border: 1px solid var(--border-color, #ddd); border-radius: 4px; background: var(--card-bg, #f5f5f5); color: var(--text-color, #333); cursor: pointer; }
        .akp-msg { font-size: 11px; margin-top: 8px; padding: 4px 8px; border-radius: 4px; }
        .akp-msg.ok { background: #e8f5e9; color: #2e7d32; }
        .akp-msg.err { background: #ffebee; color: #c62828; }
      `
      document.head.appendChild(css)
      return () => css.remove()
    }

    // ── API call helper ─────────────────────────────────────────────────
    async function callApi(body) {
      const res = await fetch('/dsh-api-key-pool/pools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return res.json()
    }

    async function getPools() {
      const res = await fetch('/dsh-api-key-pool/pools')
      return res.json()
    }

    // ── React Component ─────────────────────────────────────────────────
    function ApiKeyPoolCard({ scope, t }) {
      const [data, setData] = useState(null)
      const [addInputs, setAddInputs] = useState({})
      const [msg, setMsg] = useState(null)
      const [loading, setLoading] = useState(true)

      const load = useCallback(async () => {
        setLoading(true)
        try {
          const d = await getPools()
          setData(d)
        } catch (e) {
          setMsg({ type: 'err', text: `加载失败: ${e.message}` })
        }
        setLoading(false)
      }, [])

      useEffect(() => { load() }, [load])

      const showMsg = useCallback((type, text) => {
        setMsg({ type, text })
        setTimeout(() => setMsg(null), 3000)
      }, [])

      const handleAdd = useCallback(async (provider) => {
        const key = (addInputs[provider] || '').trim()
        if (!key) return
        try {
          const r = await callApi({ action: 'add', provider, key })
          if (r.ok) { showMsg('ok', 'Key 已添加'); load(); setAddInputs(prev => ({ ...prev, [provider]: '' })) }
          else showMsg('err', r.error || '添加失败')
        } catch (e) { showMsg('err', e.message) }
      }, [addInputs, load, showMsg])

      const handleRemove = useCallback(async (provider, key) => {
        try {
          const r = await callApi({ action: 'remove', provider, key })
          if (r.ok) { showMsg('ok', 'Key 已移除'); load() }
          else showMsg('err', r.error || '移除失败')
        } catch (e) { showMsg('err', e.message) }
      }, [load, showMsg])

      const handleReset = useCallback(async (provider) => {
        try {
          const r = await callApi({ action: 'reset', provider })
          if (r.ok) { showMsg('ok', '冷却已重置'); load() }
          else showMsg('err', r.error || '重置失败')
        } catch (e) { showMsg('err', e.message) }
      }, [load, showMsg])

      if (loading) return React.createElement('div', { className: 'akp-card' }, '加载中…')

      const pools = data?.pools || {}
      const poolNames = Object.keys(pools)

      return React.createElement('div', { className: 'akp-card' },
        React.createElement('h3', null, 'API Key 轮换池'),
        React.createElement('p', null, '管理每个供应商的 API Key，自动轮换使用。失败后自动切换，冷却后恢复。'),

        poolNames.length === 0
          ? React.createElement('p', { style: { opacity: 0.5 } }, '暂无已配置的供应商池。请在 cordis.patch.yml 中配置 pools。')
          : poolNames.map(provider => {
              const pool = pools[provider]
              const keys = pool.maskedKeys || []
              const states = pool.states || {}
              return React.createElement('div', { key: provider, className: 'akp-pool' },
                React.createElement('div', { className: 'akp-pool-title' },
                  React.createElement('span', { className: 'akp-pool-name' }, provider),
                  React.createElement('span', { className: 'akp-pool-env' }, pool.apiKeyEnv),
                ),
                keys.length === 0
                  ? React.createElement('p', { style: { opacity: 0.5, fontSize: '11px' } }, '暂无 Key')
                  : keys.map((masked, i) => {
                      const state = states[masked] || { failCount: 0, cooldownUntil: 0 }
                      const isCooling = state.cooldownUntil > Date.now()
                      return React.createElement('div', { key: i, className: 'akp-key-row' },
                        React.createElement('span', { className: `akp-key-status ${isCooling ? 'cooling' : 'healthy'}` }),
                        React.createElement('span', { className: 'akp-key-masked' }, masked),
                        React.createElement('span', { style: { fontSize: '10px', opacity: 0.5 } },
                          isCooling
                            ? `冷却至 ${new Date(state.cooldownUntil).toLocaleTimeString()}`
                            : state.failCount > 0 ? `失败 ${state.failCount} 次` : '健康'
                        ),
                        React.createElement('span', {
                          className: 'akp-key-remove',
                          onClick: () => handleRemove(provider, pool.keys[i]),
                          title: '移除',
                        }, '✕'),
                      )
                    }),
                React.createElement('div', { className: 'akp-add-row' },
                  React.createElement('input', {
                    placeholder: '粘贴新的 API Key…',
                    value: addInputs[provider] || '',
                    onChange: (e) => setAddInputs(prev => ({ ...prev, [provider]: e.target.value })),
                    onKeyDown: (e) => { if (e.key === 'Enter') handleAdd(provider) },
                  }),
                  React.createElement('button', {
                    onClick: () => handleAdd(provider),
                    disabled: !(addInputs[provider] || '').trim(),
                  }, '添加'),
                ),
                React.createElement('div', { className: 'akp-actions' },
                  React.createElement('button', { onClick: () => handleReset(provider) }, '重置冷却'),
                  React.createElement('button', { onClick: load }, '刷新'),
                ),
              )
            }),
        msg && React.createElement('div', { className: `akp-msg ${msg.type}` }, msg.text),
      )
    }

    // ── apply: register settings panel card ─────────────────────────────
    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: 'dsh-api-key-pool' })
      ctx.effect(installStyles, 'dsh-api-key-pool: card styles')
      ctx.effect(
        () =>
          ctx.slots.inject('settings.plugin.item', function* () {
            yield ctx.slots.register(
              {
                name: 'settings.plugin.item',
                id: 'dsh-api-key-pool',
                order: 50,
                label: () => 'API Key 池',
                inject: () => ({ scope, t: (s) => zh[s] || s }),
              },
              ApiKeyPoolCard,
            )
          }),
        'dsh-api-key-pool: settings card',
      )
    }

    exports.apply = apply
    exports.inject = ['settingsScope', 'slots']
    return module.exports
  },
})