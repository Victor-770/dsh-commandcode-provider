/**
 * Command Code model discovery, offline cache, reasoning metadata, and input
 * modalities.
 *
 * The per-model tables below are a snapshot of the model catalog bundled with
 * `command-code@1.88.2` (`dist/cli.mjs`), cross-checked against the live
 * Provider API listing and the capability table on
 * https://commandcode.ai/docs/reference/cli/models. The Provider API discloses
 * neither input modalities nor reasoning efforts, so this snapshot is the only
 * upstream evidence for them; models that are not listed remain text-only so a
 * newly discovered id never claims image support without evidence.
 *
 * @module dsh-commandcode-provider/models
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const DEFAULT_MODELS_URL = 'https://api.commandcode.ai/provider/v1/models'
export const DEFAULT_MODELS_TIMEOUT_MS = 10_000

const DEFAULT_MAX_OUTPUT_TOKENS = 65_536
const MODEL_CACHE_VERSION = 1

export type CommandCodeInputType = 'text' | 'image'

/**
 * Model input modalities from the command-code@1.88.2 bundled catalog.
 * Models omitted here remain text-only.
 */
export const MODEL_INPUT_MODALITIES: Readonly<Record<string, readonly CommandCodeInputType[]>> = {
  'claude-fable-5': ['text', 'image'],
  'claude-fable-5-1': ['text', 'image'],
  'claude-haiku-4-5-20251001': ['text', 'image'],
  'claude-haiku-5-5': ['text', 'image'],
  'claude-opus-4-7': ['text', 'image'],
  'claude-opus-4-8': ['text', 'image'],
  'claude-opus-5': ['text', 'image'],
  'claude-opus-5-5': ['text', 'image'],
  'claude-sonnet-4-6': ['text', 'image'],
  'claude-sonnet-5': ['text', 'image'],
  'claude-sonnet-5-5': ['text', 'image'],
  'deepseek/deepseek-v4-flash': ['text'],
  'deepseek/deepseek-v4-flash-fast': ['text'],
  'deepseek/deepseek-v4-flash-vision-exp': ['text', 'image'],
  'deepseek/deepseek-v4-pro': ['text'],
  'deepseek/deepseek-v4.1-flash': ['text', 'image'],
  'deepseek/deepseek-v4.1-flash-fast': ['text', 'image'],
  'google/gemini-3.1-flash-lite': ['text', 'image'],
  'google/gemini-3.5-flash': ['text', 'image'],
  'google/gemini-3.5-flash-lite': ['text', 'image'],
  'google/gemini-3.6-flash': ['text', 'image'],
  'google/gemini-3.7-flash': ['text', 'image'],
  'google/gemini-3.8-flash': ['text', 'image'],
  'google/gemini-4-argon': ['text', 'image'],
  'gpt-5.3-codex': ['text', 'image'],
  'gpt-5.4': ['text', 'image'],
  'gpt-5.4-mini': ['text', 'image'],
  'gpt-5.5': ['text', 'image'],
  'gpt-5.6-luna': ['text', 'image'],
  'gpt-5.6-sol': ['text', 'image'],
  'gpt-5.6-terra': ['text', 'image'],
  'gpt-6-astra': ['text', 'image'],
  'gpt-6-luna': ['text', 'image'],
  'gpt-6-sol': ['text', 'image'],
  'gpt-6.1-sol': ['text', 'image'],
  'gpt-6.1-terra': ['text', 'image'],
  'inclusionai/ling-3.1-flash': ['text'],
  'inclusionai/ling-3.1-flash-1019': ['text'],
  'meituan/LongCat-2.0': ['text'],
  'meta/muse-spark-1.1': ['text', 'image'],
  'meta/muse-spark-1.2': ['text', 'image'],
  'meta/muse-spark-1.2-contributor': ['text', 'image'],
  'meta/muse-spark-1.3': ['text', 'image'],
  'meta/muse-spark-1.3-contributor': ['text', 'image'],
  'meta/muse-spark-open': ['text', 'image'],
  'meta/muse-wonder-1.0': ['text', 'image'],
  'minimax/minimax-m3.1-flash': ['text', 'image'],
  'MiniMaxAI/MiniMax-M2.5': ['text'],
  'MiniMaxAI/MiniMax-M2.7': ['text'],
  'MiniMaxAI/MiniMax-M3': ['text', 'image'],
  'mistral/mistral-large-4': ['text', 'image'],
  'moonshotai/Kimi-K2.5': ['text', 'image'],
  'moonshotai/Kimi-K2.6': ['text', 'image'],
  'moonshotai/Kimi-K2.7-Code': ['text', 'image'],
  'moonshotai/Kimi-K2.7-Code-Highspeed': ['text', 'image'],
  'moonshotai/Kimi-K3': ['text', 'image'],
  'moonshotai/Kimi-K3.1-Pro': ['text', 'image'],
  'nvidia/nemotron-3-ultra-550b-a55b': ['text'],
  'nvidia/nemotron-3.5-super-vl': ['text', 'image'],
  'ornith/ornith-1.5-122b': ['text', 'image'],
  'poolside/laguna-s-2.1-free': ['text'],
  'Qwen/Qwen3.6-Max-Preview': ['text'],
  'Qwen/Qwen3.6-Plus': ['text', 'image'],
  'Qwen/Qwen3.7-Flash': ['text', 'image'],
  'Qwen/Qwen3.7-Max': ['text'],
  'Qwen/Qwen3.7-Plus': ['text', 'image'],
  'Qwen/Qwen3.8-27B': ['text', 'image'],
  'Qwen/Qwen3.8-Flash': ['text', 'image'],
  'Qwen/Qwen3.8-Max': ['text', 'image'],
  'Qwen/Qwen3.8-Max-0902': ['text', 'image'],
  'Qwen/Qwen3.8-Max-Prime': ['text', 'image'],
  'Qwen/Qwen3.8-Omni-Flash': ['text', 'image'],
  'reflection/beam:free': ['text'],
  'sakana/fugu-ultra': ['text', 'image'],
  'stealth/crouton-alpha': ['text', 'image'],
  'stealth/glyph-cluster:free': ['text'],
  'stepfun/Step-3.5-Flash': ['text'],
  'stepfun/Step-3.7-Flash': ['text', 'image'],
  'stepfun/Step-5-Preview': ['text', 'image'],
  'tencent/hy3-paid': ['text'],
  'tencent/hy4-preview': ['text'],
  'thinkingmachines/inkling': ['text', 'image'],
  'thinkingmachines/inkling-small': ['text', 'image'],
  'xai/grok-4.5': ['text', 'image'],
  'xai/grok-4.6': ['text', 'image'],
  'xai/grok-4.7': ['text', 'image'],
  'xiaomi/mimo-v2.6-flash': ['text', 'image'],
  'xiaomi/mimo-v2.6-pro': ['text', 'image'],
  'xiaomi/mimo-v2.6-pro-ultraspeed': ['text', 'image'],
  'z-ai/glm-5.3-flash': ['text', 'image'],
  'z-ai/glm-5.3-flashx': ['text', 'image'],
  'zai-org/GLM-5': ['text'],
  'zai-org/GLM-5.1': ['text'],
  'zai-org/GLM-5.2': ['text'],
  'zai-org/GLM-5.2-Fast': ['text'],
  'zai-org/GLM-5.3': ['text'],
}

