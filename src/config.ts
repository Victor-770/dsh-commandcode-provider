/**
 * Configuration schema and validation for the Command Code provider.
 *
 * The plugin owns a single provider route (`commandcode`). Its settings
 * section doubles as the schema the web Models page renders, mirroring
 * llm-pi-ai / llm-deepseek conventions: `apiKeyEnv` names the credential
 * reference, every other field has a sensible default, and resolution is one
 * explicit step so an unserviceable section is refused where it is written.
 *
 * @module dsh-commandcode-provider/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { CommandCodeModel } from './models.ts'
import {
  DEFAULT_MODELS_TIMEOUT_MS,
  DEFAULT_MODELS_URL,
} from './models.ts'

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Context capacity assumed for a model neither configuration nor the catalog sizes. */
export const DEFAULT_CONTEXT_WINDOW = 262_144

/** Output capability assumed for a model neither configuration nor the catalog sizes. */
export const DEFAULT_MAX_TOKENS = 32_768

/** Default credential reference the Models page writes and requests resolve. */
export const DEFAULT_API_KEY_ENV = 'COMMANDCODE_API_KEY'

/** Default display name shown by selectors and configuration surfaces. */
export const DEFAULT_DISPLAY_NAME = 'Command Code'

/** Default Command Code API base. */
export const DEFAULT_API_BASE = 'https://api.commandcode.ai'

/** Environment variables honored for endpoint, discovery, and cache facts. */
export const API_BASE_ENV = 'COMMANDCODE_API_BASE'
export const MODELS_URL_ENV = 'COMMANDCODE_MODELS_URL'
export const MODELS_TIMEOUT_ENV = 'COMMANDCODE_MODELS_TIMEOUT_MS'
export const MODELS_CACHE_ENV = 'COMMANDCODE_MODELS_CACHE'

/** One optional explicit catalog entry overriding the discovered model of the same id. */
export interface CommandCodeModelProfile {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

/**
 * Plugin config as the host hands it to `apply`: the parsed schema's own output,
 * where every declared field is a live reference owned by the loader.
 *
 * A settings-only change is committed into these references *in place* and
 * reported to this fiber as `loader/volatile-update`; the entry is not
 * remounted and `apply` does not run again. A field is therefore read with
 * `.get()` at the point of use (see {@link plainConfig}), never captured into a
 * longer-lived snapshot.
 */
export interface Config {
  /** Credential reference (environment-variable name) resolved per request; defaults to `COMMANDCODE_API_KEY`. */
  apiKeyEnv: Volatile<string>
  /** Name shown by selectors and configuration surfaces; defaults to `Command Code`. */
  displayName: Volatile<string | undefined>
  /** Endpoint base; falls back to `$COMMANDCODE_API_BASE`, then `https://api.commandcode.ai`. */
  baseURL: Volatile<string | undefined>
  /** Model discovery endpoint; falls back to `$COMMANDCODE_MODELS_URL`, then the Provider API. */
  modelsUrl: Volatile<string | undefined>
  /** Model discovery timeout in ms; falls back to `$COMMANDCODE_MODELS_TIMEOUT_MS`, then 10s. */
  modelsTimeoutMs: Volatile<number | undefined>
  /** Model catalog cache path; falls back to `$COMMANDCODE_MODELS_CACHE`, then `<dsh home>/commandcode/commandcode-models.json`. */
  modelsCachePath: Volatile<string | undefined>
  /** Optional explicit catalog; entries override (or add to) the discovered catalog by id. */
  models: Volatile<CommandCodeModelProfile[] | undefined>
  /** Context capacity for a model neither the catalog nor an override sizes (default 262,144). */
  defaultContextWindow: Volatile<number>
  /** Output capability for a model neither the catalog nor an override sizes (default 32,768). */
  defaultMaxTokens: Volatile<number>
  /** HTTP request timeout in ms (applied per attempt). */
  timeoutMs: Volatile<number | undefined>
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs: Volatile<number>
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy: Volatile<RetryPolicyConfig | undefined>
}

/**
 * Plain values behind {@link Config}'s references, one write per settings read.
 *
 * Every field stays optional: an absent field is indistinguishable from an
 * absent snapshot value, and {@link resolveOptions} applies the same default for
 * both.
 */
export type Options = {
  [K in keyof Config]?: Config[K] extends Volatile<infer T> ? Exclude<T, undefined> : never
}

const modelProfile: z<CommandCodeModelProfile> = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

/**
 * Runtime schema for {@link Config}.
 *
 * Every field carries `.volatile()`, and the flag belongs on each field rather
 * than on the root object: dsh 0.2 derives the settings form from this exported
 * schema and surfaces exactly the volatile fields, while marking the *root*
 * volatile would make the whole parsed config a single reference — `apply` would
 * then receive `Volatile<Config>` instead of a config whose fields are
 * references, and every plain field read would be `undefined`. Schemastery types
 * the two shapes differently, so a root-level flag cannot be hidden behind a
 * cast.
 *
 * The mode each field resolves to is what {@link Config} declares: `.volatile()`
 * alone yields `Volatile<T | undefined>`, and a preceding `.default()` yields
 * `Volatile<T>`.
 */
export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  displayName: z.string().volatile(),
  baseURL: z.string().volatile(),
  modelsUrl: z.string().volatile(),
  modelsTimeoutMs: z.natural().volatile(),
  modelsCachePath: z.string().volatile(),
  models: z.array(modelProfile).volatile(),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW).volatile(),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS).volatile(),
  timeoutMs: z.natural().volatile(),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
})

