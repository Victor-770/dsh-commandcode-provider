/**
 * Command Code model discovery, offline cache, reasoning metadata, and input
 * modalities. Ported from pi-commandcode-provider's `src/models.ts` so the
 * catalog behavior (live fetch, cached fallback, per-model enrichment) is
 * identical to the pi plugin.
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
 * Input modalities from the command-code@1.88.2 bundled model catalog
 * (the CLI's `MODEL_CATALOG` entries). A model omitted here is text-only:
 * newly discovered IDs never claim image support without upstream evidence.
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
  'deepseek/deepseek-v4-flash-vision-exp': ['text', 'image'],
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
  'meta/muse-spark-1.1': ['text', 'image'],
  'meta/muse-spark-1.2': ['text', 'image'],
  'meta/muse-spark-1.2-contributor': ['text', 'image'],
  'meta/muse-spark-1.3': ['text', 'image'],
  'meta/muse-spark-1.3-contributor': ['text', 'image'],
  'meta/muse-spark-open': ['text', 'image'],
  'meta/muse-wonder-1.0': ['text', 'image'],
  'minimax/minimax-m3-free': ['text', 'image'],
  'minimax/minimax-m3.1-flash': ['text', 'image'],
  'minimax/minimax-m3.1-flash:free': ['text', 'image'],
  'MiniMaxAI/MiniMax-M3': ['text', 'image'],
  'MiniMaxAI/MiniMax-M3-Free': ['text', 'image'],
  'mistral/mistral-large-4': ['text', 'image'],
  'moonshotai/Kimi-K2.5': ['text', 'image'],
  'moonshotai/Kimi-K2.6': ['text', 'image'],
  'moonshotai/Kimi-K2.7-Code': ['text', 'image'],
  'moonshotai/Kimi-K2.7-Code-Highspeed': ['text', 'image'],
  'moonshotai/Kimi-K3': ['text', 'image'],
  'moonshotai/Kimi-K3.1-Pro': ['text', 'image'],
  'nvidia/nemotron-3.5-super-vl': ['text', 'image'],
  'ornith/ornith-1.5-122b': ['text', 'image'],
  'ornith/ornith-1.5-122b:free': ['text', 'image'],
  'Qwen/Qwen3.6-Plus': ['text', 'image'],
  'Qwen/Qwen3.7-Flash': ['text', 'image'],
  'Qwen/Qwen3.7-Plus': ['text', 'image'],
  'Qwen/Qwen3.8-27B': ['text', 'image'],
  'Qwen/Qwen3.8-Flash': ['text', 'image'],
  'Qwen/Qwen3.8-Max': ['text', 'image'],
  'Qwen/Qwen3.8-Max-0902': ['text', 'image'],
  'Qwen/Qwen3.8-Max-Prime': ['text', 'image'],
  'Qwen/Qwen3.8-Omni-Flash': ['text', 'image'],
  'sakana/fugu-ultra': ['text', 'image'],
  'stealth/pixel-canary': ['text', 'image'],
  'stealth/space-bunny-alpha': ['text', 'image'],
  'stepfun/Step-3.7-Flash': ['text', 'image'],
  'stepfun/Step-5-Preview': ['text', 'image'],
  'thinkingmachines/inkling': ['text', 'image'],
  'thinkingmachines/inkling-small': ['text', 'image'],
  'xai/grok-4.5': ['text', 'image'],
  'xai/grok-4.6': ['text', 'image'],
  'xai/grok-4.7': ['text', 'image'],
  'xiaomi/mimo-v2.5': ['text', 'image'],
  'xiaomi/mimo-v2.6-flash': ['text', 'image'],
  'xiaomi/mimo-v2.6-pro': ['text', 'image'],
  'xiaomi/mimo-v2.6-pro-ultraspeed': ['text', 'image'],
  'z-ai/glm-5.3-flash': ['text', 'image'],
  'z-ai/glm-5.3-flashx': ['text', 'image'],
}

const TEXT_INPUT_ONLY = ['text'] as const

export function inputModalitiesForModel(modelId: string): readonly CommandCodeInputType[] {
  return MODEL_INPUT_MODALITIES[modelId] ?? TEXT_INPUT_ONLY
}

export function modelSupportsImageInput(modelId: string): boolean {
  return inputModalitiesForModel(modelId).includes('image')
}

export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** One reasoning effort the Command Code endpoint accepts for a model. */
export type CommandCodeReasoningEffort = PiThinkingLevel

