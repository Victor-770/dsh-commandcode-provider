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
// Type-only import: brings the loader's `loader/volatile-update` event into the
// cordis `Events` map this fiber listens on.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { CommandCodeAdapter } from './src/adapter.ts'
import { plainConfig, resolveOptions } from './src/config.ts'
import type { Config, ResolvedCommandCodeOptions } from './src/config.ts'
import { getApiKey } from './src/converters.ts'
import { PROVIDER, discoverModels } from './src/discovery.ts'
import { CommandCodeCatalog, formatCommandCodeStatus } from './src/runtime.ts'

export { CommandCodeAdapter } from './src/adapter.ts'
export type { CommandCodeAdapterOptions } from './src/adapter.ts'
export { Config } from './src/config.ts'
export type { CommandCodeModelProfile, Options, ResolvedCommandCodeOptions } from './src/config.ts'
export { PROVIDER, discoverModels } from './src/discovery.ts'
export { CommandCodeCatalog, formatCommandCodeStatus, redactDiagnosticText } from './src/runtime.ts'
export { toCommandCodeContext, toStreamChunks } from './src/adapter.ts'

export const name = 'commandcode-provider'
export const inject = ['llm']

// Settings namespace. The 0.2 seam no longer exports `settingsNamespace`: a
// plugin's namespace is its profile entry id, which the bundled
// `cordis.patch.yml` fixes as this constant. Both the model-discovery
// registration and the directory's `settingsNs` must name it exactly, so an
// install that inserts the plugin under any other id (a hand-written patch, or
// a nested include that prefixes ids) needs this constant changed with it.
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
  let lastGood: ResolvedCommandCodeOptions | undefined
  // Every read goes through the live references: a settings change is committed
  // *into* them, so the config object keeps its identity while its values move.
  // A memo keyed on that identity (or on any captured snapshot) would keep
  // serving the value the plugin started with.
  const options = (): ResolvedCommandCodeOptions => {
    try {
      const next = resolveOptions(plainConfig(config), launchEnvironmentOf(ctx), defaultModelsCachePath())
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound: keep
      // serving the last good facts and say so on every refused snapshot.
      if (lastGood === undefined) throw error
      ctx.logger.error('commandcode-provider: keeping the last good configuration after an invalid settings snapshot')
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
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  // The registry captures the retry policy at registration, so it is the one
  // fact per-request resolution cannot refresh. `replace` re-reads it in one
  // synchronous registry section: disposing and re-registering instead would
  // publish an empty route set between the two.
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

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

  // Settings wiring. The 0.2 seam takes no imperative settings section: the
  // settings service derives the form from this module's exported `Config`
  // schema, and that schema marks every field `.volatile()` so the form surfaces
  // it (see `src/config.ts`).
  //
  // Because the whole schema is volatile, an edit is a *volatile-only* change:
  // `@deepseek-ai/cordis-plugin-loader` commits the new values into this fiber's
  // live references and emits `loader/volatile-update` instead of remounting the
  // entry, so `apply` never runs a second time and nothing above re-registers by
  // itself. `options()` reads the references afresh, and this hook re-derives
  // every fact that was captured at registration. Each `ensure*` is contained so
  // one failure cannot wedge the others.
  ctx.on('loader/volatile-update', () => {
    const refreshments: [label: string, ensure: () => void][] = [
      ['route registration', ensureRegistrationFacts],
      ['catalog facts', ensureCatalogFacts],
      ['configurable-provider directory', ensureDirectory],
    ]
    for (const [label, ensure] of refreshments) {
      try {
        ensure()
      } catch (error) {
        ctx.logger.error(`commandcode-provider: keeping the previous ${label} after a refused update`)
        ctx.logger.error(error)
      }
    }
  })

  // Initial catalog load: live fetch with cached fallback; never fails boot.
  void catalog.refresh()
}
