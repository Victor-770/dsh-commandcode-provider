import { describe, expect, it, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import {
  buildModelLike,
  CommandCodeAdapter,
  mapStopReason,
  mapUsage,
  toCommandCodeContext,
  toStreamChunks,
} from '../src/adapter.ts'
import { resolveOptions } from '../src/config.ts'
import type { CommandCodeModel } from '../src/models.ts'

const MODEL: CommandCodeModel = {
  id: 'deepseek/deepseek-v4-flash',
  name: 'DeepSeek V4 Flash (CC)',
  reasoning: true,
  contextWindow: 200_000,
  maxTokens: 65_536,
}

const CATALOG: CommandCodeModel[] = [MODEL, { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (CC)', reasoning: true, contextWindow: 400_000, maxTokens: 65_536 }]

function options() {
  return resolveOptions({}, undefined, 'cache.json')
}

function makeAdapter(overrides: { apiKey?: string; fetchImpl?: typeof fetch } = {}) {
  return new CommandCodeAdapter({
    options,
    catalog: () => CATALOG,
    resolveApiKey: async () => overrides.apiKey ?? 'user_key',
    resolveAttachments: () => undefined,
  })
}

function request(model = MODEL.id): GenerateOptions {
  return {
    provider: 'commandcode',
    model,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] } as never,
    ],
    system: 'sys',
  } as unknown as GenerateOptions
}

async function chunks(adapter: CommandCodeAdapter, req: GenerateOptions, fetchImpl: typeof fetch): Promise<StreamChunk[]> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const out: StreamChunk[] = []
    for await (const chunk of adapter.stream(req)) out.push(chunk)
    return out
  } finally {
    globalThis.fetch = originalFetch
  }
}

function sseResponse(lines: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(line + '\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('toCommandCodeContext', () => {
  it('converts harness history to the Command Code message vocabulary', () => {
    const ctx = toCommandCodeContext({
      provider: 'commandcode',
      model: 'm',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'be brief' }] } as never,
        { role: 'user', content: [{ type: 'text', text: 'hello' }] } as never,
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'ok' },
            { type: 'tool-call', id: 'c1', name: 'fs_read', arguments: '{"path":"a"}' },
          ],
        } as never,
        {
          // A tool result is its own `role: 'tool'` message in the 0.2 seam,
          // not a `tool-result` block nested in a user message.
          role: 'tool',
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'body' }],
          isError: false,
        } as never,
      ],
    } as unknown as GenerateOptions)
    const messages = ctx.messages ?? []
    expect(messages).toHaveLength(4)
    expect(messages[0]).toEqual({ role: 'user', content: 'be brief' })
    expect(messages[1]).toEqual({ role: 'user', content: 'hello' })
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }, { type: 'toolCall', id: 'c1', name: 'fs_read', arguments: { path: 'a' } }],
    })
    expect(messages[3]).toMatchObject({ role: 'toolResult', toolCallId: 'c1', toolName: 'fs_read', content: [{ type: 'text', text: 'body' }] })
  })
})

describe('buildModelLike', () => {
  it('carries cost, reasoning, and thinking metadata', () => {
    const m = buildModelLike(MODEL, 'commandcode')
    expect(m.provider).toBe('commandcode')
    expect(m.reasoning).toBe(true)
    expect(m.thinking?.efforts).toEqual(['high', 'max'])
    expect(m.cost).toBeDefined()
    expect(m.maxTokens).toBe(65_536)
  })
})

