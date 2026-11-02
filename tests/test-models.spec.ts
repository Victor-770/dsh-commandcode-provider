import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MODEL_MAX_OUTPUT_TOKENS,
  MODEL_REASONING,
  commandCodeModelsFromApiResponse,
  commandCodeModelsFromCache,
  getModelsTimeoutMs,
  inputModalitiesForModel,
  loadCommandCodeModels,
  modelSupportsImageInput,
  thinkingLevelMapForEfforts,
  thinkingMetadataForModel,
} from '../src/models.ts'

describe('commandCodeModelsFromApiResponse', () => {
  it('parses the provider list shape and enriches reasoning/modalities', () => {
    const models = commandCodeModelsFromApiResponse({
      object: 'list',
      data: [
        { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', context_length: 200_000 },
        { id: 'brand-new/model', name: 'Brand New', context_length: 128_000 },
      ],
    })
    expect(models).toEqual([
      { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash (CC)', reasoning: true, contextWindow: 200_000, maxTokens: 65_536 },
      { id: 'brand-new/model', name: 'Brand New (CC)', reasoning: false, contextWindow: 128_000, maxTokens: 65_536 },
    ])
  })

  it('rejects malformed responses', () => {
    expect(() => commandCodeModelsFromApiResponse({ object: 'other', data: [] })).toThrow(/object/)
    expect(() => commandCodeModelsFromApiResponse({ object: 'list' })).toThrow(/data/)
    expect(() => commandCodeModelsFromApiResponse({ object: 'list', data: [{}] })).toThrow(/id/)
    expect(() => commandCodeModelsFromApiResponse({ object: 'list', data: [{ id: 'x', name: 'y', context_length: 0 }] })).toThrow(/context_length/)
  })
})

describe('commandCodeModelsFromCache', () => {
  it('round-trips the cached shape and validates the version', () => {
    const models = [{ id: 'gpt-5.4', name: 'GPT 5.4 (CC)', reasoning: true, contextWindow: 400_000, maxTokens: 65_536 }]
    const cached = commandCodeModelsFromCache({ version: 1, models })
    expect(cached).toEqual(models)
    expect(() => commandCodeModelsFromCache({ version: 99, models })).toThrow(/version/)
    expect(() => commandCodeModelsFromCache({ version: 1, models: [] })).toThrow(/empty model catalog/)
  })
})

describe('reasoning metadata', () => {
  it('maps pi thinking levels to supported efforts', () => {
    expect(thinkingLevelMapForEfforts(['high', 'max'])).toEqual({
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max',
    })
    const meta = thinkingMetadataForModel('deepseek/deepseek-v4-flash')
    expect(meta?.thinking.efforts).toEqual(['off', 'high', 'max'])
    expect(meta?.thinking.mode).toBe('effort')
    expect(thinkingMetadataForModel('unknown/model')).toBeUndefined()
  })

  it('keeps reasoning-capable models that publish no selectable efforts', () => {
    expect(MODEL_REASONING['moonshotai/Kimi-K2.7-Code']).toBe(true)
    expect(thinkingMetadataForModel('moonshotai/Kimi-K2.7-Code')).toBeUndefined()
  })

  it('exposes the catalog image modalities', () => {
    expect(modelSupportsImageInput('claude-sonnet-4-6')).toBe(true)
    expect(modelSupportsImageInput('deepseek/deepseek-v4.1-flash-fast')).toBe(true)
    expect(modelSupportsImageInput('deepseek/deepseek-v4-flash')).toBe(false)
    expect(inputModalitiesForModel('unknown/model')).toEqual(['text'])
  })

  it('applies the advertised output-token caps', () => {
    expect(MODEL_MAX_OUTPUT_TOKENS['Qwen/Qwen3.8-Max-Prime']).toBe(131_072)
    const models = commandCodeModelsFromApiResponse({
      object: 'list',
      data: [
        { id: 'Qwen/Qwen3.8-Max-Prime', name: 'Qwen 3.8 Max Prime', context_length: 1_000_000 },
        { id: 'stealth/glyph-cluster:free', name: 'Glyph Cluster', context_length: 256_000 },
      ],
    })
    expect(models[0]?.maxTokens).toBe(131_072)
    expect(models[1]?.maxTokens).toBe(256_000)
    expect(commandCodeModelsFromCache({
      version: 1,
      models: [{ id: 'Qwen/Qwen3.8-Max-Prime', name: 'Qwen (CC)', reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536 }],
    })[0]?.maxTokens).toBe(131_072)
  })
})

describe('getModelsTimeoutMs', () => {
  it('parses env with fallback', () => {
    expect(getModelsTimeoutMs({})).toBe(10_000)
    expect(getModelsTimeoutMs({ COMMANDCODE_MODELS_TIMEOUT_MS: '5000' })).toBe(5000)
    expect(getModelsTimeoutMs({ COMMANDCODE_MODELS_TIMEOUT_MS: 'bogus' })).toBe(10_000)
    expect(getModelsTimeoutMs({ COMMANDCODE_MODELS_TIMEOUT_MS: '-1' })).toBe(10_000)
  })
})

describe('loadCommandCodeModels', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-models-'))
  const cachePath = join(dir, 'commandcode-models.json')

  it('fetches live, writes the cache, and falls back on failure', async () => {
    const response = {
      object: 'list',
      data: [{ id: 'a/model', name: 'A', context_length: 100_000 }],
    }
    const fetchImpl = async () => new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } })
    const live = await loadCommandCodeModels({ cachePath, fetchImpl })
    expect(live.source).toBe('live')
    expect(live.models).toHaveLength(1)
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).version).toBe(1)

    const failingFetch = async () => { throw new Error('network down') }
    const fallback = await loadCommandCodeModels({ cachePath, fetchImpl: failingFetch })
    expect(fallback.source).toBe('cache')
    expect(fallback.models).toHaveLength(1)
    expect(fallback.warning).toContain('cached catalog')
  })

  it('reports empty when neither live nor cache works', async () => {
    const failingFetch = async () => { throw new Error('network down') }
    const empty = await loadCommandCodeModels({ cachePath: join(dir, 'nope.json'), fetchImpl: failingFetch })
    expect(empty.source).toBe('empty')
    expect(empty.models).toEqual([])
    expect(empty.warning).toContain('remain unavailable')
  })

  it('honors abort', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(loadCommandCodeModels({
      cachePath,
      fetchImpl: async () => { throw new Error('never') },
      signal: controller.signal,
    })).rejects.toThrow()
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))
})
