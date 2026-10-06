import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { apply, name, inject, PROVIDER, defaultModelsCachePath } from '../index.ts'
import { Config } from '../src/config.ts'
import { CommandCodeCatalog } from '../src/runtime.ts'

/**
 * Parse raw config exactly as the loader does before it calls `apply`: the
 * schema's own output, where every field is a live reference.
 */
function parse(raw: Record<string, unknown>): Config {
  const [parsed] = z.resolve(raw as never, Config, {})
  if (parsed === undefined) throw new Error('schema resolution produced no value')
  return parsed
}

/**
 * Commit `raw` into a running config the way `Entry._commitVolatile` does after
 * a settings write: same references, new contents.
 */
function commitSettings(config: Config, raw: Record<string, unknown>): void {
  const candidate = parse(raw)
  for (const key of Object.keys(candidate) as (keyof Config)[]) {
    updateVolatile(config[key] as Volatile<unknown>, candidate[key] as Volatile<unknown>)
  }
}

/**
 * Boot the plugin against a stub ctx to prove the full wiring path: provider
 * route registration, configurable-provider directory, model discovery, command
 * registration, and the live-settings refresh hook all mount without throwing.
 */
function stubContext() {
  const registrations: { providers: string[]; adapter: unknown; replace: ReturnType<typeof vi.fn> }[] = []
  const directory: { displayName: string }[] = []
  const discovery: { ns: string; fn: unknown }[] = []
  const commands: { name: string }[] = []
  const listeners = new Map<string, (() => void)[]>()
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }

  const ctx: any = {
    logger,
    on: (event: string, listener: () => void) => {
      listeners.set(event, [...listeners.get(event) ?? [], listener])
      return () => {}
    },
    get: (key: string) => {
      if (key === 'credentials') return {
        resolve: async () => ({ value: 'user_stub_key', source: 'file' }),
        set: vi.fn(),
      }
      if (key === 'commands') return { register: (def: { name: string }) => { commands.push(def) } }
      if (key === 'attachments') return undefined
      if (key === 'userQuestions') return undefined
      if (key === 'launchEnvironment') return undefined
      return undefined
    },
    llm: {
      registerAdapter: (providers: string[], adapter: unknown) => {
        const replace = vi.fn()
        registrations.push({ providers, adapter, replace })
        const handle: any = () => {}
        handle.replace = replace
        return handle
      },
      registerConfigurableProviders: (entries: unknown[]) => {
        directory.push(...(entries as { displayName: string }[]))
        const handle: any = () => {}
        handle.replace = (next: unknown[]) => { directory.length = 0; directory.push(...(next as { displayName: string }[])) }
        return handle
      },
      registerModelDiscovery: (ns: string, fn: unknown) => {
        discovery.push({ ns, fn })
        return () => {}
      },
    },
  }
  const emit = (event: string): void => {
    for (const listener of listeners.get(event) ?? []) listener()
  }
  return { ctx, registrations, directory, discovery, commands, emit }
}

describe('dsh-commandcode-provider plugin entry', () => {
  beforeEach(() => {
    // No test in this file may reach the network: the catalog refresh is the
    // only outbound call the plugin makes while mounting.
    vi.spyOn(CommandCodeCatalog.prototype, 'refresh')
      .mockResolvedValue({ refreshed: false, source: 'cache', modelCount: 0 })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('declares its identity', () => {
    expect(name).toBe('commandcode-provider')
    expect(inject).toContain('llm')
    expect(PROVIDER).toBe('commandcode')
  })

  it('registers the provider route, directory entry, discovery, and commands', () => {
    const { ctx, registrations, directory, discovery, commands } = stubContext()
    apply(ctx, parse({}))
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.providers).toEqual(['commandcode'])
    expect(directory).toEqual([
      { provider: 'commandcode', displayName: 'Command Code', settingsNs: 'commandcode-provider', settingsPath: [] },
    ])
    expect(discovery).toHaveLength(1)
    expect(discovery[0]?.ns).toBe('commandcode-provider')
    const names = commands.map((c) => c.name).sort()
    expect(names).toEqual(['commandcode-refresh', 'commandcode-setkey', 'commandcode-status'])
  })

  it('serves the configured settings rather than the schema defaults', () => {
    const { ctx, directory, discovery } = stubContext()
    apply(ctx, parse({
      displayName: 'My Command Code',
      baseURL: 'https://gateway.example',
      modelsUrl: 'https://gateway.example/models',
      timeoutMs: 1234,
      models: [{ id: 'm1', contextWindow: 8192 }],
    }))
    expect(directory[0]?.displayName).toBe('My Command Code')
    expect(discovery[0]?.ns).toBe('commandcode-provider')
  })

  it('refreshes registration, catalog, and directory facts on a live settings update', () => {
    const { ctx, registrations, directory, emit } = stubContext()
    const reconfigure = vi.spyOn(CommandCodeCatalog.prototype, 'reconfigure')
    const config = parse({ displayName: 'First', modelsUrl: 'https://first.example/models' })
    apply(ctx, config)
    expect(directory[0]?.displayName).toBe('First')
    reconfigure.mockClear()

    // The loader commits a settings-only change in place and emits
    // `loader/volatile-update`; `apply` is never called again.
    commitSettings(config, {
      displayName: 'Second',
      modelsUrl: 'https://second.example/models',
      retryPolicy: { mode: 'normal', maxRetries: 9 },
    })
    emit('loader/volatile-update')

    expect(directory[0]?.displayName).toBe('Second')
    expect(reconfigure).toHaveBeenCalledTimes(1)
    expect(registrations[0]?.replace).toHaveBeenCalledWith(['commandcode'])
  })

  it('keeps the route registration when only the display name changes', () => {
    const { ctx, registrations, emit } = stubContext()
    const reconfigure = vi.spyOn(CommandCodeCatalog.prototype, 'reconfigure')
    const config = parse({ displayName: 'First' })
    apply(ctx, config)
    reconfigure.mockClear()

    commitSettings(config, { displayName: 'Second' })
    emit('loader/volatile-update')

    expect(registrations[0]?.replace).not.toHaveBeenCalled()
    expect(reconfigure).not.toHaveBeenCalled()
  })

  it('refuses an invalid composition entry', () => {
    const { ctx } = stubContext()
    expect(() => apply(ctx, { defaultContextWindow: -5 } as unknown as Config)).toThrow(/defaultContextWindow/)
  })

  it('computes the default cache path under the DSH home', () => {
    expect(defaultModelsCachePath()).toMatch(/commandcode-models\.json$/)
  })
})
