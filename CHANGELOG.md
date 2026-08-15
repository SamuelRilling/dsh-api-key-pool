# Changelog

## [0.1.0] - 2026-08-15

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