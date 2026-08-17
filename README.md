<div align="center">

# dsh-api-key-pool

**API Key 轮换池插件 · API Key Rotation Pool Plugin for DeepSeek Harness (DSH)**

> 🐧 **Designed & built by 小哲** ([@xiaozhe7772222](https://github.com/xiaozhe7772222))

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.0--rc.6-blue.svg)](https://www.npmjs.com/package/@deepseek-ai/dsh)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-green.svg)](https://nodejs.org)
[![Author](https://img.shields.io/badge/Author-小哲-blue)](https://github.com/xiaozhe7772222)

多 Key 自动轮换 · 失败自动切换 · 冷却恢复 · Web 管理面板

Multi-key round-robin · Automatic failover · Cooldown & recovery · Web UI panel

</div>

---

**English** | [中文](#中文文档)

---

## English

### ✨ Features

| Feature | Description |
|---|---|
| 🔄 **Round-robin rotation** | Multiple keys per provider, rotated per request for load balancing |
| 🛡️ **Automatic failover** | Key fails with `401 / 403 / 429` → automatically marked unhealthy, next key takes over |
| ⏱️ **Cooldown & recovery** | Failed keys enter exponential-backoff cooldown (30s default), auto back in rotation when expired |
| 🌐 **Web management panel** | DSH Web UI → Settings → Plugins → **API Key Pool**: add/remove keys, view health, reset cooldowns |
| 🔒 **Key masking** | REST API only exposes masked keys (`sk-abc****1234`), never full secrets |
| 💾 **Persistent config** | Keys added via Web UI persist to `pool-config.json`, survive restarts |

### 📦 Installation

```bash
# Clone the repo
git clone https://github.com/xiaozhe7772222/dsh-api-key-pool.git
cd dsh-api-key-pool

# Copy into your DSH profile's plugins directory
mkdir -p ~/.dsh/profiles/web/plugins/dsh-api-key-pool
cp -r lib package.json cordis.patch.yml ~/.dsh/profiles/web/plugins/dsh-api-key-pool/
```

Then declare the bundle in `~/.dsh/profiles/web/package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        {
          "name": "dsh-api-key-pool",
          "platform": ["web"],
          "optional": false
        }
      ]
    }
  }
}
```

Restart DSH:

```bash
npx @deepseek-ai/dsh web
```

### ⚙️ Configuration

#### Option 1: Static config via `cordis.patch.yml`

```yaml
- insert:
    - id: api-key-pool
      name: dsh-api-key-pool
      inject: [llm, webServer]
      config:
        pools:
          provider-a:
            apiKeyEnv: PROVIDER_A_API_KEY
            keys:
              - sk-your-first-key
              - sk-your-second-key
              - sk-your-third-key
            cooldownMs: 30000
          provider-b:
            apiKeyEnv: PROVIDER_B_API_KEY
            keys:
              - sk-key2-1
              - sk-key2-2
            cooldownMs: 60000
        defaultCooldownMs: 30000
```

| Field | Type | Description |
|---|---|---|
| `pools.<provider>.apiKeyEnv` | string | Env var name for this provider's API key (must match `apiKeyEnv` in `settings.yaml`) |
| `pools.<provider>.keys` | string[] | List of API keys to rotate |
| `pools.<provider>.cooldownMs` | number | Cooldown per key after failure (ms) |
| `defaultCooldownMs` | number | Global default cooldown (ms), default `30000` |

#### Option 2: Web management panel (runtime)

After starting DSH, open **Settings → Plugins → API Key Pool**:
- View each provider's key health (green = healthy, orange = cooling)
- Paste a new key and click **Add**
- Click `✕` to remove a key
- Click **Reset cooldown** to clear cooling state for a provider
- Click **Refresh** to reload status

Keys added via the panel persist to `pool-config.json` automatically.

### 🧠 How it works (v0.3.0)
```
LLM request
   │
   ▼
┌──────────────────────────────────────────────────┐
│  agent/request waterfall (this plugin v0.3.0)      │
│  v0.3.0 fix #1: event payload has NO provider      │
│  → call next() first, read provider from the       │
│    returned LlmCallConfig                          │
│  ┌──────────────────────────────────────────────┐ │
│  │ 1. pickKey(provider) — round-robin healthy key│ │
│  │ 2. inject process.env[apiKeyEnv]             │ │
│  │ 3. credentials resolve env first → takes effect│ │
│  └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
   │
   ▼
Provider API call
   │
   ├── Success → markSuccess (reset failCount)
   │
   └── Fail 429 (e.g. SenseNova 429001) / 401 / 403 / 5xx ...
        │
        ▼
┌──────────────────────────────────────────────────┐
│  agent/request-error waterfall (this plugin)      │
│  v0.3.0 fix #2: no-error-left-behind             │
│    ANY 4xx/5xx status, or message containing      │
│    rate/limit/quota/exhaust/timeout/auth → retry  │
│  v0.3.0 fix #3: return { kind: 'retry' }          │
│    agent loop re-issues the request (not just     │
│    mark-failed-and-quit)                          │
│  ┌──────────────────────────────────────────────┐ │
│  │ 1. markFailed(currentKey) → cooldown         │ │
│  │ 2. return { kind: 'retry' }                  │ │
│  └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
   │
   ▼  agent loop retries → agent/request again
   pickKey skips the cooling key → picks next key
   │
   ├── key2 again 429 → cooldown → retry → key3 → OK ✅
   │
   └── all keys cooling → keeps retrying (wait for cooldown)
```
**Key design**: DSH resolves credentials in the order `process.env > .credentials.yaml > .env`. This plugin leverages that — it temporarily rewrites `process.env` in the `agent/request` waterfall for **hot key switching with zero config file changes**. Since v0.3.0, a failed key not only enters cooldown but also asks the agent loop to **retry with the next key immediately** (previously it only marked the key and the request died).
### 🔌 REST API

The plugin registers routes on the DSH web server.

#### `GET /dsh-api-key-pool/pools`

Returns all pools with masked keys, health states, and env names:

```json
{
  "pools": {
    "provider-a": {
      "apiKeyEnv": "PROVIDER_A_API_KEY",
      "keys": ["sk-your-first-key"],
      "maskedKeys": ["sk-you****-key"],
      "states": {
        "sk-you****-key": { "failCount": 0, "cooldownUntil": 0 }
      }
    }
  },
  "defaultCooldownMs": 30000
}
```

#### `POST /dsh-api-key-pool/pools`

| action | body | Description |
|---|---|---|
| `add` | `{ action, provider, key }` | Add a key |
| `remove` | `{ action, provider, key }` | Remove a key |
| `update` | `{ action, provider, keys: [] }` | Replace the full key list |
| `reset` | `{ action, provider }` | Reset all cooldown states for a provider |

Example:

```bash
curl -X POST http://127.0.0.1:3080/dsh-api-key-pool/pools \
  -H 'Content-Type: application/json' \
  -d '{"action":"add","provider":"provider-a","key":"sk-new-key"}'
```

### 🗂️ Project structure

```
dsh-api-key-pool/
├── package.json          # Package metadata + DSH bundle declaration
├── cordis.patch.yml      # Static pool config (first-install example)
├── pool-config.json      # Runtime persistence (written by Web UI, gitignored)
├── lib/
│   ├── index.js          # Server: rotation logic + agent waterfalls + REST API
│   └── client.js         # Client: Web settings panel card
├── README.md
├── CHANGELOG.md
└── LICENSE
```

### 🏷️ Topics

`deepseek-harness` · `dsh` · `api-key` · `api-key-rotation` · `key-pool` · `failover` · `load-balancing` · `round-robin` · `circuit-breaker` · `llm` · `openai` · `plugin` · `cordis`

### 📄 License

MIT License — free to use, modify, distribute. **Never commit your real API keys to a public repo.**

---

## 中文文档

> 🚀 **解决在 DeepSeek Harness 框架上面使用中转站模型或者第三方模型限流问题**

### ✨ 功能特性

| 功能 | 说明 |
|---|---|
| 🔄 **自动轮换** | 同一供应商配置多个 Key，请求时依次轮换，均衡负载 |
| 🛡️ **失败切换** | Key 返回 `401 / 403 / 429` 时自动标记故障，切换到下一个健康 Key |
| ⏱️ **冷却恢复** | 故障 Key 按指数退避进入冷却期（默认 30s 起步），到期自动回到轮换池 |
| 🌐 **Web 管理面板** | DSH Web UI → 设置 → 插件配置 → **API Key 池**：直接增删 Key、查看健康状态、重置冷却 |
| 🔒 **Key 脱敏** | REST 接口对外只返回脱敏后的 Key（`sk-abc****1234`），不泄露完整密钥 |
| 💾 **配置持久化** | Web 面板添加的 Key 持久化到 `pool-config.json`，重启后依然有效 |

### 📦 安装

```bash
# 克隆仓库
git clone https://github.com/xiaozhe7772222/dsh-api-key-pool.git
cd dsh-api-key-pool

# 拷贝到 DSH profile 的 plugins 目录
mkdir -p ~/.dsh/profiles/web/plugins/dsh-api-key-pool
cp -r lib package.json cordis.patch.yml ~/.dsh/profiles/web/plugins/dsh-api-key-pool/
```

然后在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 中声明：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        {
          "name": "dsh-api-key-pool",
          "platform": ["web"],
          "optional": false
        }
      ]
    }
  }
}
```

重启 DSH：

```bash
npx @deepseek-ai/dsh web
```

### ⚙️ 配置说明

#### 方式一：cordis.patch.yml（静态配置）

```yaml
- insert:
    - id: api-key-pool
      name: dsh-api-key-pool
      inject: [llm, webServer]
      config:
        pools:
          provider-a:
            apiKeyEnv: PROVIDER_A_API_KEY
            keys:
              - sk-your-first-key
              - sk-your-second-key
              - sk-your-third-key
            cooldownMs: 30000
          provider-b:
            apiKeyEnv: PROVIDER_B_API_KEY
            keys:
              - sk-key2-1
              - sk-key2-2
            cooldownMs: 60000
        defaultCooldownMs: 30000
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `pools.<provider>.apiKeyEnv` | string | 该供应商的 API Key 对应的环境变量名（需与 `settings.yaml` 中 `apiKeyEnv` 一致） |
| `pools.<provider>.keys` | string[] | 要轮换的多个 API Key |
| `pools.<provider>.cooldownMs` | number | 单个 Key 失败后的冷却时长（毫秒） |
| `defaultCooldownMs` | number | 全局默认冷却时长（毫秒），默认 `30000` |

