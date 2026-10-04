/**
 * Command Code provider for DeepSeek Harness — a faithful port of
 * pi-commandcode-provider onto the Harness LLM seam.
 *
 * Registers the single `commandcode` provider route on `ctx.llm` with:
 * - the Command Code `/alpha/generate` streaming protocol (same wire format,
 *   retry/timeout/abort semantics, and message conversion as the pi plugin),
 * - live model discovery from the Provider API with an offline cache,
 * - per-model reasoning metadata and image-input modalities,
 * - credential resolution through the Harness credential seam, the
 *   `COMMANDCODE_API_KEY` environment, or the Command Code auth files,
 * - a configurable-provider directory entry and model discovery so the web
 *   Models page can configure and interrogate the provider,
 * - `/commandcode-refresh`, `/commandcode-status`, and `/commandcode-setkey`
 *   commands.
 *
 * @module dsh-commandcode-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { CommandCodeAdapter } from './src/adapter.ts'
import { Config, resolveOptions } from './src/config.ts'
import type { ResolvedCommandCodeOptions } from './src/config.ts'
import { getApiKey } from './src/converters.ts'
import { PROVIDER, discoverModels } from './src/discovery.ts'
import { CommandCodeCatalog, formatCommandCodeStatus } from './src/runtime.ts'

export { CommandCodeAdapter } from './src/adapter.ts'
export type { CommandCodeAdapterOptions } from './src/adapter.ts'
export { Config } from './src/config.ts'
export type { CommandCodeModelProfile, ResolvedCommandCodeOptions } from './src/config.ts'
export { PROVIDER, discoverModels } from './src/discovery.ts'
export { CommandCodeCatalog, formatCommandCodeStatus, redactDiagnosticText } from './src/runtime.ts'
export { toCommandCodeContext, toStreamChunks } from './src/adapter.ts'

export const name = 'commandcode-provider'
export const inject = ['llm']

// Settings namespace. The 0.2 seam derives a plugin's namespace from its
// profile entry id and no longer exports `settingsNamespace`; this constant is
// that same id, used as the model-discovery key and as the directory's
// `settingsNs`.
const NS = 'commandcode-provider'
const PKG = 'commandcode-provider'

/** Default catalog cache path under the Harness home. */
export function defaultModelsCachePath(): string {
  return join(resolveDshHome(), 'commandcode', 'commandcode-models.json')
}

/** Structural commands register (the dsh-commands service). */
interface CommandsLike {
  register(definition: {
    name: string
    description: string
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
  }): void
}