/** cosmokit's shared live-reference protocol, identified across duplicate installs. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Whether a parsed config value is one of the schema's live references. */
function isVolatileRef(value: unknown): value is Volatile<unknown> {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/**
 * Read the current value behind every reference of a parsed {@link Config}.
 *
 * The plugin reads config through this on each use rather than caching a
 * snapshot: a live update replaces the values inside the very same references,
 * so a captured {@link Options} would silently outlive the setting it came from.
 * @param config - Parsed plugin config.
 * @returns Plain options for {@link resolveOptions}.
 */
export function plainConfig(config: Config): Options {
  const plain: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    const snapshot = isVolatileRef(value) ? value.get() : value
    if (snapshot !== undefined) plain[key] = snapshot
  }
  return plain as Options
}

/** Validated profile with every adapter-owned default resolved. */
export interface ResolvedCommandCodeOptions {
  /** Validated credential reference. */
  apiKeyEnv: CredentialRef
  /** Resolved display name for selectors and configuration surfaces. */
  displayName: string
  /** Endpoint base for `/alpha/generate`. */
  baseURL: string
  /** Model discovery endpoint. */
  modelsUrl: string
  /** Model discovery timeout in ms. */
  modelsTimeoutMs: number
  /** Model catalog cache path. */
  modelsCachePath: string
  /** Explicit catalog entries, keyed by id. */
  catalogOverrides: ReadonlyMap<string, CommandCodeModelProfile>
  /** Context capacity for a model neither the catalog nor an override sizes. */
  defaultContextWindow: number
  /** Output capability for a model neither the catalog nor an override sizes. */
  defaultMaxTokens: number
  /** Per-attempt HTTP request timeout in ms. */
  timeoutMs?: number
  /** Positive finite provider-idle interval after defaulting. */
  streamIdleTimeoutMs: number
  /** Immutable retry policy captured with this provider route. */
  retryPolicy: ResolvedRetryPolicy
}

export interface ResolveOptionsEnvironment {
  get(name: string): { value: string } | undefined
}

