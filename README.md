# dsh-commandcode-provider

**Languages:** English | [中文](README.zh.md)

A custom LLM provider plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) that connects dsh to [Command Code](https://commandcode.ai) — a faithful port of [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider) onto dsh's LLM seam.

> **Works with every Command Code plan, including the $1/month Go plan.** Even the Go plan — the only one without Provider API access — gives you an API key in the Studio; that key authenticates the CLI/agent login. This plugin uses that same key against Command Code's own `/alpha/generate` endpoint, **not** the traditional Provider API protocol, so it works even when a plan has no Provider API access.

> **Disclaimer:** This is an unofficial, community-maintained integration. It is not affiliated with, endorsed by, or supported by Command Code. You need your own Command Code account. Command Code's terms, availability, and pricing apply.

> **Requires dsh 0.2.0-rc.2 or newer.** This release targets the 0.2 LLM and settings seam; on an older dsh the entry will not load. Settings edited on **Settings → Models → Command Code → Edit** apply live — no dsh restart.

## Quick Start

**Newbie-friendly: one command to install — the plugin mounts itself, no config files to edit.**

### 1. Install

```sh
dsh plugin --profile web add dsh-commandcode-provider@0.2.0
```

The package declares `dsh.bundle`, so `dsh plugin add` installs it AND automatically joins it to the profile's bundle layers — the shipped `cordis.patch.yml` mounts the provider row for you.

> Do **not** also add a manual `cordis.patch.yml` row for this plugin — the bundle patch already mounts it; a second row would double-register the provider.

### 2. Restart dsh

The provider then appears in the web UI automatically.

### 3. Get your API key

Even on the **Go plan**, Command Code gives you an API key used for authentication:

1. Open [commandcode.ai](https://commandcode.ai) and sign in.
2. Go to **Studio → API Keys** (in the sidebar).
3. Click **Generate API key** and copy it.

> This key is an *authentication* key for using Command Code — it is not a "Provider API" key. The plugin speaks Command Code's own `/alpha/generate` protocol with it, so **no Provider API access is required**, and the Go plan works.

### 4. Configure the API key (either way)

** Command:** In a dsh chat, run:

```
/commandcode-setkey
```

and paste the key when prompted.

That's it — pick a Command Code model from the model picker and start chatting.

## How it works

This plugin is **not** a traditional API-protocol provider:

- It talks to Command Code's own streaming endpoint `https://api.commandcode.ai/alpha/generate` with the same wire protocol the official CLI uses (`x-command-code-version`, `x-cli-environment`, `x-project-slug`, … headers).
- The API key from Studio is an **authentication** credential for that endpoint — the same one `cmd login` writes to `~/.commandcode/auth.json`.
- Because it rides the CLI protocol instead of the Provider API, it works on **every plan, including Go**, and even models the Provider API cannot serve.
- Model discovery still uses the public Provider API catalog endpoint when reachable, with an offline cache at `<dsh home>/commandcode/commandcode-models.json`; if that endpoint is unreachable (e.g. a Go plan), the last cached catalog keeps serving.

## Functionality

Everything the pi plugin does, on the dsh host plane:

- **Provider registration** — registers the `commandcode` provider route on `ctx.llm` with the same `/alpha/generate` streaming protocol, retry/timeout/abort semantics, and message/tool conversion as the pi plugin (paired tool-call filtering, data-URL image forwarding, legacy schema normalization).
- **Model discovery with offline cache** — fetches the catalog from `https://api.commandcode.ai/provider/v1/models` and caches it locally (versioned, atomic writes); offline, the last cached catalog keeps serving.
- **Reasoning metadata** — models with known Command Code effort support advertise their thinking levels through the LLM seam; a selected level is sent as `params.reasoning_effort`.
- **Image input** — models marked `image` in the catalog accept image blocks (resolved through dsh's durable attachment service); text-only models reject images before any network request.
- **Authentication** — credentials resolve per request through, in order:
  1. the Harness credential seam (`ctx.credentials`, what the web Models page writes),
  2. the trusted launch environment (`COMMANDCODE_API_KEY`),
  3. existing Command Code auth files: `~/.commandcode/auth.json`, `~/.pi/agent/auth.json`, `~/.omp/agent/auth.json`.

  No browser OAuth flow — the key is entered in the web UI (**Settings → Models → Command Code → Edit**) or via `/commandcode-setkey`.
- **Commands** — `/commandcode-refresh` (re-fetch + re-register the catalog), `/commandcode-status` (redacted diagnostics), `/commandcode-setkey` (store an API key).
- **Pricing display** — the static per-model cost table from the pi plugin (USD per million tokens).
- **Error hygiene** — context-overflow wording is normalized to `CONTEXT_WINDOW_EXCEEDED`, and every error/diagnostic text is redacted.

## Configuration

The `commandcode-provider` settings section accepts (all optional):

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKeyEnv` | `COMMANDCODE_API_KEY` | Credential reference resolved per request |
| `displayName` | `Command Code` | Name shown by selectors |
| `baseURL` | `COMMANDCODE_API_BASE` env → `https://api.commandcode.ai` | API base for `/alpha/generate` (usually leave at default) |
| `modelsUrl` | `COMMANDCODE_MODELS_URL` env → Provider API | Model discovery endpoint |
| `modelsTimeoutMs` | `COMMANDCODE_MODELS_TIMEOUT_MS` env → `10000` | Discovery timeout |
| `modelsCachePath` | `COMMANDCODE_MODELS_CACHE` env → `<dsh home>/commandcode/commandcode-models.json` | Catalog cache path |
| `models` | — | Optional explicit catalog entries; each overrides (or adds to) the discovered model by id |
| `defaultContextWindow` | `262144` | Context capacity for models neither the catalog nor an override sizes |
| `defaultMaxTokens` | `32768` | Output capability for models neither the catalog nor an override sizes |
| `timeoutMs` | — | Per-attempt HTTP request timeout |
| `streamIdleTimeoutMs` | `300000` | Max idle time while one stream read is outstanding |
| `retryPolicy` | normal defaults | Provider-owned model-request retry policy |

```yaml
# $DSH_HOME/settings.yaml
commandcode-provider:
  apiKeyEnv: COMMANDCODE_API_KEY   # credential reference the Models page writes
```

## Changelog

### 0.2.0

- **Adapted to the dsh 0.2.0-rc.2 seam**: `ToolCallId`, first-class `role: 'tool'` result messages, `JsonObject` tool arguments, and the schema-derived settings form that replaced `installSettingsSection`.
- **Settings edits apply live**: every config field is a live reference (`Volatile`), so the plugin re-reads settings per use and refreshes its provider route, catalog, and Models-page directory entry on `loader/volatile-update`.
- **Seam versions pinned** to the dsh release being targeted, so a future seam drift fails at install instead of silently not loading.
- Tests and typecheck resolve the published seam packages — no local deepseek-harness checkout required.

### 0.1.2

- **Removed the browser OAuth flow** (and the local callback server): no more `/commandcode-login`, no browser pop-up. The API key is entered directly in **Settings → Models → Command Code → Edit** (single API key field) or via `/commandcode-setkey`.
- Models-page card for Command Code shows only the **API key** field; no API address to configure.

### 0.1.0 / 0.1.1

- Initial port of `pi-commandcode-provider`: `/alpha/generate` streaming, model discovery + cache, reasoning efforts, image input, pricing display.

## Development

```sh
npm install        # dev + test dependencies
npm run typecheck  # strict tsc against the harness seam packages
npm run build      # emit lib/ (ESM + declarations)
npm test           # vitest suite (wire protocol, discovery, cost, adapter, plugin entry)
```

Typecheck and vitest resolve the `@deepseek-ai/*` seam packages from `node_modules`, pinned in `package.json` to the dsh release this plugin targets — the same published API surface the host loads, with no local harness checkout.

## License

MIT

---

**中文文档:** [README.zh.md](README.zh.md)