const TEXT_INPUT_ONLY = ['text'] as const

export function inputModalitiesForModel(modelId: string): readonly CommandCodeInputType[] {
  return MODEL_INPUT_MODALITIES[modelId] ?? TEXT_INPUT_ONLY
}

export function modelSupportsImageInput(modelId: string): boolean {
  return inputModalitiesForModel(modelId).includes('image')
}

export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

type CommandCodeReasoningEffort = Exclude<PiThinkingLevel, 'off'>

/**
 * Per-model reasoning efforts supported by Command Code's generate endpoint.
 *
 * Snapshot of `reasoningEfforts` from the command-code@1.88.2 model catalog.
 * The `off` entry is dropped because it selects no reasoning effort at all.
 * Models omitted here let Command Code choose their reasoning depth.
 */
export const MODEL_EFFORTS: Readonly<Record<string, readonly CommandCodeReasoningEffort[]>> = {
  'claude-fable-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-fable-5-1': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-haiku-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'deepseek/deepseek-v4-flash': ['high', 'max'],
  'deepseek/deepseek-v4-flash-fast': ['low', 'high', 'max'],
  'deepseek/deepseek-v4-flash-vision-exp': ['high', 'max'],
  'deepseek/deepseek-v4-pro': ['high', 'max'],
  'deepseek/deepseek-v4.1-flash': ['low', 'high', 'max'],
  'deepseek/deepseek-v4.1-flash-fast': ['low', 'high', 'max'],
  'google/gemini-3.1-flash-lite': ['low', 'medium', 'high'],
  'google/gemini-3.5-flash': ['low', 'medium', 'high'],
  'google/gemini-3.5-flash-lite': ['low', 'medium', 'high'],
  'google/gemini-3.6-flash': ['low', 'medium', 'high'],
  'google/gemini-3.7-flash': ['low', 'medium', 'high'],
  'google/gemini-3.8-flash': ['low', 'medium', 'high'],
  'google/gemini-4-argon': ['low', 'medium', 'high'],
  'gpt-5.3-codex': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4-mini': ['low', 'medium', 'high'],
  'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6.1-terra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'inclusionai/ling-3.1-flash': ['low', 'medium', 'high'],
  'inclusionai/ling-3.1-flash-1019': ['low', 'high', 'max'],
  'meta/muse-spark-1.1': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.2': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.2-contributor': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.3': ['low', 'medium', 'high', 'xhigh', 'max'],
  'meta/muse-spark-1.3-contributor': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-open': ['low', 'medium', 'high'],
  'meta/muse-wonder-1.0': ['low', 'medium', 'high', 'xhigh'],
  'minimax/minimax-m3.1-flash': ['low', 'medium', 'high', 'xhigh', 'max'],
  'MiniMaxAI/MiniMax-M3': ['low', 'medium', 'high'],
  'mistral/mistral-large-4': ['low', 'medium', 'high'],
  'moonshotai/Kimi-K3': ['low', 'high', 'max'],
  'moonshotai/Kimi-K3.1-Pro': ['low', 'high', 'max'],
  'nvidia/nemotron-3.5-super-vl': ['low', 'medium', 'high'],
  'Qwen/Qwen3.8-27B': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-Flash': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-Max': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-Max-0902': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-Max-Prime': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-Omni-Flash': ['low', 'medium', 'xhigh'],
  'reflection/beam:free': ['low', 'medium', 'high', 'xhigh', 'max'],
  'sakana/fugu-ultra': ['high', 'xhigh'],
  'stealth/crouton-alpha': ['low', 'high', 'max'],
  'stealth/glyph-cluster:free': ['low', 'medium', 'high', 'xhigh'],
  'stepfun/Step-5-Preview': ['low', 'medium', 'high'],
  'tencent/hy4-preview': ['low', 'medium', 'high'],
  'xai/grok-4.5': ['low', 'medium', 'high'],
  'xai/grok-4.6': ['low', 'medium', 'high', 'xhigh'],
  'xai/grok-4.7': ['low', 'medium', 'high', 'xhigh'],
  'z-ai/glm-5.3-flash': ['low', 'high', 'max'],
  'z-ai/glm-5.3-flashx': ['low', 'high', 'max'],
  'zai-org/GLM-5.2': ['high', 'max'],
  'zai-org/GLM-5.3': ['low', 'high', 'max'],
}

