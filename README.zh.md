# dsh-commandcode-provider

**语言：** [English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的自定义 LLM 提供方插件，将 dsh 接入 [Command Code](https://commandcode.ai) —— 是 [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider) 在 dsh LLM 接缝上的忠实移植。

> **适配 Command Code 全部套餐，包括 $1/月的 Go 套餐。** 即使是唯一没有 Provider API 访问权限的 Go 套餐，Studio 里也给你一个 API key；这个 key 用于 CLI/agent 的鉴权登录。本插件用这个 key 走 Command Code 自己的 `/alpha/generate` 接口，**不是传统的 Provider API 协议**，所以即使套餐没有 Provider API 权限也能用。

> **免责声明：** 这是非官方、社区维护的集成，与 Command Code 无隶属、背书或支持关系。你需要自己的 Command Code 账号。Command Code 的条款、可用性和定价适用。

> **需要 dsh 0.2.0-rc.2 或更高版本。** 本版本面向 0.2 的 LLM 与设置接缝，在更老的 dsh 上条目无法加载。在 **设置 → 模型 → Command Code → 编辑** 中修改的配置会即时生效，无需重启 dsh。

## 快速开始

**小白友好：安装只要一条命令，插件会自动挂载，不用改任何配置文件。**

### 1. 安装插件

```sh
dsh plugin --profile web add dsh-commandcode-provider@0.2.0
```

包声明了 `dsh.bundle`，所以 `dsh plugin add` 安装的同时会自动把它加入 profile 的 bundle 层——自带的 `cordis.patch.yml` 会替你挂好 provider 行。

> 不要再手动加一条 `cordis.patch.yml` 行——bundle patch 已经挂载了，再加一条会重复注册。

### 2. 重启 dsh

重启后，提供方会自动出现在 Web UI 里。

### 3. 获取 API key

**Go 套餐同样有 API key**，它是用来鉴权登录的：

1. 打开 [commandcode.ai](https://commandcode.ai) 并登录
2. 侧边栏进入 **Studio → API Keys**
3. 点击 **Generate API key** 按钮，复制生成的 key

> 这个 key 是使用 Command Code 的**鉴权 key**，不是"Provider API" key。插件用它走 Command Code 自己的 `/alpha/generate` 协议，**不需要 Provider API 权限，Go 套餐也能用**。

### 4. 配置 API key（二选一）

**聊天命令：** 在 dsh 聊天里输入：

```
/commandcode-setkey
```

按提示粘贴 key 即可。

完成！在模型选择器里挑一个 Command Code 模型，开始对话。

## 工作原理

本插件**不是**传统的 API 协议提供方：

- 它走 Command Code 官方的流式接口 `https://api.commandcode.ai/alpha/generate`，使用与官方 CLI 相同的线协议（`x-command-code-version`、`x-cli-environment`、`x-project-slug` 等请求头）。
- Studio 里的 API key 是这个接口的**鉴权凭证**——和 `cmd login` 写入 `~/.commandcode/auth.json` 的是同一个 key。
- 因为走的是 CLI 协议而不是 Provider API，所以**所有套餐（包括 Go）都能用**，甚至 Provider API 不提供的模型也能用。
- 模型发现仍会从公开的 Provider API 目录接口拉取（可访问时），并缓存到 `<dsh home>/commandcode/commandcode-models.json`；如果该接口不可达（比如 Go 套餐），最后一次缓存的目录继续生效。

## 功能

pi 插件能做的，在 dsh 宿主层全部实现：

- **提供方注册** —— 在 `ctx.llm` 上注册 `commandcode` 路由，与 pi 插件相同的 `/alpha/generate` 流式协议、重试/超时/中止语义和消息/工具转换（成对工具调用过滤、data-URL 图片转发、旧 schema 归一化）。
- **模型发现 + 离线缓存** —— 从 `https://api.commandcode.ai/provider/v1/models` 拉取目录并本地缓存（带版本、原子写入）；离线时最后一次缓存继续生效。
- **推理元数据** —— 已知支持 effort 的模型通过 LLM 接缝公布思考档位；所选档位以 `params.reasoning_effort` 发送。
- **图片输入** —— 目录中标为 `image` 的模型接受图片块（通过 dsh 的持久附件服务解析）；纯文本模型在任何网络请求前拒绝图片。
- **鉴权** —— 每次请求按以下顺序解析凭证：
  1. Harness 凭证接缝（`ctx.credentials`，Web Models 页写入的）
  2. 受信任的启动环境（`COMMANDCODE_API_KEY`）
  3. 已有 Command Code 认证文件：`~/.commandcode/auth.json`、`~/.pi/agent/auth.json`、`~/.omp/agent/auth.json`

  没有浏览器 OAuth 流程——key 在 Web UI（**设置 → 模型 → Command Code → 编辑**）或 `/commandcode-setkey` 里填写。
- **命令** —— `/commandcode-refresh`（重新拉取并注册目录）、`/commandcode-status`（脱敏诊断信息）、`/commandcode-setkey`（存储 API key）。
- **价格展示** —— 沿用 pi 插件的静态每模型成本表（美元/百万 token）。
- **错误卫生** —— 上下文溢出措辞归一化为 `CONTEXT_WINDOW_EXCEEDED`，所有错误/诊断文本脱敏。

## 配置

`commandcode-provider` 设置段接受以下字段（全部可选）：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `apiKeyEnv` | `COMMANDCODE_API_KEY` | 每次请求解析的凭证引用 |
| `displayName` | `Command Code` | 选择器里显示的名称 |
| `baseURL` | `COMMANDCODE_API_BASE` 环境变量 → `https://api.commandcode.ai` | `/alpha/generate` 的 API 地址（通常保持默认） |
| `modelsUrl` | `COMMANDCODE_MODELS_URL` 环境变量 → Provider API | 模型发现接口 |
| `modelsTimeoutMs` | `COMMANDCODE_MODELS_TIMEOUT_MS` 环境变量 → `10000` | 发现超时 |
| `modelsCachePath` | `COMMANDCODE_MODELS_CACHE` 环境变量 → `<dsh home>/commandcode/commandcode-models.json` | 目录缓存路径 |
| `models` | — | 可选显式目录条目；按 id 覆盖（或新增）发现的模型 |
| `defaultContextWindow` | `262144` | 目录和覆盖都没有的模型的上下文容量 |
| `defaultMaxTokens` | `32768` | 目录和覆盖都没有的模型的输出能力 |
| `timeoutMs` | — | 每次尝试的 HTTP 请求超时 |
| `streamIdleTimeoutMs` | `300000` | 一次流读取在途时的最大空闲时间 |
| `retryPolicy` | 常规默认 | 提供方自有的模型请求重试策略 |

```yaml
# $DSH_HOME/settings.yaml
commandcode-provider:
  apiKeyEnv: COMMANDCODE_API_KEY   # Models 页写入的凭证引用
```

## 更新日志

### 0.2.0

- **适配 dsh 0.2.0-rc.2 接缝**：`ToolCallId`、一等 `role: 'tool'` 工具结果消息、`JsonObject` 工具参数，以及取代 `installSettingsSection` 的 schema 派生设置表单。
- **设置即时生效**：每个配置字段都是实时引用（`Volatile`），插件每次使用时重新读取，并在 `loader/volatile-update` 时刷新 provider 路由、模型目录和 Models 页目录项。
- **锁定接缝版本**：dev/peer 范围对齐所面向的 dsh 版本，之后的接缝漂移会在安装期报错，而不是静默不加载。
- 测试与 typecheck 直接解析已发布的接缝包，不再依赖本地 deepseek-harness 检出。

### 0.1.2

- **移除浏览器 OAuth 流程**（以及本地回调服务器）：不再有 `/commandcode-login`，不再弹浏览器。API key 直接在 **设置 → 模型 → Command Code → 编辑**（单一 API key 字段）或 `/commandcode-setkey` 填写。
- Models 页的 Command Code 卡片只显示 **API key** 字段；无需配置 API 地址。

### 0.1.0 / 0.1.1

- `pi-commandcode-provider` 的初始移植：`/alpha/generate` 流式、模型发现 + 缓存、推理档位、图片输入、价格展示。

## 开发

```sh
npm install        # 开发 + 测试依赖
npm run typecheck  # 针对 harness 接缝包的严格 tsc
npm run build      # 产出 lib/（ESM + 类型声明）
npm test           # vitest 套件（线协议、发现、成本、适配器、插件入口）
```

typecheck 和 vitest 从 `node_modules` 解析 `@deepseek-ai/*` 接缝包，版本在 `package.json` 中锁定到本插件所面向的 dsh 版本——即宿主实际加载的同一套已发布 API，无需本地 harness 检出。

## License

MIT

---

**English:** [README.md](README.md)