/**
 * Models the catalog marks as reasoning-capable. Some of them publish no
 * selectable efforts (`reasoningEfforts` absent): Command Code chooses the
 * depth itself, which is why the flag and the effort table are separate.
 */
export const MODEL_REASONING: Readonly<Record<string, true>> = {
  'claude-fable-5': true,
  'claude-fable-5-1': true,
  'claude-haiku-5-5': true,
  'claude-opus-4-7': true,
  'claude-opus-4-8': true,
  'claude-opus-5': true,
  'claude-opus-5-5': true,
  'claude-sonnet-4-6': true,
  'claude-sonnet-5': true,
  'claude-sonnet-5-5': true,
  'deepseek/deepseek-v4-flash': true,
  'deepseek/deepseek-v4-flash-fast': true,
  'deepseek/deepseek-v4-flash-vision-exp': true,
  'deepseek/deepseek-v4-pro': true,
  'deepseek/deepseek-v4.1-flash': true,
  'deepseek/deepseek-v4.1-flash-fast': true,
  'google/gemini-3.1-flash-lite': true,
  'google/gemini-3.5-flash': true,
  'google/gemini-3.5-flash-lite': true,
  'google/gemini-3.6-flash': true,
  'google/gemini-3.7-flash': true,
  'google/gemini-3.8-flash': true,
  'google/gemini-4-argon': true,
  'gpt-5.3-codex': true,
  'gpt-5.4': true,
  'gpt-5.4-mini': true,
  'gpt-5.5': true,
  'gpt-5.6-luna': true,
  'gpt-5.6-sol': true,
  'gpt-5.6-terra': true,
  'gpt-6-astra': true,
  'gpt-6-luna': true,
  'gpt-6-sol': true,
  'gpt-6.1-sol': true,
  'gpt-6.1-terra': true,
  'inclusionai/ling-3.1-flash': true,
  'inclusionai/ling-3.1-flash:free': true,
  'meituan/LongCat-2.0': true,
  'meituan/LongCat-2.0:free': true,
  'meta/muse-spark-1.1': true,
  'meta/muse-spark-1.2': true,
  'meta/muse-spark-1.2-contributor': true,
  'meta/muse-spark-1.3': true,
  'meta/muse-spark-1.3-contributor': true,
  'meta/muse-spark-open': true,
  'meta/muse-wonder-1.0': true,
  'minimax/minimax-m3-free': true,
  'minimax/minimax-m3.1-flash': true,
  'minimax/minimax-m3.1-flash:free': true,
  'MiniMaxAI/MiniMax-M3': true,
  'MiniMaxAI/MiniMax-M3-Free': true,
  'mistral/mistral-large-4': true,
  'moonshotai/Kimi-K2.7-Code': true,
  'moonshotai/Kimi-K2.7-Code-Highspeed': true,
  'moonshotai/Kimi-K3': true,
  'moonshotai/Kimi-K3.1-Pro': true,
  'nvidia/nemotron-3-ultra-550b-a55b': true,
  'nvidia/nemotron-3.5-super-vl': true,
  'ornith/ornith-1.5-122b': true,
  'ornith/ornith-1.5-122b:free': true,
  'poolside/laguna-s-2.1-free': true,
  'Qwen/Qwen3.6-Max-Preview': true,
  'Qwen/Qwen3.6-Plus': true,
  'Qwen/Qwen3.7-Flash': true,
  'Qwen/Qwen3.7-Max': true,
  'Qwen/Qwen3.7-Plus': true,
  'Qwen/Qwen3.8-27B': true,
  'Qwen/Qwen3.8-Flash': true,
  'Qwen/Qwen3.8-Max': true,
  'Qwen/Qwen3.8-Max-0902': true,
  'Qwen/Qwen3.8-Max-Prime': true,
  'Qwen/Qwen3.8-Omni-Flash': true,
  'reflection/beam:free': true,
  'sakana/fugu-ultra': true,
  'stealth/glyph-cluster:free': true,
  'stealth/pixel-canary': true,
  'stealth/space-bunny-alpha': true,
  'stepfun/Step-3.5-Flash': true,
  'stepfun/Step-3.7-Flash': true,
  'stepfun/Step-5-Preview': true,
  'tencent/Hy3': true,
  'tencent/hy3-paid': true,
  'tencent/hy4-preview': true,
  'thinkingmachines/inkling': true,
  'thinkingmachines/inkling-small': true,
  'xai/grok-4.5': true,
  'xai/grok-4.6': true,
  'xai/grok-4.7': true,
  'z-ai/glm-5.3-flash': true,
  'z-ai/glm-5.3-flashx': true,
  'zai-org/GLM-5.2': true,
  'zai-org/GLM-5.3': true,
}