#### 方式二：Web 管理面板（运行时）

启动 DSH 后，打开 **设置 → 插件配置 → API Key 池**：
- 查看各供应商 Key 健康状态（绿点 = 健康，橙点 = 冷却中）
- 输入框粘贴新 Key，点击「添加」
- 点击 `✕` 移除不想用的 Key
- 点击「重置冷却」清空某个供应商的冷却状态
- 点击「刷新」重新加载状态

Web 面板添加的 Key 会自动持久化到 `pool-config.json`，重启后依然有效。

### 🧠 工作原理（v0.3.0）
```
LLM 请求
   │
   ▼
┌──────────────────────────────────────────────────┐
│  agent/request 瀑布（本插件 v0.3.0）               │
│  v0.3.0 修复1：事件 payload 没有 provider 字段     │
│  → 先调 next()，从返回的 LlmCallConfig 里取 provider│
│  ┌──────────────────────────────────────────────┐ │
│  │ 1. pickKey(provider) 轮询选健康 Key           │ │
│  │ 2. 注入 process.env[apiKeyEnv]                │ │
│  │ 3. 凭据解析优先读 env → Key 立即生效          │ │
│  └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
   │
   ▼
供应商 API 调用
   │
   ├── 成功 → markSuccess（重置失败计数）
   │
   └── 失败 429（如商汤 429001）/ 401 / 403 / 5xx ...
        │
        ▼
┌──────────────────────────────────────────────────┐
│  agent/request-error 瀑布（本插件拦截）            │
│  v0.3.0 修复2：宁多勿漏                           │
│    任何 4xx/5xx 状态码，或消息含 rate/limit/quota/ │
│    exhaust/timeout/auth 等关键词 → 均判定可重试    │
│  v0.3.0 修复3：返回 { kind: 'retry' }              │
│    agent loop 收到后重新发起请求（不再直接退出！）  │
│  ┌──────────────────────────────────────────────┐ │
│  │ 1. markFailed(当前key) → 进入冷却             │ │
│  │ 2. return { kind: 'retry' }                  │ │
│  └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
   │
   ▼  agent loop 重试 → 再次进入 agent/request
   pickKey 跳过冷却中的 key → 选中下一个 key
   │
   ├── key2 也 429 → 标记冷却 → retry → key3 → 成功 ✅
   │
   └── 全部 key 冷却 → 继续重试（等冷却），日志预警
```
**关键设计**：DSH 的凭据解析优先级是 `process.env > .credentials.yaml > .env`，本插件利用这一机制，在 `agent/request` 瀑布中临时改写 `process.env`，实现**零配置文件改动的 Key 热切换**。v0.3.0 起，失败的 Key 不仅进入冷却，还会让 agent loop **立刻换下一个 Key 重试**（此前只是标记了故障但请求直接失败，等于白轮换）。
### 🔌 REST API

