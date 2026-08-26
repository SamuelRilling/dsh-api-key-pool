# Changelog

## [0.3.1] - 2026-08-26
### Fixed
- **Web 设置卡片导致 DSH 启动崩溃（关键修复）**：`lib/client.js` 把卡片注册进 `settings.plugin.item` 槽位时，
  漏掉了该 keyed 槽位必需的 `options.key`，DSH 加载器因此报 `keyed slot "settings.plugin.item" requires options.key`
  并中止插件加载。现在补上 `key: 'api-key-pool'`，同时移除 `id` / `order` / `label` —— 这些属于
  `settings.section` 列表槽位，对 keyed 槽位无效。
- **设置卡片之前不会显示**：`settings.plugin.item` 标签页只渲染"宿主机已提供服务"的命名空间对应的卡片。
  插件此前从未在宿主机注册 `api-key-pool` 命名空间，导致即便补上 `key` 卡片也不会出现。
  现在在 `lib/index.js` 通过 `ctx.inject(['settings'])` 注册该命名空间（空 schema + 空 base 作为"已提供服务"标记，
  插件真实配置仍由自身 REST API 管理）。
### Changed
- 版本号从 0.3.0 升至 0.3.1

## [0.3.0] - 2026-08-17
### Fixed
- **agent/request 瀑布读取 provider 错误（关键修复）**：payload 中没有 provider 字段（只有 `{ turn, step, signal }`），
  原来直接 `payload?.provider` 永远为 undefined，导致 `pickKey` 永远拿不到正确 provider，key 从未被注入轮换。
  现在改为先调 `next()` 拿到 LlmCallConfig，从返回值中读取 provider。
- **agent/request-error 不触发重试（关键修复）**：原来只标记 key 失败后返回 `next()`，请求直接失败，
  虽然标记了但没轮换。现在返回 `{ kind: 'retry' }`，让 agent loop 重新发起请求，
  pickKey 会跳过冷却中的 key，真正实现换 key 重试。
- **429001 等原始 HTTP 子码无法识别**：商汤等供应商返回 `429001` 而非 `RATE_LIMIT`，
  原来只认 pi-ai 分类错误码，导致限流不被识别。现在改为宁多勿漏：
  任何 4xx/5xx 状态码，或消息含 rate/limit/quota/exhaust/timeout/auth 等关键词，均判定为可重试。
### Changed
- 错误匹配策略从「白名单匹配」升级为「宁多勿漏」：任何 4xx/5xx 状态码或消息中限流关键词都触发轮换
- 版本号从 0.1.0 直接升级到 0.3.0（跳过 0.2.0 以对齐实际发布）

## [0.2.0] - 2026-08-15
### Fixed
- Key 选晚了：原来选 Key 的时机在 agent/request 瀑布的 `next()` 之后，env 注入时请求已发出。
  现在先选 Key → 设 env → 再请求（正确的瀑布顺序）。
- 429 没被识别：错误码匹配从 HTTP 状态码改为 pi-ai 分类错误码（RATE_LIMIT/AUTH/QUOTA_EXCEEDED 等）。
- 冷却期满 failCount 不归零：冷却结束自动清零，下次退避从 1x 重新开始。
- 并发下 env 变量覆盖：每个 provider 独立 Promise 链串行锁，防止 process.env 竞争。
### Added
- 自动探测 settings.yaml 中的 provider 并创建空池（无需手动配置）
- 从 process.env 自动导入已有 key（延续现有凭据）

[0.1.0] - 2026-08-15

### Added
- Initial release of dsh-api-key-pool
- Multi-key round-robin rotation per provider via `agent/request` waterfall
- Automatic failover on `401/403/429` errors via `agent/request-error` waterfall
- Exponential backoff cooldown (default 30s) with automatic recovery
- Web UI management panel (Settings → Plugins → API Key Pool)
  - View key health status (green = healthy, orange = cooling)
  - Add/remove keys at runtime
  - Reset cooldown states
- REST API endpoints: `GET /dsh-api-key-pool/pools`, `POST /dsh-api-key-pool/pools`
- Key masking in API responses (never exposes full keys)
- Runtime persistence via `pool-config.json` (survives restarts)
- Configuration via `cordis.patch.yml` (static) or Web UI (runtime)
- Peer dependencies: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/schemastery`