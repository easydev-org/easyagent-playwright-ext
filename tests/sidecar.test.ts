import { describe, expect, it, vi } from 'vitest'
import { startSidecar } from '../src/sidecar.js'
import type { BrowserSession, ContextManager } from '../src/context-manager.js'

/**
 * The sidecar is a SEAM, so these tests are about the seam's contract rather than about browsers:
 *
 *  - a call routes to the named tool with the caller's arguments
 *  - the result's shape is what the Go side parses (content / data / file)
 *  - a failure distinguishes "your call was wrong" from "this process is broken", because Go maps
 *    those to different things the model can act on
 *
 * A FAKE MANAGER RATHER THAN A BROWSER. Chrome in a unit test would make this slow and flaky, and
 * every property above is about the boundary, not about Chromium.
 */

function fakeManager(overrides: Partial<ContextManager> = {}): ContextManager {
  const sessions = new Map<string, BrowserSession>()
  return {
    create: vi.fn(async (tenant: string, session: string) => {
      const id = `ctx-${sessions.size + 1}`
      sessions.set(id, { contextId: id, tenant, session, page: { isClosed: () => false } } as never)
      return id
    }),
    close: vi.fn(async (id: string) => {
      sessions.delete(id)
    }),
    get: vi.fn((id: string) => {
      const s = sessions.get(id)
      if (s === undefined) throw new Error(`unknown context_id ${id}`)
      return s
    }),
    withContext: vi.fn(async (id, _t, _s, fn) => {
      const s = sessions.get(id)
      if (s === undefined) throw new Error(`unknown context_id ${id}`)
      return fn(s)
    }),
    listForTenant: vi.fn(() => []),
    ...overrides,
  } as unknown as ContextManager
}

/** Start a sidecar on an ephemeral port and return its base URL. */
async function serve(
  manager: ContextManager,
): Promise<{ base: string; close: () => Promise<void> }> {
  // Port 0 would be ideal, but startSidecar reads SIDECAR_PORT; a random high port keeps tests
  // parallel-safe without changing the production code path to accept a port argument.
  const port = 19000 + Math.floor(Math.random() * 2000)
  process.env.SIDECAR_PORT = String(port)
  const s = startSidecar({ manager, defaultTimeoutMs: 5000 })
  // The listen callback is async; poll healthz rather than sleeping a fixed time.
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return { base, close: s.close }
    } catch {
      // not listening yet
    }
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('sidecar did not start')
}

/** POST /exec and return the parsed body. */
async function exec(base: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as Record<string, unknown>
}

describe('sidecar /exec', () => {
  it('creates a context and returns its id', async () => {
    const m = fakeManager()
    const { base, close } = await serve(m)
    try {
      const out = await exec(base, { tool: 'browser-create-context', tenant: 't1', session: 's1' })
      expect(out.ok).toBe(true)
      // THE ID MUST COME BACK: Go has nothing else to address the context with, and a create that
      // returns only text would make every following call fail with "context_id is required".
      expect(String(out.context_id)).toMatch(/^ctx-/)
      expect(m.create).toHaveBeenCalledWith('t1', 's1')
    } finally {
      await close()
    }
  })

  it('requires context_id for every tool except create', async () => {
    const { base, close } = await serve(fakeManager())
    try {
      const out = await exec(base, {
        tool: 'browser-navigate',
        tenant: 't1',
        session: 's1',
        args: {},
      })
      expect(out.ok).toBe(false)
      // INVALID_ARGUMENT, not internal: the caller forgot something, and Go turns this into a
      // result the model can fix rather than a failure it should report.
      expect(out.code).toBe('invalid_argument')
    } finally {
      await close()
    }
  })

  it('reports an unknown context as not_found', async () => {
    const { base, close } = await serve(fakeManager())
    try {
      const out = await exec(base, {
        tool: 'browser-navigate',
        context_id: 'nope',
        tenant: 't1',
        session: 's1',
        args: { url: 'https://example.com' },
      })
      expect(out.ok).toBe(false)
      // A REAPED CONTEXT IS ACTIONABLE ("create another"); a broken browser is not. Collapsing the
      // two would make a model retry something that can never work.
      expect(out.code).toBe('not_found')
    } finally {
      await close()
    }
  })

  it('rejects an unknown tool', async () => {
    const { base, close } = await serve(fakeManager())
    try {
      const out = await exec(base, {
        tool: 'browser-does-not-exist',
        context_id: 'c',
        tenant: 't',
        session: 's',
      })
      expect(out.ok).toBe(false)
      expect(out.code).toBe('not_found')
    } finally {
      await close()
    }
  })

  it('rejects a body that is not JSON', async () => {
    const { base, close } = await serve(fakeManager())
    try {
      const res = await fetch(`${base}/exec`, { method: 'POST', body: 'not json' })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('closes a context', async () => {
    const m = fakeManager()
    const { base, close } = await serve(m)
    try {
      const created = await exec(base, {
        tool: 'browser-create-context',
        tenant: 't1',
        session: 's1',
      })
      const id = String(created.context_id)
      const out = await exec(base, {
        tool: 'browser-close-context',
        context_id: id,
        tenant: 't1',
        session: 's1',
      })
      expect(out.ok).toBe(true)
      expect(m.close).toHaveBeenCalledWith(id, 't1', 's1')
    } finally {
      await close()
    }
  })
})