/**
 * The one explicit resolve step from plain config to validated provider facts.
 * Environment layers supply endpoint/discovery/cache overrides only from
 * trusted layers; the credential itself never resolves here.
 * @param config - plain values, typically one {@link plainConfig} reading.
 * @param environment - the run's environment layers, or `undefined` outside the CLI.
 * @param defaultCachePath - the computed default cache path (based on the DSH home).
 * @returns validated provider facts plus the credential reference.
 */
export function resolveOptions(
  config: Options,
  environment: ResolveOptionsEnvironment | undefined,
  defaultCachePath: string,
): ResolvedCommandCodeOptions {
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('commandcode-provider: defaultContextWindow must be a positive integer')
  }
  if (config.defaultMaxTokens !== undefined
    && (!Number.isSafeInteger(config.defaultMaxTokens) || config.defaultMaxTokens <= 0)) {
    throw new Error('commandcode-provider: defaultMaxTokens must be a positive safe integer')
  }
  const modelsTimeoutMs = config.modelsTimeoutMs ?? readPositiveEnv(environment, MODELS_TIMEOUT_ENV, DEFAULT_MODELS_TIMEOUT_MS)
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `commandcode-provider: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  if (config.timeoutMs !== undefined
    && (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0)) {
    throw new Error('commandcode-provider: timeoutMs must be a positive integer')
  }
  const overrides = new Map<string, CommandCodeModelProfile>()
  for (const model of config.models ?? []) {
    if (model.id.length === 0) throw new Error('commandcode-provider: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`commandcode-provider: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(
        `commandcode-provider: catalog model "${model.id}" contextWindow must be a positive integer`,
      )
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(
        `commandcode-provider: catalog model "${model.id}" maxTokens must be a positive integer`,
      )
    }
    if (overrides.has(model.id)) {
      throw new Error(`commandcode-provider: duplicate catalog model "${model.id}"`)
    }
    overrides.set(model.id, { ...model })
  }
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    displayName: config.displayName ?? DEFAULT_DISPLAY_NAME,
    baseURL: config.baseURL
      ?? environment?.get(API_BASE_ENV)?.value
      ?? DEFAULT_API_BASE,
    modelsUrl: config.modelsUrl
      ?? environment?.get(MODELS_URL_ENV)?.value
      ?? DEFAULT_MODELS_URL,
    modelsTimeoutMs,
    modelsCachePath: config.modelsCachePath
      ?? environment?.get(MODELS_CACHE_ENV)?.value
      ?? defaultCachePath,
    catalogOverrides: overrides,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    defaultMaxTokens: config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    ...config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs },
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'commandcode-provider: retryPolicy'),
  }
}

function readPositiveEnv(
  environment: ResolveOptionsEnvironment | undefined,
  name: string,
  fallback: number,
): number {
  const raw = environment?.get(name)?.value
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Merge the discovered catalog with explicit overrides and apply the
 * default capacities. Faithful to the pi plugin's catalog (which has no
 * override concept): with no `models` configured, this is the discovered
 * catalog untouched.
 */
export function resolveCatalog(
  discovered: readonly CommandCodeModel[],
  options: ResolvedCommandCodeOptions,
): CommandCodeModel[] {
  const out = new Map<string, CommandCodeModel>()
  for (const model of discovered) {
    const override = options.catalogOverrides.get(model.id)
    out.set(model.id, {
      id: model.id,
      name: override?.name ?? model.name,
      reasoning: model.reasoning,
      contextWindow: override?.contextWindow ?? model.contextWindow,
      maxTokens: override?.maxTokens ?? model.maxTokens,
    })
  }
  for (const [id, override] of options.catalogOverrides) {
    const existing = out.get(id)
    out.set(id, {
      id,
      name: override.name ?? existing?.name ?? id,
      reasoning: existing?.reasoning ?? false,
      contextWindow: override.contextWindow ?? existing?.contextWindow ?? options.defaultContextWindow,
      maxTokens: override.maxTokens ?? existing?.maxTokens ?? options.defaultMaxTokens,
    })
  }
  return [...out.values()]
}
