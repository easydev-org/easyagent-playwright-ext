// End-to-end against a real headless Chromium (raw CDP) + a real nats-server:
// create -> navigate -> snapshot -> screenshot -> close. Skipped when either
// the browser or the broker is unavailable (CI without a browser skips it).
import { type Bus, Agent, connect, newID } from '@easydev-org/easybus-sdk'
import { afterAll, describe, expect, it } from 'vitest'
import { servePlaywright } from '../src/serve.js'
import { startChrome, startNats } from './helpers.js'

const nats = await startNats()
const chrome = await startChrome()
if (!nats || !chrome) console.warn('[live-e2e] no nats-server/chromium; skipping')

/** A minimal stand-in for easyagent's file service: it stores the object the
 *  extension put and returns a canonical file code + derived mime. */
async function stubFileAgent(bus: Bus, tenant: string): Promise<{ close: () => Promise<void> }> {
  const sub = await bus.subscribe(AbortSignal.timeout(120_000), `easybus.${tenant}.file.ingest`)
  void (async () => {
    for (;;) {
      const env = await sub.next(AbortSignal.timeout(60_000)).catch(() => null)
      if (!env || !env.replyTo) continue
      const code = newID().replace(/-/g, '').slice(0, 16)
      await bus
        .publish(AbortSignal.timeout(5000), env.replyTo, { ok: true, code, mime: 'image/png' }, { tenant })
        .catch(() => {})
    }
  })()
  return { close: () => sub.close() }
}

describe.skipIf(!nats || !chrome)('live e2e: extension against a CDP browser', () => {
  const stops: Array<() => Promise<void> | void> = []
  afterAll(async () => {
    // LIFO: extension/bus before the broker/browser.
    for (const s of stops.reverse()) {
      await Promise.race([Promise.resolve(s()), new Promise(r => setTimeout(r, 3000))])
    }
  }, 30_000)

  it(
    'create -> navigate -> snapshot -> screenshot -> close',
    async () => {
      const url = nats!.url
      const bus = await connect(url)
      const file = await stubFileAgent(bus, 't1')
      const { stop } = await servePlaywright({
        natsUrl: url,
        extension: {
          target: { kind: 'cdp', endpoint: chrome!.endpoint },
          viewport: { width: 1280, height: 720 },
          ignoreHttpsErrors: true,
          idleTimeoutMs: 0,
          maxContexts: 4,
          defaultTimeoutMs: 20_000,
        },
      })
      stops.push(stop, () => file.close(), () => bus.close(), () => chrome!.stop(), () => nats!.stop())

      const agent = new Agent(bus)
      const call = async (tool: string, args: Record<string, unknown>) => {
        const r = await agent.callTool(
          AbortSignal.timeout(30_000),
          't1',
          'sess-e2e',
          'playwright',
          tool,
          `c-${Math.random()}`,
          args,
        )
        if (r.error) throw new Error(`${tool}: ${JSON.stringify(r.error)}`)
        return r
      }

      const created = await call('browser-create-context', {})
      const cid = (created.data as { context_id?: string } | null)?.context_id
      expect(cid).toMatch(/^[0-9a-f-]{36}$/)

      await call('browser-navigate', {
        context_id: cid,
        url: 'data:text/html,<h1>E2E-OK</h1><button>Go</button>',
      })
      const snap = await call('browser-snapshot', { context_id: cid })
      expect(snap.content).toContain('E2E-OK')

      const shot = await call('browser-take-screenshot', { context_id: cid })
      const files = (shot.data as { files?: Array<{ code?: string; mime?: string }> } | null)?.files ?? []
      expect(files[0]?.code).toMatch(/^[0-9a-f]{16}$/)
      expect(files[0]?.mime).toBe('image/png')

      // Explicit close.
      await call('browser-close-context', { context_id: cid })
      // A second close of the same id must fail (unknown context).
      await expect(call('browser-close-context', { context_id: cid })).rejects.toThrow()
    },
    120_000,
  )
})
