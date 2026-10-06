/**
 * Command Code adapter for the Harness LLM seam.
 *
 * Streams one `GenerateOptions` request over the Command Code
 * `/alpha/generate` protocol (ported from pi-commandcode-provider's
 * `core.ts`), converting Harness messages to the Command Code wire format
 * and pi-ai assistant events back into Harness `StreamChunk`s. The catalog
 * comes from the plugin's {@link CommandCodeCatalog} (live discovery with an
 * offline cache); credentials resolve per request through the plugin's seam,
 * so a changed key or configuration reaches the next request without a
 * restart.
 *
 * @module dsh-commandcode-provider/adapter
 */

import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessageEvent, JsonObject } from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { calculateCommandCodeCost } from './cost.ts'
import { createStreamCommandCode } from './core.ts'
import { inputModalitiesForModel, modelSupportsImageInput, thinkingMetadataForModel } from './models.ts'
import type { CommandCodeModel } from './models.ts'
import { MODEL_COSTS, ZERO_MODEL_COST } from './pricing.ts'
import type { ResolvedCommandCodeOptions } from './config.ts'
import { normalizeCommandCodeMessage, redactCommandCodeErrorText } from './overflow.ts'
import type { ContextLike, ModelLike, ToolLike } from './types.ts'

/** Constructor options for {@link CommandCodeAdapter}. */
export interface CommandCodeAdapterOptions {
  /** Current validated provider options; called once per operation. */
  options: () => ResolvedCommandCodeOptions
  /** Current effective model catalog; called once per operation. */
  catalog: () => readonly CommandCodeModel[]
  /** Resolve the credential for one request; frozen for that call. */
  resolveApiKey: (connection: ResolvedCommandCodeOptions) => Promise<string | undefined>
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** Flatten the text blocks of a Harness message. */
function flattenText(message: { content: readonly ContentBlock[] }): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/**
 * Flatten the text of one tool-result message body.
 *
 * A tool result is its own `role: 'tool'` message in the 0.2 seam, so there is
 * no nested `tool-result` content block to recurse into any more.
 */
function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks.map((block) => block.type === 'text' ? block.text : '').join('')
}

/** Image part carrying base64 data + mime type, as the Command Code converters expect. */
interface ImagePart {
  type: 'image'
  data: string
  mimeType: string
}

/** The pi-plugin message vocabulary the Command Code converters consume. */
type PiMessageLike =
  | { role: 'user'; content: string | ({ type: 'text'; text: string } | ImagePart)[] }
  | { role: 'assistant'; content: ({ type: 'text'; text: string } | { type: 'toolCall'; id: string; name: string; arguments: JsonObject })[] }
  | { role: 'toolResult'; toolCallId: string; toolName: string; content: { type: 'text'; text: string }[]; isError: boolean }

/** One assistant message converted to the pi-plugin vocabulary; tool names are recorded for later results. */
function toPiAssistant(
  message: { content: readonly ContentBlock[] },
  toolNames: Map<string, string>,
): Extract<PiMessageLike, { role: 'assistant' }> {
  const parts: Extract<PiMessageLike, { role: 'assistant' }>['content'] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool-call') {
      let argumentsValue: JsonObject = {}
      try {
        argumentsValue = JSON.parse(block.arguments) as JsonObject
      } catch {
        argumentsValue = {}
      }
      toolNames.set(block.id, block.name)
      parts.push({ type: 'toolCall', id: block.id, name: block.name, arguments: argumentsValue })
    }
  }
  return { role: 'assistant', content: parts }
}

async function userContent(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore,
): Promise<string | ({ type: 'text'; text: string } | ImagePart)[]> {
  const content: ({ type: 'text'; text: string } | ImagePart)[] = []
  const push = async (block: ContentBlock): Promise<void> => {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const stored = await attachments.readImage(block.attachment)
        content.push({
          type: 'image',
          data: Buffer.from(stored.data).toString('base64'),
          mimeType: stored.ref.mediaType,
        })
        break
      }
      default:
        // Other merge-extensible blocks are not user-input vocabulary here.
        break
    }
  }
  for (const block of blocks) await push(block)
  if (content.every((part) => part.type === 'text')) return content.map((part) => part.text).join('')
  return content
}

