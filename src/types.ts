import type { AssistantMessageEventStream, JsonObject } from '@earendil-works/pi-ai'

/**
 * Command Code wire vocabulary, ported from pi-commandcode-provider so the
 * stream core stays host-agnostic and unit-testable. The shapes mirror the
 * Command Code Provider API (`/alpha/generate`) and the pi-ai assistant
 * event protocol this plugin emits into the Harness LLM seam.
 *
 * @module dsh-commandcode-provider/types
 */

export type StopReason = 'stop' | 'length' | 'toolUse'
export type ErrorReason = 'error' | 'aborted'
export type TerminalReason = StopReason | ErrorReason

export interface UsageCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h?: number
  totalTokens: number
  cost: UsageCost
}

export interface TextContent {
  type: 'text'
  text: string
}

export interface ThinkingContent {
  type: 'thinking'
  thinking: string
}

export interface ToolCallContent {
  type: 'toolCall'
  id: string
  name: string
  /**
   * Parsed tool arguments. Typed as pi-ai's `JsonObject` rather than
   * `Record<string, unknown>`: the values are always decoded from the
   * provider's JSON argument stream, and pi-ai's `ToolCall` requires the
   * narrower type, so the loose form no longer satisfies the assistant
   * message this plugin hands back.
   */
  arguments: JsonObject
}

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent

/** The pi-ai assistant-message shape this plugin's stream emits per turn. */
export interface AssistantMessageLike {
  role: 'assistant'
  content: AssistantContent[]
  api: string
  provider: string
  model: string
  usage: Usage
  stopReason: TerminalReason
  errorMessage?: string
  timestamp: number
}

export interface ModelCostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ModelCostTier extends ModelCostRates {
  inputTokensAbove: number
}

export interface ModelCost extends ModelCostRates {
  tiers?: readonly ModelCostTier[]
}

/** pi-ai model descriptor this plugin constructs from the Command Code catalog. */
export interface ModelLike {
  id: string
  api: string
  provider: string
  maxTokens: number
  cost: ModelCost
  reasoning?: boolean
  thinkingLevelMap?: Partial<Record<string, string | null>>
  thinking?: {
    mode?: 'effort'
    effortMap?: Partial<Record<string, string>>
    efforts?: readonly string[]
  }
}

export interface MessageLike {
  role: string
  content?: unknown
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

export interface ToolLike {
  name: string
  description?: string
  parameters?: unknown
}

export interface ContextLike {
  systemPrompt?: string
  messages?: readonly MessageLike[]
  tools?: readonly ToolLike[]
}

export interface ProviderResponseInfo {
  status: number
  headers: Record<string, string>
}

/** Stream options accepted by the Command Code stream implementation. */
export interface StreamOptions {
  apiKey?: string
  signal?: AbortSignal
  headers?: Record<string, string>
  maxTokens?: number
  /** Resolved pi thinking level; forwarded only through the model's map. */
  reasoning?: string
  onPayload?: (payload: unknown, model: ModelLike) => unknown | Promise<unknown>
  onResponse?: (response: ProviderResponseInfo, model: ModelLike) => void | Promise<void>
  /**
   * HTTP request timeout in milliseconds. Applied per-attempt; on timeout the
   * request is retried if retries remain.
   */
  timeoutMs?: number
  /**
   * Maximum retry attempts for transient HTTP errors (429, 5xx).
   * Default: 0 (the Harness agent-recovery layer owns visible retries).
   */
  maxRetries?: number
  /**
   * Maximum delay in milliseconds to wait for a retry when the server requests
   * a long wait via Retry-After. Default: 60000 (60 seconds). Set to 0 to
   * disable the cap.
   */
  maxRetryDelayMs?: number
}

/** Dependencies the Command Code stream takes so tests can inject everything. */
export interface CoreDependencies {
  createStream: () => AssistantMessageEventStream
  calculateCost: (model: ModelLike, usage: Usage) => void
  apiBase?: string
  fetchImpl?: typeof fetch
  authPaths?: readonly string[]
  env?: Record<string, string | undefined>
  cwd?: () => string
  now?: () => number
  uuid?: () => string
  homeDir?: () => string
  /** Injectable delay for retry backoff. Defaults to setTimeout. */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>
}