const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

export function thinkingLevelMapForEfforts(
  efforts: readonly string[],
): Partial<Record<PiThinkingLevel, string | null>> {
  const map: Partial<Record<PiThinkingLevel, string | null>> = {}
  for (const level of PI_THINKING_LEVELS) {
    if (level === 'off') continue
    map[level] = efforts.includes(level) ? level : null
  }
  return map
}

export interface ThinkingMetadata {
  thinkingLevelMap: Partial<Record<PiThinkingLevel, string | null>>
  thinking: {
    mode: 'effort'
    effortMap: Partial<Record<CommandCodeReasoningEffort, string>>
    efforts: readonly CommandCodeReasoningEffort[]
  }
}

export function thinkingMetadataForModel(modelId: string): ThinkingMetadata | undefined {
  const efforts = MODEL_EFFORTS[modelId]
  if (!efforts) return undefined
  return {
    thinkingLevelMap: thinkingLevelMapForEfforts(efforts),
    thinking: {
      mode: 'effort',
      effortMap: Object.fromEntries(efforts.map((effort) => [effort, effort])),
      efforts,
    },
  }
}

function isReasoningModel(modelId: string): boolean {
  return MODEL_EFFORTS[modelId] !== undefined
}

interface ApiModel {
  id: string
  name: string
  contextLength: number
}

