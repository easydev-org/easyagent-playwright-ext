/**
 * End-to-end against a REAL NATS and a REAL browser.
 *
 * There is no agent here, on purpose. A tool call is a request on
 * `easybus.<tenant>.tool.call.<extId>.<tool>`, so the test plays the agent's part with the SDK's
 * own client (`callTool` uses `request()`, which sets ReplyTo — the extension SILENTLY IGNORES a
 * call with no ReplyTo, so a hand-rolled `publish` would look like a timeout with no cause).
 *
 * Gated on E2E_NATS_URL: the unit suite has no services, and a test that fails for want of a
 * broker teaches people to ignore red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { connect, type Bus } from '@easydev-org/easybus-sdk'
import { Agent } from '@easydev-org/easybus-sdk/agent'

import { servePlaywright } from '../src/serve.js'
import { serveFakeAgentFiles } from './fake-agent.js'

const NATS_URL = process.env['E2E_NATS_URL'] ?? ''
const SELENIUM_URL = process.env['E2E_SELENIUM_URL'] ?? ''
const EXT_ID = 'playwright'
const TENANT = 'e2e'
const SESSION = 's-e2e'
const CTX = (ms: number): AbortSignal => AbortSignal.timeout(ms)

/**
 * Write one extension config value the way the agent does: a KV put in the `cfg` bucket under the
 * extension's own namespace.
 *
 * `Agent.setConfig` is not usable here — it requires the agent-side config authority to be running
 * — but the WATCH the extension uses reads exactly this key, so a direct put exercises the same
 * path an operator's save does.
 */
async function setConfig(bus: Bus, name: string, value: unknown): Promise<void> {
  await bus.kvPut(CTX(10_000), 'cfg', `t.${TENANT}.${EXT_ID}.${name}`, JSON.stringify(value), 0)
}

/**
 * Grants for the browser tools this test drives.
 *
 * Every browser tool is permission-gated, so a call with none fails with "permission denied:
 * browser.read (no grant held)" before the browser is touched. That is the extension working as
 * designed — the test carries the authorisations an operator would issue, it does not bypass them.
 */
function grants(contextId: string): Array<{ key: string; params?: Record<string, unknown> }> {
  return [
    { key: 'browser.read', params: { context: contextId } },
    { key: 'browser.drive', params: { context: contextId } },
    { key: 'browser.script', params: { context: contextId } },
  ]
}

// A page that needs no network: the CI runner has none, and a test that depends on example.com
// reports DNS failures as extension bugs.
const PAGE_URL =
  'data:text/html,<html><head><title>e2e-title</title></head>' +
  '<body><h1 id="h">hello-e2e</h1><a id="a" href="data:text/html,<html><body><p id=p>second</p></body></html>">go</a></body></html>'