function toolsOf(options: GenerateOptions): ToolLike[] | undefined {
  return options.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

function piContext(options: GenerateOptions, messages: PiMessageLike[]): ContextLike {
  const tools = toolsOf(options)
  return {
    ...options.system !== undefined ? { systemPrompt: options.system } : {},
    messages,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
  }
}

function textOnlyContext(options: GenerateOptions): ContextLike {
  const toolNames = new Map<string, string>()
  const messages: PiMessageLike[] = []
  for (const message of options.messages) {
    if (contentHasImage(message.content)) {
      throw new LlmError('Command Code image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message) })
      continue
    }
    if (message.role === 'assistant') {
      messages.push(toPiAssistant(message, toolNames))
      continue
    }
    // A tool result is its own `role: 'tool'` message carrying `toolCallId`
    // directly, rather than a `tool-result` block nested in a user message.
    if (message.role === 'tool') {
      messages.push({
        role: 'toolResult',
        toolCallId: message.toolCallId,
        toolName: toolNames.get(message.toolCallId) ?? 'unknown',
        content: [{ type: 'text', text: toolResultText(message.content) || '(no output)' }],
        isError: message.isError ?? false,
      })
      continue
    }
    // `developer` messages carry only tool-addition/tool-removal blocks, which
    // the Command Code wire protocol has no representation for — the tool set
    // travels with every request instead — so they contribute nothing here.
    if (message.role === 'developer') continue
    const text = flattenText(message)
    // A user message with no text renders nothing on this wire (its images were
    // already refused above), so it is dropped rather than sent empty.
    if (text.length > 0) messages.push({ role: 'user', content: text })
  }
  return piContext(options, messages)
}

async function toPiContextWithImages(options: GenerateOptions, attachments: AttachmentStore): Promise<ContextLike> {
  const toolNames = new Map<string, string>()
  const messages: PiMessageLike[] = []

  for (const message of options.messages) {
    if (message.role === 'system') {
      if (contentHasImage(message.content)) {
        throw new LlmError('Command Code cannot represent an image in an in-history system message', 'UNSUPPORTED_CONTENT')
      }
      messages.push({ role: 'user', content: flattenText(message) })
      continue
    }
    if (message.role === 'assistant') {
      messages.push(toPiAssistant(message, toolNames))
      continue
    }
    // A tool result is its own `role: 'tool'` message carrying `toolCallId`
    // directly. Its content goes through `userContent` so a durable image
    // reference resolves exactly as it does in user content, but the pi
    // tool-result vocabulary is text-only: image parts are resolved here and
    // then dropped, and only the text below reaches the provider.
    if (message.role === 'tool') {
      const resultContent = await userContent(message.content, attachments)
      const text = typeof resultContent === 'string'
        ? resultContent || '(no output)'
        : resultContent.map((part) => part.type === 'text' ? part.text : '').join('') || '(no output)'
      messages.push({
        role: 'toolResult',
        toolCallId: message.toolCallId,
        toolName: toolNames.get(message.toolCallId) ?? 'unknown',
        content: [{ type: 'text', text }],
        isError: message.isError ?? false,
      })
      continue
    }
    // `developer` messages carry only tool-addition/tool-removal blocks, which
    // the Command Code wire protocol has no representation for — the tool set
    // travels with every request instead — so they contribute nothing here.
    if (message.role === 'developer') continue
    const content = await userContent(message.content, attachments)
    if (content.length > 0) messages.push({ role: 'user', content })
  }

  return piContext(options, messages)
}

/**
 * Convert Harness request history to the Command Code context vocabulary.
 * Images resolve through the durable attachment service when present.
 */
export function toCommandCodeContext(options: GenerateOptions): ContextLike
export function toCommandCodeContext(options: GenerateOptions, attachments: AttachmentStore): Promise<ContextLike>
export function toCommandCodeContext(options: GenerateOptions, attachments?: AttachmentStore): ContextLike | Promise<ContextLike> {
  return attachments === undefined ? textOnlyContext(options) : toPiContextWithImages(options, attachments)
}

/** Build the pi-plugin model descriptor one request streams against. */
export function buildModelLike(model: CommandCodeModel, provider: string): ModelLike {
  const thinking = thinkingMetadataForModel(model.id)
  return {
    id: model.id,
    api: 'commandcode-custom',
    provider,
    maxTokens: model.maxTokens,
    cost: MODEL_COSTS[model.id] ?? ZERO_MODEL_COST,
    reasoning: model.reasoning,
    ...(thinking ?? {}),
  }
}

/** Selectable reasoning efforts for one model, or nothing when it has none. */
function reasoningInfo(model: CommandCodeModel): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const efforts = thinkingMetadataForModel(model.id)?.thinking.efforts ?? []
  return {
    reasoning: {
      efforts: efforts.map((effort) => ({
        id: ReasoningEffortId(effort),
        name: effort.charAt(0).toUpperCase() + effort.slice(1),
      })),
    },
  }
}

/** Map Command Code usage to the Harness token vocabulary. */
export function mapUsage(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}

/** Classify a Command Code error message into a Harness machine code. */
function classifyCommandCodeError(message: string): string {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)) return 'TRANSPORT'
  return 'COMMAND_CODE_ERROR'
}

/**
 * Map a terminal assistant event to the Harness finish reason, honoring the
 * pi plugin's context-overflow normalization for this provider.
 */