describe('mapUsage / mapStopReason', () => {
  it('maps disjoint token counts', () => {
    expect(mapUsage({ input: 5, output: 3, cacheRead: 2, cacheWrite: 1 })).toEqual({
      inputTokens: 5,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    })
    expect(mapUsage({ input: 5, output: 3, cacheRead: 0, cacheWrite: 0 })).toEqual({ inputTokens: 5, outputTokens: 3 })
  })

  it('classifies context overflow errors', () => {
    const reason = mapStopReason({ stopReason: 'error', errorMessage: 'Context window exceeded', usage: { input: 0, output: 0 } })
    expect(reason).toMatchObject({ kind: 'error' })
    if (reason.kind === 'error') {
      expect(reason.failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    }
  })

  it('classifies auth and rate-limit errors', () => {
    const auth = mapStopReason({ stopReason: 'error', errorMessage: '401 Unauthorized', usage: { input: 0, output: 0 } })
    if (auth.kind === 'error') expect(auth.failure.code).toBe('AUTH')
    const rate = mapStopReason({ stopReason: 'error', errorMessage: '429 rate limit', usage: { input: 0, output: 0 } })
    if (rate.kind === 'error') expect(rate.failure.code).toBe('RATE_LIMIT')
  })

  it('maps length with full-window usage to overflow', () => {
    const reason = mapStopReason({ stopReason: 'length', usage: { input: 150_000, output: 50_000 } }, 200_000)
    if (reason.kind === 'error') expect(reason.failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    const plain = mapStopReason({ stopReason: 'length', usage: { input: 10, output: 10 } }, 200_000)
    expect(plain).toEqual({ kind: 'max-tokens' })
  })
})

describe('toStreamChunks', () => {
  it('translates a full event turn into chunks', async () => {
    const events = createAssistantMessageEventStream()
    events.push({ type: 'start', partial: { role: 'assistant', content: [], api: 'x', provider: 'commandcode', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 0 } })
    events.push({ type: 'text_start', contentIndex: 0, partial: { role: 'assistant', content: [], api: 'x', provider: 'commandcode', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 0 } })
    events.push({ type: 'text_delta', contentIndex: 0, delta: 'hi', partial: { role: 'assistant', content: [], api: 'x', provider: 'commandcode', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 0 } })
    events.push({ type: 'text_end', contentIndex: 0, content: 'hi', partial: { role: 'assistant', content: [], api: 'x', provider: 'commandcode', model: 'm', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 0 } })
    events.push({ type: 'done', reason: 'stop', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], api: 'x', provider: 'commandcode', model: 'm', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 0 } })
    events.end()
    const out: StreamChunk[] = []
    for await (const chunk of toStreamChunks(events, 200_000)) out.push(chunk)
    expect(out.map((c) => c.type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
    const finish = out.at(-1)
    expect(finish?.type === 'finish' ? finish.reason : null).toEqual({ kind: 'stop' })
  })

  it('throws STREAM_CLOSED when the source ends without a terminal event', async () => {
    const events = createAssistantMessageEventStream()
    events.end()
    await expect((async () => {
      for await (const _chunk of toStreamChunks(events)) { void _chunk }
    })()).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})

describe('CommandCodeAdapter', () => {
  it('describes provider info and models', async () => {
    const adapter = makeAdapter()
    expect(adapter.providerInfo('commandcode')).toEqual({ id: 'commandcode', name: 'Command Code' })
    const models = await adapter.listModels('commandcode')
    expect(models.map((m) => m.id)).toEqual(['deepseek/deepseek-v4-flash', 'claude-sonnet-4-6'])
    expect(models[0]?.inputModalities).toEqual(['text'])
    expect(models[1]?.inputModalities).toEqual(['text', 'image'])
  })

  it('resolves model metadata with reasoning and context', async () => {
    const adapter = makeAdapter()
    const info = await adapter.resolveModel('commandcode', MODEL.id)
    expect(info.name).toBe(MODEL.name)
    expect(info.context?.contextWindow).toBe(200_000)
    expect(info.defaultMaxTokens).toBe(65_536)
    expect(info.reasoning?.efforts.map((e) => e.id)).toEqual(['high', 'max'])
    expect(info.reasoning?.efforts[0]?.name).toBe('High')
  })

  it('rejects unknown models', async () => {
    const adapter = makeAdapter()
    await expect(adapter.resolveModel('commandcode', 'nope')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
  })

  it('streams a full request to completion', async () => {
    const fetchImpl = async () => sseResponse([
      'data: {"type":"text-delta","text":"Hi there"}',
      'data: {"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":3,"outputTokens":2}}',
    ])
    const adapter = makeAdapter({ apiKey: 'user_key' })
    const out = await chunks(adapter, request(), fetchImpl)
    const text = out.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    expect(text).toBe('Hi there')
    const finish = out.find((c) => c.type === 'finish')
    expect(finish?.type === 'finish' ? finish.reason : null).toEqual({ kind: 'stop' })
  })

  it('rejects image content for a text-only model before any request', async () => {
    const fetchImpl = vi.fn()
    const adapter = makeAdapter()
    const req = {
      provider: 'commandcode',
      model: MODEL.id,
      messages: [{ role: 'user', content: [{ type: 'image' }] }] as never,
    } as unknown as GenerateOptions
    await expect(chunks(adapter, req, fetchImpl)).rejects.toThrow(/does not support image input/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('surfaces missing credentials as MISSING_CREDENTIAL', async () => {
    const adapter = new CommandCodeAdapter({
      options,
      catalog: () => CATALOG,
      resolveApiKey: async () => { throw new LlmError('no key', 'MISSING_CREDENTIAL') },
      resolveAttachments: () => undefined,
    })
    await expect(chunks(adapter, request(), async () => sseResponse([]))).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })
})