/** Structural user-questions ask (optional service; the setkey paste path). */
interface UserQuestionsLike {
  ask(request: {
    questions: { id: string; question: string; header?: string }[]
    agent?: unknown
    signal?: AbortSignal
  }): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }>
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedCommandCodeOptions | undefined
  const options = (): ResolvedCommandCodeOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveOptions(raw, launchEnvironmentOf(ctx), defaultModelsCachePath())
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('commandcode-provider: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  // Validate the composition entry immediately: an unserviceable entry fails
  // plugin load, exactly like llm-deepseek.
  options()

  const catalog = new CommandCodeCatalog(options(), {
    logWarning: (message: string) => ctx.logger.warn(message),
  })
  const catalogModels = (): ReturnType<CommandCodeCatalog['getModels']> => catalog.getModels()

  const resolveApiKey = async (connection: ResolvedCommandCodeOptions): Promise<string> => {
    // Credential seam first, then the trusted environment, then the Command
    // Code auth files — the same file support the pi plugin has.
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined ? await credentials.resolve(ref) : undefined
    if (hit !== undefined) return assertUsableApiKey(hit.value, PKG, ref)
    const ambient = launchEnvironmentOf(ctx).get(ref)
    if (ambient !== undefined && ambient.value.length > 0) {
      return assertUsableApiKey(ambient.value, PKG, ref)
    }
    const fileKey = getApiKey({ env: {} })
    if (fileKey !== undefined) return fileKey
    throw new LlmError(
      `commandcode-provider: no Command Code API key for provider route "${PROVIDER}"; open the web Models page (Settings → Models → Command Code → Edit) and paste the key,`
      + ` store ${ref} through the credentials service, run /commandcode-setkey, or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new CommandCodeAdapter({
    options,
    catalog: catalogModels,
    resolveApiKey,
    resolveAttachments: () => ctx.get('attachments'),
  })

  // The full directory is configurable from the moment the plugin mounts, so
  // the Models page can offer the route before any settings section exists.
  let directory: ReturnType<typeof ctx.llm.registerConfigurableProviders> | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const facts = [{ provider: PROVIDER, displayName: options().displayName, settingsNs: NS, settingsPath: [] }]
    if (deepEqualJson(facts, directoryFacts)) return
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(facts)
    } else {
      directory.replace(facts)
    }
    directoryFacts = facts
  }
  ensureDirectory()

  // Route effects bind to this apply fiber via the stable `ctx` reference.
  // The registry captures the retry policy at registration, so no in-place
  // refresh is needed: a settings change re-applies this plugin, and the fresh
  // registration below already carries the policy resolved from the new config.
  ctx.llm.registerAdapter([PROVIDER], adapter)

  // Model discovery for the Models page "fetch available models" action.
  ctx.llm.registerModelDiscovery(NS, (request) => discoverModels(request, catalogModels))

  // Catalog reconfigure + refresh when discovery facts (endpoint/cache/timeout)
  // change through settings.
  let lastDiscoveryFacts: unknown
  const ensureCatalogFacts = (): void => {
    const next = options()
    const facts = {
      modelsUrl: next.modelsUrl,
      modelsCachePath: next.modelsCachePath,
      modelsTimeoutMs: next.modelsTimeoutMs,
    }
    if (deepEqualJson(facts, lastDiscoveryFacts)) return
    catalog.reconfigure(next)
    lastDiscoveryFacts = facts
    void catalog.refresh()
  }
  ensureCatalogFacts()

  const setKeyHandler = async (invocation: CommandInvocation): Promise<CommandResult> => {
    const connection = options()
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      return {
        kind: 'error',
        text: 'commandcode-provider: no credentials service is mounted; export COMMANDCODE_API_KEY or configure ~/.commandcode/auth.json instead',
      }
    }
    const userQuestions = ctx.get('userQuestions') as UserQuestionsLike | undefined
    if (userQuestions === undefined) {
      return {
        kind: 'error',
        text: 'commandcode-provider: no interactive prompt is available; paste the key via the web Models page (Settings → Models → Command Code → Edit) or export COMMANDCODE_API_KEY',
      }
    }
    try {
      const answer = await userQuestions.ask({
        questions: [{ id: 'api-key', question: 'Paste your Command Code API key:', header: 'Command Code API key' }],
        agent: invocation.agent,
        signal: invocation.signal,
      })
      const item = answer.answers[0]
      const pasted = item?.custom ?? item?.selected[0]
      if (pasted === undefined || pasted.trim().length === 0) {
        return { kind: 'error', text: 'No Command Code API key provided' }
      }
      await credentials.set(connection.apiKeyEnv, pasted.trim())
      return {
        kind: 'success',
        text: 'Command Code API key stored through the credentials service.',
      }
    } catch (error: unknown) {
      return {
        kind: 'error',
        text: `Command Code key store failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  const commands = ctx.get('commands') as CommandsLike | undefined
  if (commands !== undefined) {
    commands.register({
      name: 'commandcode-refresh',
      description: 'Refresh the Command Code model catalog',
      handler: async () => {
        const result = await catalog.refresh()
        if (result.refreshed) {
          return {
            kind: 'success',
            text: `Command Code model catalog refreshed (${result.modelCount} models from ${result.source}).`,
          }
        }
        return {
          kind: 'error',
          text: `Command Code model catalog unchanged (${result.modelCount} models remain available).${result.warning ? ` ${result.warning}` : ''}`,
        }
      },
    })
    commands.register({
      name: 'commandcode-status',
      description: 'Show redacted Command Code provider diagnostics',
      handler: () => {
        const status = catalog.getStatus()
        return { kind: status.warning ? 'error' : 'success', text: formatCommandCodeStatus(status) }
      },
    })
    commands.register({
      name: 'commandcode-setkey',
      description: 'Store a Command Code API key through the credentials service',
      handler: setKeyHandler,
    })
  }

  // Settings wiring. The 0.2 seam no longer takes an imperative settings
  // section: `SettingsForms.describe()` derives the form from this module's
  // exported `Config` schema, so that export plus volatile fields (see
  // `src/config.ts`) is the whole registration.
  //
  // A settings change restarts this entry's fiber, so `ensureDirectory` and
  // `ensureCatalogFacts` above already re-run against the new values and no
  // change hook is needed here. `options()` at the top of this function keeps
  // validating the composition, so an unserviceable value still fails the
  // apply rather than being served.

  // Initial catalog load: live fetch with cached fallback; never fails boot.
  void catalog.refresh()
}