export interface CommandCodeModel {
  id: string
  name: string
  reasoning: boolean
  contextWindow: number
  maxTokens: number
}

interface FetchCommandCodeModelsOptions {
  url?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}

interface LoadCommandCodeModelsOptions extends FetchCommandCodeModelsOptions {
  cachePath: string
}

export interface LoadCommandCodeModelsResult {
  models: readonly CommandCodeModel[]
  source: 'live' | 'cache' | 'empty'
  warning?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected ${key} to be a non-empty string`)
  }
  return value
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') throw new Error(`Expected ${key} to be a boolean`)
  return value
}

function positiveNumberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected ${key} to be a positive number`)
  }
  return value
}

function parseApiModel(value: unknown): ApiModel {
  if (!isRecord(value)) throw new Error('Expected model entry to be an object')

  return {
    id: stringField(value, 'id'),
    name: stringField(value, 'name'),
    contextLength: positiveNumberField(value, 'context_length'),
  }
}

function parseCachedModel(value: unknown): CommandCodeModel {
  if (!isRecord(value)) throw new Error('Expected cached model entry to be an object')

  const id = stringField(value, 'id')
  booleanField(value, 'reasoning')
  return {
    id,
    name: stringField(value, 'name'),
    reasoning: isReasoningModel(id),
    contextWindow: positiveNumberField(value, 'contextWindow'),
    maxTokens: positiveNumberField(value, 'maxTokens'),
  }
}

function requireModels(models: readonly CommandCodeModel[]): readonly CommandCodeModel[] {
  if (models.length === 0) throw new Error('Command Code returned an empty model catalog')
  return models
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new DOMException('The operation was aborted', 'AbortError')
}

function configuredTimeoutMs(timeoutMs: number | undefined): number {
  return timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_MODELS_TIMEOUT_MS
}

export function getModelsTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.COMMANDCODE_MODELS_TIMEOUT_MS
  if (!raw) return DEFAULT_MODELS_TIMEOUT_MS

  const parsed = Number(raw)
  return configuredTimeoutMs(parsed)
}

class ModelDiscoveryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Command Code model discovery timed out after ${timeoutMs}ms`)
    this.name = 'ModelDiscoveryTimeoutError'
  }
}

function runWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  let onExternalAbort: (() => void) | undefined

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      if (onExternalAbort && externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort)
      }
    }

    const resolveOnce = (value: T) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    const rejectOnce = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const abort = (reason: unknown) => {
      const error = abortError(reason)
      controller.abort(error)
      rejectOnce(error)
    }

    if (externalSignal?.aborted) {
      abort(externalSignal.reason)
      return
    }

    onExternalAbort = () => abort(externalSignal?.reason)
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
    timer = setTimeout(() => abort(new ModelDiscoveryTimeoutError(timeoutMs)), timeoutMs)

    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(resolveOnce, rejectOnce)
  })
}

export function commandCodeModelsFromApiResponse(value: unknown): readonly CommandCodeModel[] {
  if (!isRecord(value)) throw new Error('Expected models response to be an object')
  if (value.object !== 'list') throw new Error("Expected models response object to be 'list'")

  const data = value.data
  if (!Array.isArray(data)) throw new Error('Expected models response data to be an array')

  return data.map(parseApiModel).map((model) => ({
    id: model.id,
    name: `${model.name} (CC)`,
    reasoning: isReasoningModel(model.id),
    contextWindow: model.contextLength,
    maxTokens: Math.min(model.contextLength, DEFAULT_MAX_OUTPUT_TOKENS),
  }))
}

export function commandCodeModelsFromCache(value: unknown): readonly CommandCodeModel[] {
  if (!isRecord(value)) throw new Error('Expected model cache to be an object')
  if (value.version !== MODEL_CACHE_VERSION) {
    throw new Error(`Expected model cache version ${MODEL_CACHE_VERSION}`)
  }
  if (!Array.isArray(value.models)) throw new Error('Expected cached models to be an array')

  return requireModels(value.models.map(parseCachedModel))
}

export async function fetchCommandCodeModels(
  options: FetchCommandCodeModelsOptions = {},
): Promise<readonly CommandCodeModel[]> {
  const url = options.url ?? DEFAULT_MODELS_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const body: unknown = await runWithTimeout(
    async (signal) => {
      const response = await fetchImpl(url, {
        headers: {
          accept: 'application/json',
        },
        signal,
      })

      if (!response.ok) {
        throw new Error(
          `Failed to fetch Command Code models: ${response.status} ${response.statusText}`,
        )
      }

      return await response.json()
    },
    configuredTimeoutMs(options.timeoutMs),
    options.signal,
  )
  return requireModels(commandCodeModelsFromApiResponse(body))
}

async function readCommandCodeModelsCache(cachePath: string): Promise<readonly CommandCodeModel[]> {
  const contents = await readFile(cachePath, 'utf-8')
  const parsed: unknown = JSON.parse(contents)
  return commandCodeModelsFromCache(parsed)
}

async function writeCommandCodeModelsCache(
  cachePath: string,
  models: readonly CommandCodeModel[],
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true })
  const temporaryPath = `${cachePath}.${process.pid}.tmp`

  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: MODEL_CACHE_VERSION, models }, null, 2)}\n`,
      { encoding: 'utf-8', mode: 0o600 },
    )
    await rename(temporaryPath, cachePath)
  } finally {
    try {
      await rm(temporaryPath, { force: true })
    } catch {
      // Best-effort cleanup must not hide the original cache write error.
    }
  }
}

/**
 * Load the current Command Code model catalog: live fetch first, cached
 * fallback on failure, empty only when neither is available.
 */
export async function loadCommandCodeModels(
  options: LoadCommandCodeModelsOptions,
): Promise<LoadCommandCodeModelsResult> {
  const cachePath = options.cachePath

  try {
    const models = await fetchCommandCodeModels(options)

    try {
      await writeCommandCodeModelsCache(cachePath, models)
      return { models, source: 'live' }
    } catch (error) {
      return {
        models,
        source: 'live',
        warning: `Loaded the live Command Code model catalog but could not update ${cachePath}: ${errorMessage(error)}`,
      }
    }
  } catch (liveError) {
    if (options.signal?.aborted) throw abortError(options.signal.reason ?? liveError)

    try {
      const models = await readCommandCodeModelsCache(cachePath)
      return {
        models,
        source: 'cache',
        warning: `Could not refresh the Command Code model catalog (${errorMessage(liveError)}). Using the cached catalog from ${cachePath}.`,
      }
    } catch (cacheError) {
      return {
        models: [],
        source: 'empty',
        warning: `Could not refresh the Command Code model catalog (${errorMessage(liveError)}), and no valid cached catalog is available at ${cachePath} (${errorMessage(cacheError)}). Command Code models will remain unavailable until a refresh succeeds.`,
      }
    }
  }
}