/**
 * Selectable reasoning efforts, an exact snapshot of `reasoningEfforts` from
 * the command-code@1.88.2 catalog. Models omitted here are either not
 * reasoning-capable or let Command Code choose the depth.
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
  'deepseek/deepseek-v4-flash': ['off', 'high', 'max'],
  'deepseek/deepseek-v4-flash-fast': ['low', 'high', 'max'],
  'deepseek/deepseek-v4-flash-vision-exp': ['off', 'high', 'max'],
  'deepseek/deepseek-v4-pro': ['off', 'high', 'max'],
  'deepseek/deepseek-v4.1-flash': ['off', 'low', 'high', 'max'],
  'deepseek/deepseek-v4.1-flash-fast': ['off', 'low', 'high', 'max'],
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
  'meta/muse-spark-1.1': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.2': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.2-contributor': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.3': ['low', 'medium', 'high', 'xhigh', 'max'],
  'meta/muse-spark-1.3-contributor': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-open': ['low', 'medium', 'high'],
  'meta/muse-wonder-1.0': ['low', 'medium', 'high', 'xhigh'],
  'minimax/minimax-m3-free': ['low', 'medium', 'high'],
  'minimax/minimax-m3.1-flash': ['low', 'medium', 'high', 'xhigh', 'max'],
  'minimax/minimax-m3.1-flash:free': ['low', 'medium', 'high', 'xhigh', 'max'],
  'MiniMaxAI/MiniMax-M3': ['low', 'medium', 'high'],
  'MiniMaxAI/MiniMax-M3-Free': ['low', 'medium', 'high'],
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

/**
 * Advertised per-model output-token caps. Models omitted here use
 * DEFAULT_MAX_OUTPUT_TOKENS instead of guessing a larger ceiling.
 */
export const MODEL_MAX_OUTPUT_TOKENS: Readonly<Record<string, number>> = {
  'inclusionai/ling-3.1-flash': 32_768,
  'mistral/mistral-large-4': 262_144,
  'poolside/laguna-s-2.1-free': 32_768,
  'Qwen/Qwen3.8-27B': 32_768,
  'Qwen/Qwen3.8-Max-Prime': 131_072,
  'Qwen/Qwen3.8-Omni-Flash': 131_072,
  'reflection/beam:free': 131_072,
  'stealth/glyph-cluster:free': 256_000,
  'z-ai/glm-5.3-flash': 131_072,
  'z-ai/glm-5.3-flashx': 131_072,
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
  return MODEL_REASONING[modelId] === true
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
  const name = stringField(value, 'name')
  booleanField(value, 'reasoning')
  const contextWindow = positiveNumberField(value, 'contextWindow')
  const cachedMaxTokens = positiveNumberField(value, 'maxTokens')
  return {
    id,
    name,
    reasoning: isReasoningModel(id),
    contextWindow,
    // The cap is derived, not source data: re-derive it from the current table
    // so a catalog cached by an older plugin release picks up the real ceiling.
    maxTokens: Math.min(contextWindow, MODEL_MAX_OUTPUT_TOKENS[id] ?? cachedMaxTokens),
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
    maxTokens: Math.min(model.contextLength, MODEL_MAX_OUTPUT_TOKENS[model.id] ?? DEFAULT_MAX_OUTPUT_TOKENS),
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