export function mapStopReason(
  message: { stopReason: string; errorMessage?: string; usage: { input: number; output: number } },
  contextWindow?: number,
): FinishReason {
  const overflowText = message.stopReason === 'error'
    ? normalizeCommandCodeMessage(
        {
          role: 'assistant',
          provider: 'commandcode',
          stopReason: message.stopReason,
          ...message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage },
        },
        'commandcode',
      )?.message.errorMessage
    : undefined
  if (overflowText !== undefined && isContextWindowExceededError(overflowText)) {
    return {
      kind: 'error',
      failure: {
        message: overflowText,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }

  switch (message.stopReason) {
    case 'stop':
      return { kind: 'stop' }
    case 'length':
      // A length stop that fills the model window is an overflow, matching
      // pi-ai's usage-based detection in the generic adapter.
      if (contextWindow !== undefined && message.usage.input + message.usage.output >= contextWindow) {
        return {
          kind: 'error',
          failure: {
            message: 'Command Code response stopped because the model context window was exceeded',
            code: CONTEXT_WINDOW_EXCEEDED_CODE,
          },
        }
      }
      return { kind: 'max-tokens' }
    case 'toolUse':
      return { kind: 'tool-calls' }
    case 'aborted':
      return { kind: 'aborted', failure: { message: message.errorMessage ?? 'Command Code stream aborted', code: 'ABORTED' } }
    case 'error': {
      const text = redactCommandCodeErrorText(message.errorMessage ?? 'Command Code stream error')
      return { kind: 'error', failure: { message: text, code: classifyCommandCodeError(text) } }
    }
    default:
      return { kind: 'error', failure: { message: 'Command Code stream ended without a known stop reason', code: 'COMMAND_CODE_ERROR' } }
  }
}

/**
 * Translate the Command Code assistant event stream into Harness chunks.
 * The stream never throws mid-turn — failures arrive as `error` events,
 * which become error/aborted `finish` chunks.
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
): AsyncGenerator<StreamChunk> {
  const toolIds = new Map<number, { id: string; name: string }>()
  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        // The id/name live on the partial's content at this index; they are
        // needed when the tool-call block ends.
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: ToolCallId(known?.id ?? ''),
          ...known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {},
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: ToolCallId(event.toolCall.id),
            name: event.toolCall.name,
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(event.message, contextWindow),
        }
        return
      case 'error':
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(event.error, contextWindow),
        }
        return
      default:
        // AssistantMessageEvent is a closed union; a new event type should
        // fail compilation here via tsc's exhaustiveness when one is added.
        break
    }
  }
  throw new LlmError('Command Code event stream ended without done/error', 'STREAM_CLOSED')
}

/**
 * Command Code provider adapter for the Harness LLM seam. One instance serves
 * the single `commandcode` route; each operation reads the current options
 * and catalog so a configuration change reaches the next request.
 */
export class CommandCodeAdapter extends LlmAdapter {
  constructor(private readonly config: CommandCodeAdapterOptions) {
    super()
  }

  private modelOf(provider: string, model: string): CommandCodeModel {
    const found = this.config.catalog().find((entry) => entry.id === model)
    if (found === undefined) {
      throw new LlmError(`Command Code provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return found
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.config.options().displayName }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.catalog().map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: [...inputModalitiesForModel(model.id)],
    })))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const resolved = this.modelOf(provider, model)
      return {
        provider,
        id: model,
        name: resolved.name,
        inputModalities: [...inputModalitiesForModel(resolved.id)],
        context: { contextWindow: resolved.contextWindow },
        // Command Code always sends max_tokens; the catalog cap is the request
        // default, exactly like the pi plugin's `max_tokens` behavior.
        defaultMaxTokens: resolved.maxTokens,
        ...reasoningInfo(resolved),
      }
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // One capture per stream call, taken before any await: the connection
    // facts, the credential, and the model descriptor all come from one
    // snapshot, so an in-flight request never observes a configuration change.
    const connection = this.config.options()
    const apiKey = await this.config.resolveApiKey(connection)
    const model = this.modelOf(options.provider, options.model)
    const modelLike = buildModelLike(model, options.provider)

    const containsImage = options.messages.some((message) => contentHasImage(message.content))
    if (containsImage && !modelSupportsImageInput(model.id)) {
      throw new LlmError(`Command Code model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
    }
    const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
    if (containsImage && attachments === undefined) {
      throw new LlmError('Command Code image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    const context = attachments === undefined
      ? toCommandCodeContext(options)
      : await toCommandCodeContext(options, attachments)

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    const streamCommandCode = createStreamCommandCode({
      createStream: () => createAssistantMessageEventStream(),
      calculateCost: calculateCommandCodeCost,
      apiBase: connection.baseURL,
    })
    const events = streamCommandCode(modelLike, context, {
      ...apiKey === undefined ? {} : { apiKey },
      ...options.reasoningEffort === undefined ? {} : { reasoning: options.reasoningEffort },
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      ...connection.timeoutMs === undefined ? {} : { timeoutMs: connection.timeoutMs },
      signal: watchdog.signal,
      headers: {
        ...attributionHeaders(),
      },
    })

    const iterator = toStreamChunks(events, model.contextWindow)[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
        if (timeout !== undefined) throw timeout
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`Command Code stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('Command Code request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`Command Code API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('Command Code stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return(undefined)
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }
}
