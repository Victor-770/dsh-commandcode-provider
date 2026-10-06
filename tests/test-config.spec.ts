import { describe, expect, it } from 'vitest'
import { isVolatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'
import { Config, plainConfig, resolveCatalog, resolveOptions, DEFAULT_API_KEY_ENV } from '../src/config.ts'
import type { Options } from '../src/config.ts'

const env = { get: (name: string) => name === 'COMMANDCODE_API_BASE' ? { value: 'https://gateway.example' } : undefined }

/** Parse raw config exactly as the loader does before calling `apply`. */
function parse(raw: Record<string, unknown>): Config {
  const [parsed] = z.resolve(raw as never, Config, {})
  if (parsed === undefined) throw new Error('schema resolution produced no value')
  return parsed
}

describe('Config schema', () => {
  it('resolves every field to a live reference, and never the config itself', () => {
    const parsed = parse({ displayName: 'Mine', modelsUrl: 'https://gateway.example/models' })
    // A root-level `.volatile()` would make the whole config one reference and
    // hand `apply` a `Volatile<Config>`, where every field read is undefined.
    expect(isVolatile(parsed)).toBe(false)
    for (const [field, value] of Object.entries(parsed)) {
      expect(isVolatile(value), `field ${field}`).toBe(true)
    }
  })

  it('plainConfig reads the current value behind each reference', () => {
    const parsed = parse({ displayName: 'Mine', timeoutMs: 1234, models: [{ id: 'm1' }] })
    const resolved = resolveOptions(plainConfig(parsed), undefined, 'cache.json')
    expect(resolved.displayName).toBe('Mine')
    expect(resolved.timeoutMs).toBe(1234)
    expect(resolved.catalogOverrides.size).toBe(1)
  })

  it('plainConfig omits absent snapshot values instead of passing undefined', () => {
    expect(plainConfig(parse({}))).not.toHaveProperty('displayName')
  })
})

describe('resolveOptions', () => {
  it('applies defaults and environment overrides', () => {
    const resolved = resolveOptions({}, env, 'C:\\dsh\\commandcode-models.json')
    expect(resolved.apiKeyEnv).toBe(DEFAULT_API_KEY_ENV)
    expect(resolved.displayName).toBe('Command Code')
    expect(resolved.baseURL).toBe('https://gateway.example')
    expect(resolved.modelsUrl).toBe('https://api.commandcode.ai/provider/v1/models')
    expect(resolved.modelsTimeoutMs).toBe(10_000)
    expect(resolved.modelsCachePath).toBe('C:\\dsh\\commandcode-models.json')
    expect(resolved.defaultContextWindow).toBe(262_144)
    expect(resolved.defaultMaxTokens).toBe(32_768)
    expect(resolved.streamIdleTimeoutMs).toBe(300_000)
    expect(resolved.catalogOverrides.size).toBe(0)
  })

  it('prefers explicit config over environment', () => {
    const config: Options = {
      apiKeyEnv: 'CC_KEY',
      displayName: 'My Command Code',
      baseURL: 'https://x.example',
      modelsUrl: 'https://y.example/models',
      timeoutMs: 5000,
      defaultContextWindow: 128_000,
    }
    const resolved = resolveOptions(config, env, 'cache.json')
    expect(resolved.apiKeyEnv).toBe('CC_KEY')
    expect(resolved.displayName).toBe('My Command Code')
    expect(resolved.baseURL).toBe('https://x.example')
    expect(resolved.modelsUrl).toBe('https://y.example/models')
    expect(resolved.timeoutMs).toBe(5000)
    expect(resolved.defaultContextWindow).toBe(128_000)
  })

  it('rejects invalid bounds', () => {
    expect(() => resolveOptions({ defaultContextWindow: 0 }, undefined, 'c')).toThrow(/defaultContextWindow/)
    expect(() => resolveOptions({ defaultMaxTokens: -1 }, undefined, 'c')).toThrow(/defaultMaxTokens/)
    expect(() => resolveOptions({ timeoutMs: 0 }, undefined, 'c')).toThrow(/timeoutMs/)
    expect(() => resolveOptions({ streamIdleTimeoutMs: -5 }, undefined, 'c')).toThrow(/streamIdleTimeoutMs/)
    expect(() => resolveOptions({ models: [{ id: 'a' }, { id: 'a' }] }, undefined, 'c')).toThrow(/duplicate/)
    expect(() => resolveOptions({ models: [{ id: '' }] }, undefined, 'c')).toThrow(/non-empty/)
  })
})

describe('resolveCatalog', () => {
  const base = resolveOptions({}, undefined, 'c')

  it('returns the discovered catalog untouched by default', () => {
    const discovered = [{ id: 'm1', name: 'M1 (CC)', reasoning: true, contextWindow: 100_000, maxTokens: 65_536 }]
    expect(resolveCatalog(discovered, base)).toEqual(discovered)
  })

  it('merges overrides by id and fills default capacities', () => {
    const opts = resolveOptions({
      models: [
        { id: 'm1', name: 'Renamed', contextWindow: 200_000 },
        { id: 'm2', maxTokens: 4096 },
      ],
    }, undefined, 'c')
    const out = resolveCatalog([
      { id: 'm1', name: 'M1 (CC)', reasoning: true, contextWindow: 100_000, maxTokens: 65_536 },
    ], opts)
    const m1 = out.find((m) => m.id === 'm1')
    const m2 = out.find((m) => m.id === 'm2')
    expect(m1).toMatchObject({ name: 'Renamed', contextWindow: 200_000, maxTokens: 65_536 })
    expect(m2).toMatchObject({ name: 'm2', maxTokens: 4096, contextWindow: 262_144 })
  })
})
