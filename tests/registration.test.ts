import { connect, valueToJson } from '@easydev-org/easybus-sdk'
import { afterAll, describe, expect, it } from 'vitest'
import { servePlaywright } from '../src/serve.js'
import { pwTools } from '../src/tools/browser.js'
import { startNats } from './helpers.js'

/**
 * Registration smoke test: the extension must be discoverable over the bus and
 * advertise exactly the curated tool set (28 tools). Uses a real nats-server
 * (skipped when the binary is absent) — no external broker needed.
 */
const server = await startNats()
if (!server) console.warn('[registration] no nats-server; skipping')

describe.skipIf(!server)('playwright extension registration', () => {
  const stops: Array<() => Promise<void> | void> = []
  afterAll(async () => {
    // Best-effort teardown; a draining NATS connection can hang, so cap it.
    // LIFO: close the extension/bus before the broker.
    for (const s of stops.reverse()) {
      await Promise.race([Promise.resolve(s()), new Promise(r => setTimeout(r, 3000))])
    }
  }, 20_000)

  it('is discoverable and advertises the curated tools', async () => {
    const url = server!.url

    const { stop } = await servePlaywright({
      natsUrl: url,
      extension: {
        target: { kind: 'cdp', endpoint: 'http://127.0.0.1:9222' },
        viewport: null,
        ignoreHttpsErrors: true,
        idleTimeoutMs: 0,
        maxContexts: 4,
        defaultTimeoutMs: 30_000,
      },
    })
    stops.push(stop)

    const bus = await connect(url)
    stops.push(() => bus.close())

    let manifest: { id?: string; tools?: Array<{ name: string; description?: string; descriptions?: Record<string, string>; required_config?: string[]; input_schema?: { required?: string[] } }>; config?: Array<{ name: string }> } | null = null
    for (let i = 0; i < 5 && manifest === null; i++) {
      const replies = await bus.requestMany(AbortSignal.timeout(3000), 'easybus.discover', {}, { maxWaitMs: 800, tenant: 'global' })
      for (const env of replies) {
        const p = valueToJson(env.payload) as { id?: string }
        if (p && p.id === 'playwright') manifest = p as never
      }
    }
    expect(manifest).not.toBeNull()
    const names = (manifest?.tools ?? []).map(t => t.name).sort()

    // Exactly the curated set — no underscore names, no dropped wrappers.
    const expected = Object.keys(pwTools()).sort()
    expect(names).toEqual(expected)
    expect(names).toHaveLength(28)
    expect(names.every(n => /^[a-z0-9-]+$/.test(n))).toBe(true)

    // Required anchors.
    for (const n of [
      'browser-create-context',
      'browser-close-context',
      'browser-navigate',
      'browser-snapshot',
      'browser-take-screenshot',
      'browser-pdf-save',
      'browser-run-code-unsafe',
    ]) {
      expect(names).toContain(n)
    }
    // Dropped wrappers must NOT be advertised.
    for (const n of [
      'browser-mouse-click-xy',
      'browser-verify-text-visible',
      'browser-cookie-set',
      'browser-route',
      'browser-emulate-media',
    ]) {
      expect(names).not.toContain(n)
    }

    // Every non-create tool requires context_id.
    const navigate = (manifest?.tools ?? []).find(t => t.name === 'browser-navigate')
    expect(navigate?.input_schema?.required).toContain('context_id')

    // The manifest-driven metadata must survive intact: every tool carries a
    // description and a Chinese translation, and the config knob is exposed.
    for (const t of manifest?.tools ?? []) {
      expect(t.description, t.name).toBeTruthy()
      expect(t.descriptions?.zh, t.name).toBeTruthy()
      expect(t.required_config, t.name).toContain('selenium-url')
    }
    const knobNames = (manifest?.config ?? []).map(c => c.name)
    expect(knobNames).toContain('selenium-url')
    // Stop the broker LAST (teardown runs in reverse of registration).
    stops.push(() => server!.stop())
  })
})
