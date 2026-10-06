import { describe, expect, it, vi } from 'vitest'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import { createStreamCommandCode, DEFAULT_API_BASE } from '../src/core.ts'
import { thinkingMetadataForModel } from '../src/models.ts'
import { calculateCommandCodeCost } from '../src/cost.ts'
import type { CoreDependencies, ContextLike, ModelLike, StreamOptions } from '../src/types.ts'

function sseResponse(lines: readonly string[], status = 200, extraHeaders: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(line + '\n'))
      controller.close()
    },
  })
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream', ...extraHeaders } })
}

function model(id = 'deepseek/deepseek-v4-flash'): ModelLike {
  return {
    id,
    api: 'commandcode-custom',
    provider: 'commandcode',
    maxTokens: 65_536,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    ...(thinkingMetadataForModel(id) ?? {}),
  }
}

function deps(overrides: Partial<CoreDependencies> = {}): CoreDependencies {
  return {
    createStream: () => createAssistantMessageEventStream(),
    calculateCost: calculateCommandCodeCost,
    // Hermetic credential resolution: without these the plugin would read the
    // developer's own environment and ~/.commandcode/auth.json, which changes
    // what each test observes.
    env: {},
    authPaths: [],
    ...overrides,
  }
}

async function collect(d: CoreDependencies, m: ModelLike, ctx: ContextLike, opts?: StreamOptions) {
  const stream = createStreamCommandCode(d)(m, ctx, opts)
  const events: AssistantMessageEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

const textTurn = [
  'data: {"type":"text-delta","text":"Hello"}',
  'data: {"type":"text-delta","text":" world"}',
  'data: {"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":10,"outputTokens":5}}',
]

describe('createStreamCommandCode', () => {
  it('streams text deltas and a done event with usage', async () => {
    const events = await collect(
      deps({ fetchImpl: async () => sseResponse(textTurn) }),
      model(),
      { systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'user_key' },
    )
    const types = events.map((e: { type: string }) => e.type)
    expect(types).toEqual(['start', 'text_start', 'text_delta', 'text_delta', 'text_end', 'done'])
    const done = events.at(-1)
    if (done?.type !== 'done') throw new Error('expected done')
    expect(done.message.stopReason).toBe('stop')
    expect(done.message.usage).toMatchObject({ input: 10, output: 5, totalTokens: 15 })
    expect(done.message.provider).toBe('commandcode')
  })

  it('emits thinking blocks for reasoning events and never mixes them into text', async () => {
    const lines = [
      'data: {"type":"reasoning-start"}',
      'data: {"type":"reasoning-delta","text":"think"}',
      'data: {"type":"reasoning-delta","text":"ing"}',
      'data: {"type":"reasoning-end"}',
      'data: {"type":"text-delta","text":"answer"}',
      'data: {"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":2,"outputTokens":3}}',
    ]
    const events = await collect(deps({ fetchImpl: async () => sseResponse(lines) }), model(), { messages: [] }, { apiKey: 'user_key' })
    const types = events.map((e: { type: string }) => e.type)
    expect(types).toContain('thinking_start')
    expect(types).toContain('thinking_delta')
    expect(types).toContain('thinking_end')
    const thinkingEnd = events.find((e: { type: string }) => e.type === 'thinking_end') as { content: string }
    expect(thinkingEnd.content).toBe('thinking')
  })

  it('emits tool calls with paired finish reason', async () => {
    const lines = [
      'data: {"type":"tool-call","toolCallId":"c1","toolName":"fs_read","input":{"path":"a.txt"}}',
      'data: {"type":"finish","finishReason":"tool-calls","totalUsage":{"inputTokens":1,"outputTokens":2}}',
    ]
    const events = await collect(deps({ fetchImpl: async () => sseResponse(lines) }), model(), { messages: [] }, { apiKey: 'user_key' })
    const toolEnd = events.find((e: { type: string }) => e.type === 'toolcall_end') as { toolCall: { id: string; name: string; arguments: Record<string, unknown> } }
    expect(toolEnd.toolCall).toEqual({ type: 'toolCall', id: 'c1', name: 'fs_read', arguments: { path: 'a.txt' } })
    const done = events.at(-1)
    if (done?.type !== 'done') throw new Error('expected done')
    expect(done.message.stopReason).toBe('toolUse')
  })

  it('converts in-stream provider errors to error events with redaction', async () => {
    const lines = ['data: {"type":"error","error":{"message":"authentication failed user_abc12345"}}']
    const events = await collect(deps({ fetchImpl: async () => sseResponse(lines) }), model(), { messages: [] }, { apiKey: 'user_key' })
    const err = events.at(-1) as { type: string; error: { stopReason: string; errorMessage: string } }
    expect(err.type).toBe('error')
    expect(err.error.stopReason).toBe('error')
    expect(err.error.errorMessage).not.toContain('user_abc12345')
  })

  it('reports a missing key as an error event', async () => {
    const events = await collect(deps({ fetchImpl: vi.fn() }), model(), { messages: [] })
    const err = events.at(-1) as { type: string; error: { errorMessage: string } }
    expect(err.type).toBe('error')
    expect(err.error.errorMessage).toContain('No Command Code API key')
  })

  it('sends the documented headers, body, and reasoning_effort mapping', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} }
      return sseResponse(textTurn)
    }
    const m = model()
    const events = await collect(deps({ fetchImpl: fetchImpl as typeof fetch }), m, {
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'f', description: 'd', parameters: { type: 'object' } }],
    }, { apiKey: 'user_key', reasoning: 'max' })
    expect(events.at(-1)?.type).toBe('done')

    expect(captured?.url).toBe(`${DEFAULT_API_BASE}/alpha/generate`)
    const headers = captured?.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer user_key')
    expect(headers['x-command-code-version']).toBe('1.15.1')
    expect(headers['x-cli-environment']).toBe('production')
    expect(headers['x-project-slug']).toBeDefined()

    const body = JSON.parse(String(captured?.init.body)) as {
      config: { workingDir: string }
      params: { model: string; messages: unknown[]; tools: unknown[]; system: string; max_tokens: number; reasoning_effort?: string }
    }
    expect(body.params.model).toBe(m.id)
    expect(body.params.system).toBe('sys')
    expect(body.params.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(body.params.tools).toHaveLength(1)
    expect(body.params.max_tokens).toBe(64_000) // min(model.maxTokens, 64000) — capped below
    expect(body.params.reasoning_effort).toBe('max')
    expect(body.config.workingDir).toBeDefined()
  })

  it('caps max_tokens at 64000 and omits unsupported reasoning levels', async () => {
    let captured: { init: RequestInit } | undefined
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      captured = { init: init ?? {} }
      return sseResponse(textTurn)
    }
    const m = { ...model(), maxTokens: 1_000_000 }
    await collect(deps({ fetchImpl: fetchImpl as typeof fetch }), m, { messages: [] }, { apiKey: 'user_key', reasoning: 'minimal' })
    const body = JSON.parse(String(captured?.init.body)) as { params: { max_tokens: number; reasoning_effort?: string } }
    expect(body.params.max_tokens).toBe(64_000)
    expect(body.params.reasoning_effort).toBeUndefined()
  })

  it('retries transient HTTP errors when retries remain', async () => {
    const calls: { status: number }[] = []
    const fetchImpl = async (_url: string | URL | Request, _init?: RequestInit) => {
      const next = calls.length === 0 ? 429 : 200
      calls.push({ status: next })
      return next === 429
        ? new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } })
        : sseResponse(textTurn)
    }
    const events = await collect(
      deps({ fetchImpl: fetchImpl as typeof fetch }),
      model(),
      { messages: [] },
      { apiKey: 'user_key', maxRetries: 1 },
    )
    expect(calls).toHaveLength(2)
    expect(events.at(-1)?.type).toBe('done')
  })

  it('aborts before the request with an aborted error event', async () => {
    const controller = new AbortController()
    controller.abort()
    const events = await collect(deps({ fetchImpl: async () => sseResponse(textTurn) }), model(), { messages: [] }, { apiKey: 'user_key', signal: controller.signal })
    const err = events.at(-1) as { type: string; error: { stopReason: string } }
    expect(err.type).toBe('error')
    expect(err.error.stopReason).toBe('aborted')
  })

  it('times out a hanging request', async () => {
    const fetchImpl = (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
    const events = await collect(
      deps({ fetchImpl: fetchImpl as typeof fetch }),
      model(),
      { messages: [] },
      { apiKey: 'user_key', timeoutMs: 60 },
    )
    const err = events.at(-1) as { type: string; error: { errorMessage: string } }
    expect(err.type).toBe('error')
    expect(err.error.errorMessage).toContain('timed out')
  })
})
