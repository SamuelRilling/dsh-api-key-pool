// dsh-api-key-pool client: settings panel for API key rotation on LLM providers
// Designed & built by 小哲 (xiaozhe7772222) 🐧
window.__ModuleLoader__.load({
  id: 'dsh-api-key-pool',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useCallback, useEffect } = React

    function installStyles() {
      const css = document.createElement('style')
      css.textContent = `
        .akp-card { font-family: inherit; }
        .akp-desc { margin: 0 0 12px; font-size: 12px; opacity: .7; }
        .akp-prov { margin-bottom: 14px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2, #ddd); border-radius: 8px; }
        .akp-prov-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
        .akp-prov-name { font-weight: 600; font-size: 13px; }
        .akp-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 12px; }
        .akp-key-masked { flex: 1; font-family: monospace; font-size: 11px; }
        .akp-status { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .akp-status.healthy { background: #4caf50; }
        .akp-status.cooling { background: #ff9800; }
        .akp-x { cursor: pointer; opacity: .45; font-size: 10px; padding: 2px 4px; }
        .akp-x:hover { opacity: 1; }
        .akp-field { display: flex; gap: 6px; margin: 4px 0; }
        .akp-field input { flex: 1; min-width: 0; padding: 4px 8px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2, #ddd); border-radius: 4px; background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #333); }
        .akp-btn { padding: 4px 10px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2, #ddd); border-radius: 4px; background: var(--dsw-alias-interactive-bg, #f0f0f0); color: var(--dsw-alias-label-primary, #333); cursor: pointer; }
        .akp-btn.primary { background: var(--dsw-alias-state-business-primary, #1976d2); border-color: var(--dsw-alias-state-business-primary, #1976d2); color: #fff; }
        .akp-msg { font-size: 11px; margin-top: 6px; padding: 4px 8px; border-radius: 4px; }
        .akp-msg.ok { background: #e8f5e9; color: #2e7d32; }
        .akp-msg.err { background: #ffebee; color: #c62828; }
      `
      document.head.appendChild(css)
      return () => css.remove()
    }

    async function fetchJson(url, opts) {
      const r = await fetch(url, opts)
      return r.json()
    }

    function ApiKeyPoolCard() {
      const [state, setState] = useState({ llmProviders: [], pools: {}, loading: true, msg: null, addInputs: {} })

      const refresh = useCallback(async () => {
        const [provRes, poolRes] = await Promise.all([
          fetchJson('/dsh-api-key-pool/llm-providers'),
          fetchJson('/dsh-api-key-pool/pools'),
        ])
        setState((s) => ({ ...s, llmProviders: provRes.providers || [], pools: poolRes.pools || {}, loading: false }))
      }, [])

      useEffect(() => { refresh() }, [refresh])

      const showMsg = (t, text) => { setState((s) => ({ ...s, msg: { type: t, text } })); setTimeout(() => setState((s) => ({ ...s, msg: null })), 3000) }

      const handleAddKey = async (provider) => {
        const key = (state.addInputs[provider] || '').trim()
        if (!key) return
        if (!state.pools[provider]) {
          const r = await fetchJson('/dsh-api-key-pool/pools', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'addProvider', provider, key }) })
          if (!r.ok) { showMsg('err', r.error || '添加失败'); return }
        } else {
          const r = await fetchJson('/dsh-api-key-pool/pools', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', provider, key }) })
          if (!r.ok) { showMsg('err', r.error || '添加失败'); return }
        }
        showMsg('ok', 'Key 已添加'); refresh()
      }

      const handleRemoveKey = async (provider, key) => {
        await fetchJson('/dsh-api-key-pool/pools', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'remove', provider, key }) })
        refresh()
      }

      const handleReset = async (provider) => {
        await fetchJson('/dsh-api-key-pool/pools', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reset', provider }) })
        refresh()
      }

      const allProviders = [...new Set([...state.llmProviders, ...Object.keys(state.pools)])]

      return React.createElement('div', { className: 'akp-card' },
        React.createElement('h3', { style: { margin: '0 0 8px', fontSize: '14px', fontWeight: 600 } }, 'API Key 轮换池'),
        React.createElement('p', { className: 'akp-desc' }, '自动检测到 ' + state.llmProviders.join(', ') + '。每个厂商可添加多个 Key 自动轮换。'),

        allProviders.map((name) => {
          const pool = state.pools[name]
          const keys = pool ? (pool.maskedKeys || []) : []
          const states = pool ? (pool.states || {}) : {}
          const isLlm = state.llmProviders.includes(name)
          return React.createElement('div', { key: name, className: 'akp-prov' },
            React.createElement('div', { className: 'akp-prov-head' },
              React.createElement('div', null,
                React.createElement('span', { className: 'akp-prov-name' }, name),
                isLlm && React.createElement('span', { style: { fontSize: '10px', opacity: .5, marginLeft: '6px' } }, '（对话模型）')),
              null),
            keys.length > 0 && keys.map((masked, i) => {
              const st = states[masked] || { failCount: 0, cooldownUntil: 0 }
              const cooling = st.cooldownUntil > Date.now()
              return React.createElement('div', { key: i, className: 'akp-row' },
                React.createElement('span', { className: `akp-status ${cooling ? 'cooling' : 'healthy'}` }),
                React.createElement('span', { className: 'akp-key-masked' }, masked),
                React.createElement('span', { style: { fontSize: '10px', opacity: .5 } },
                  cooling ? `冷却至 ${new Date(st.cooldownUntil).toLocaleTimeString()}` : st.failCount > 0 ? `失败 ${st.failCount} 次` : '健康'),
                React.createElement('button', { className: 'akp-x', onClick: () => handleRemoveKey(name, pool.keys[i]) }, '✕'))
            }),
            keys.length === 0 && React.createElement('p', { style: { fontSize: '11px', opacity: .5 } }, '暂无 Key'),
            React.createElement('div', { className: 'akp-field' },
              React.createElement('input', { placeholder: '粘贴 API Key…', value: state.addInputs[name] || '', onChange: (e) => setState((s) => ({ ...s, addInputs: { ...s.addInputs, [name]: e.target.value } })), onKeyDown: (e) => { if (e.key === 'Enter') handleAddKey(name) } }),
              React.createElement('button', { className: 'akp-btn primary', onClick: () => handleAddKey(name), disabled: !(state.addInputs[name] || '').trim() }, '添加')),
            React.createElement('button', { className: 'akp-btn', onClick: () => handleReset(name) }, '重置冷却'))
        }),

        state.msg && React.createElement('div', { className: `akp-msg ${state.msg.type}` }, state.msg.text))
    }

    function apply(ctx) {
      ctx.effect(installStyles, 'dsh-api-key-pool: styles')
      // settings.plugin.item is a KEYED slot: each card must declare the
      // settings namespace it edits as `key` (the loader fails loud without
      // it). The namespace `api-key-pool` is registered on the Host side in
      // lib/index.js, which is what makes this card appear in the
      // Settings → Plugins tab. `id`/`order`/`label` are not valid options for
      // a keyed slot (they belong to the `settings.section` list slot), so they
      // are intentionally omitted.
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register({
          name: 'settings.plugin.item',
          key: 'api-key-pool',
          inject: () => ({}),
        }, ApiKeyPoolCard)
      })
    }

    exports.apply = apply
    exports.inject = ['settingsScope', 'slots']
    return module.exports
  },
})