describe.skipIf(!NATS_URL || !SELENIUM_URL)('playwright extension, live', () => {
  let stop: (() => Promise<void>) | undefined
  let bus: Bus
  let agent: Agent
  const agentAbort = new AbortController()

  beforeAll(async () => {
    // The extension under test: a real process-level instance, serving over the real broker.
    const served = await servePlaywright({
      natsUrl: NATS_URL,
      extension: {
        target: { kind: 'selenium', baseUrl: SELENIUM_URL, browserName: 'chrome', cdpTimeoutMs: 60_000 },
        viewport: { width: 1280, height: 800 },
        ignoreHttpsErrors: true,
        idleTimeoutMs: 300_000,
        maxContexts: 4,
        defaultTimeoutMs: 60_000,
      },
    })
    stop = served.stop
    bus = await connect(NATS_URL)
    agent = new Agent(bus)

    // Answer the ONE request this extension makes of the agent: `file.ingest`, which the screenshot
    // and PDF tools need because the agent owns the blob store. It reads the object the extension
    // wrote, so the reply is evidence rather than a canned value.
    await serveFakeAgentFiles(bus, TENANT, agentAbort.signal)

    // Every browser tool declares `required_config: [selenium-url]`, so without this every call is
    // refused before the browser is touched. Written the way the console writes it, and BEFORE the
    // first tool call: the extension picks it up from its config watch.
    await setConfig(bus, 'selenium-url', SELENIUM_URL)
    // The watch is asynchronous; give it a moment to apply rather than racing the first call.
    await new Promise(r => setTimeout(r, 1_500))
  }, 120_000)

  afterAll(async () => {
    agentAbort.abort()
    await stop?.()
    await bus?.close()
  })

  it('registers over discovery', async () => {
    const found = await agent.discover(CTX(20_000), 5_000)
    const ids = found.map(m => m.id)
    expect(ids, `discovered ${JSON.stringify(ids)}`).toContain(EXT_ID)
  }, 30_000)

  it('declares the browser tools it documents', async () => {
    const found = await agent.discover(CTX(20_000), 5_000)
    const mine = found.find(m => m.id === EXT_ID)
    expect(mine).toBeDefined()
    // The manifest's `tools` is an ARRAY of specs, not a map keyed by name — Object.keys on it
    // yields "0","1","2"… which passes a length check and says nothing about the names.
    const names = (mine?.tools ?? []).map(t => String((t as { name?: unknown }).name ?? ''))
    // The manifest is the contract an agent renders; if these disappear, every prompt that
    // mentions them silently stops working.
    for (const want of [
      'browser-create-context',
      'browser-close-context',
      'browser-navigate',
      'browser-snapshot',
      'browser-take-screenshot',
    ]) {
      expect(names, `tools: ${names.join(',')}`).toContain(want)
    }
  })

  it('drives a real browser: create, navigate, read text, close', async () => {
    // browser-create-context takes NO arguments (input_schema.properties is empty): the page is
    // loaded by browser-navigate afterwards. Passing initial_url would be silently ignored, and the
    // snapshot below would then read a blank page.
    const created = await agent.callTool(CTX(90_000), TENANT, SESSION, EXT_ID, 'browser-create-context', 'c-1', {})
    expect(created.error, `create failed: ${created.error?.message ?? ''}`).toBeUndefined()
    const contextId = String(
      (created.data as { context_id?: string } | undefined)?.context_id ?? created.content,
    ).trim()
    expect(contextId.length, 'no context_id returned').toBeGreaterThan(0)

    try {
      const nav = await agent.callToolWithGrants(
        CTX(90_000), TENANT, SESSION, EXT_ID, 'browser-navigate', 'c-1b',
        { context_id: contextId, url: PAGE_URL }, grants(contextId),
      )
      expect(nav.error, `navigate failed: ${nav.error?.message ?? ''}`).toBeUndefined()

      // The browser must have actually LOADED the page, not merely answered. Reading a value that
      // exists only in that document is what separates "the tool replied" from "the browser worked".
      //
      // `browser-snapshot`, not a get-text tool: there is no browser-get-text in the manifest, and
      // guessing a name gives "no responders", which reads like a broken extension.
      const got = await agent.callToolWithGrants(
        CTX(90_000), TENANT, SESSION, EXT_ID, 'browser-snapshot', 'c-2',
        { context_id: contextId }, grants(contextId),
      )
      expect(got.error, `snapshot failed: ${got.error?.message ?? ''}`).toBeUndefined()
      expect(got.content).toContain('hello-e2e')
    } finally {
      await agent
        .callTool(CTX(60_000), TENANT, SESSION, EXT_ID, 'browser-close-context', 'c-3', {
          context_id: contextId,
        })
        .catch(() => undefined)
    }
  }, 180_000)

  it('produces screenshot bytes that land in the object store', async () => {
    const created = await agent.callTool(CTX(90_000), TENANT, SESSION, EXT_ID, 'browser-create-context', 'c-10', {})
    expect(created.error).toBeUndefined()
    const contextId = String(
      (created.data as { context_id?: string } | undefined)?.context_id ?? created.content,
    ).trim()

    try {
      await agent.callToolWithGrants(
        CTX(90_000), TENANT, SESSION, EXT_ID, 'browser-navigate', 'c-10b',
        { context_id: contextId, url: PAGE_URL }, grants(contextId),
      )
      const shot = await agent.callToolWithGrants(
        CTX(120_000), TENANT, SESSION, EXT_ID, 'browser-take-screenshot', 'c-11',
        { context_id: contextId }, grants(contextId),
      )
      expect(shot.error, `screenshot failed: ${shot.error?.message ?? ''}`).toBeUndefined()

      // The tool answers with a file reference. A PNG is not text: if the bytes were ever inlined
      // into content this would be unreadable, which is why the file indirection exists.
      const ref = (shot.data as { files?: Array<{ code: string; mime: string; bytes: number }> })?.files?.[0]
      expect(ref, `no file reference in ${JSON.stringify(shot.data)}`).toBeDefined()
      expect(ref!.code.length).toBeGreaterThan(0)
      expect(ref!.mime).toContain('image/')
      // A blank 1280x800 PNG is a few hundred bytes; anything tiny means the capture was empty.
      expect(ref!.bytes).toBeGreaterThan(100)
    } finally {
      await agent
        .callTool(CTX(60_000), TENANT, SESSION, EXT_ID, 'browser-close-context', 'c-12', {
          context_id: contextId,
        })
        .catch(() => undefined)
    }
  }, 180_000)

  it('refuses a tool that needs a context that does not exist', async () => {
    // A missing context must be a NAMED error, not a hang: an agent that waits 30s for a typo has
    // burned a turn.
    const r = await agent.callToolWithGrants(
      CTX(60_000), TENANT, SESSION, EXT_ID, 'browser-snapshot', 'c-20',
      { context_id: 'ctx-does-not-exist' }, grants('ctx-does-not-exist'),
    )
    expect(r.error, 'a bad context_id returned success').toBeDefined()
  }, 120_000)
})