插件在 DSH webServer 上注册以下路由：

#### `GET /dsh-api-key-pool/pools`

返回所有池的 Key 列表（脱敏）、健康状态、环境变量名：

```json
{
  "pools": {
    "provider-a": {
      "apiKeyEnv": "PROVIDER_A_API_KEY",
      "keys": ["sk-your-first-key"],
      "maskedKeys": ["sk-you****-key"],
      "states": {
        "sk-you****-key": { "failCount": 0, "cooldownUntil": 0 }
      }
    }
  },
  "defaultCooldownMs": 30000
}
```

#### `POST /dsh-api-key-pool/pools`

| action | body | 说明 |
|---|---|---|
| `add` | `{ action, provider, key }` | 添加一个 Key |
| `remove` | `{ action, provider, key }` | 移除一个 Key |
| `update` | `{ action, provider, keys: [] }` | 整体替换 Key 列表 |
| `reset` | `{ action, provider }` | 重置该供应商全部冷却状态 |

示例：

```bash
curl -X POST http://127.0.0.1:3080/dsh-api-key-pool/pools \
  -H 'Content-Type: application/json' \
  -d '{"action":"add","provider":"provider-a","key":"sk-new-key"}'
```

### 🗂️ 项目结构

```
dsh-api-key-pool/
├── package.json          # 包元数据 + DSH bundle 声明
├── cordis.patch.yml      # 静态池配置（首次安装示例）
├── pool-config.json      # 运行时持久化（Web 面板写入，已 gitignore）
├── lib/
│   ├── index.js          # 服务端：轮换逻辑 + agent 瀑布 + REST API
│   └── client.js         # 客户端：Web 设置面板卡片
├── README.md
├── CHANGELOG.md
└── LICENSE
```

### 🏷️ 标签 (Topics)

`deepseek-harness` · `dsh` · `api-key` · `api-key-rotation` · `key-pool` · `failover` · `load-balancing` · `round-robin` · `circuit-breaker` · `llm` · `openai` · `plugin` · `cordis`

### 📄 许可证

MIT License — 自由使用、修改、分发。**请勿将你的真实 API Key 提交到公开仓库。**