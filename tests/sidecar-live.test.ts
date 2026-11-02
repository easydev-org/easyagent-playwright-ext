import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ContextManager } from '../src/context-manager.js'
import { SeleniumBrowserFactory } from '../src/selenium.js'
import { startSidecar } from '../src/sidecar.js'

/**
 * The seam, against a REAL browser.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. The unit tests own the routing rules (which error code for
 * which failure). This one owns the thing a fake cannot: that a real Chromium behind a real Selenium
 * node answers through `/exec`, and that the accessibility snapshot — the tool this whole split was
 * most at risk of breaking, because it is Playwright-specific — still produces the `[ref=eN]` markers
 * that every `target: "eN"` depends on.
 *
 * SKIPPED WITHOUT A BROWSER. `E2E_SELENIUM_URL` is set by CI's compose stack; a plain `npm test` on a
 * laptop has none and should not fail for it.
 */
const seleniumUrl = process.env['E2E_SELENIUM_URL'] ?? ''
const hasBrowser = seleniumUrl !== ''

describe.skipIf(!hasBrowser)('sidecar against a real browser', () => {
  let manager: ContextManager
  let close: () => Promise<void>
  let base: string

  beforeAll(async () => {
    const factory = new SeleniumBrowserFactory({
      baseUrl: seleniumUrl,
      browserName: 'chrome',
      viewport: { width: 1280, height: 720 },
      ignoreHttpsErrors: true,
      cdpTimeoutMs: 30_000,
    })
    manager = new ContextManager({
      maxContexts: 2,
      idleTimeoutMs: 0, // no reaper: a test must not race its own cleanup
      createBrowser: async () => {
        const s = await factory.create()
        return {
          browser: s.browser,
          context: s.page.context(),
          page: s.page,
          driverSessionId: s.sessionId,
          releaseDriver: () => factory.deleteSession(s.sessionId).catch(() => {}),
        }
      },
      destroyBrowser: async s => {
        if (s.releaseDriver !== undefined) {
          await s.releaseDriver()
          await s.browser.close().catch(() => {})
        } else {
          await s.page.context().close().catch(() => {})
        }
      },
      onError: () => {},
    })

    const port = 19700 + Math.floor(Math.random() * 200)
    process.env['SIDECAR_PORT'] = String(port)
    base = `http://127.0.0.1:${port}`
    close = startSidecar({ manager, defaultTimeoutMs: 30_000 }).close

    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).ok) return
      } catch {
        /* not listening yet */
      }
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error('sidecar did not start')
  }, 120_000)

  afterAll(async () => {
    await manager.stop().catch(() => {})
    await close?.()
  })

  /** One /exec round trip. */
  async function exec(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${base}/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant: 't-e2e', session: 's-e2e', ...body }),
    })
    return (await res.json()) as Record<string, unknown>
  }

  /** The result's text, or a thrown error naming what came back instead. */
  function contentOf(out: Record<string, unknown>): string {
    if (out['ok'] !== true) throw new Error(`call failed: ${JSON.stringify(out)}`)
    return String((out['result'] as { content?: string } | undefined)?.content ?? '')
  }

  it('navigates, snapshots with refs, and clicks by ref', async () => {
    const created = await exec({ tool: 'browser-create-context' })
    expect(created['ok']).toBe(true)
    const ctx = String(created['context_id'])
    expect(ctx).not.toBe('')

    // A DATA URL, so the test needs no network. The button is the thing every later step depends on.
    const html =
      'data:text/html,<h1>Sidecar</h1><button id="go" onclick="this.textContent=\'clicked\'">Press</button>'
    contentOf(await exec({ tool: 'browser-navigate', context_id: ctx, args: { url: html } }))

    const snap = contentOf(await exec({ tool: 'browser-snapshot', context_id: ctx, args: {} }))
    // THE PROPERTY THE WHOLE SPLIT WAS AT RISK OF LOSING: `ariaSnapshot({mode:'ai'})` emits refs.
    // Without a ref there is no way to address an element, so every interaction tool breaks — and it
    // would break silently, as "click did nothing".
    // THE PREFIX IS PART OF THE MARKER. A page with any frame gets `[ref=f1e3]`, so a matcher that
    // only accepted `e3` would find nothing — and `target` would then be treated as a CSS selector,
    // failing as "no element matches f1e3".
    const ref = /\[ref=([a-z]\d*e\d+)\]/.exec(snap)?.[1]
    expect(ref, `snapshot had no [ref=…] marker:\n${snap}`).toBeDefined()

    // `target: "eN"` resolves through the aria-ref engine, which only exists in a browser context
    // that produced that snapshot — the part a fake manager cannot exercise.
    // THE BARE REF, NOT ITS DECORATION. `resolveLocator` treats a ref-shaped value as an aria-ref and
    // anything else as a CSS selector, so passing "[ref=f1e3]" would be searched for literally.
    const clicked = contentOf(
      await exec({ tool: 'browser-click', context_id: ctx, args: { target: ref } }),
    )
    expect(clicked.length).toBeGreaterThan(0)
  }, 120_000)

  it('returns screenshot bytes that the Go side would ingest', async () => {
    const created = await exec({ tool: 'browser-create-context' })
    const ctx = String(created['context_id'])
    contentOf(
      await exec({
        tool: 'browser-navigate',
        context_id: ctx,
        args: { url: 'data:text/html,<h1>shot</h1>' },
      }),
    )

    const out = await exec({ tool: 'browser-take-screenshot', context_id: ctx, args: {} })
    expect(out['ok']).toBe(true)
    const result = out['result'] as { file?: { bytes: string; mime: string; name: string } }
    // BYTES, NOT `data`: this is the one place the seam changes shape, because the Go side turns them
    // into a `file:<code>` and it is the only side with a blob backend.
    expect(result.file).toBeDefined()
    // THE MIME IS DELIBERATELY EMPTY: the agent sniffs it from the bytes, which is what it does for
    // every generated file. Asserting image/ here would test a guess this side should not make.
    expect(result.file?.mime).toBe('')
    expect(result.file?.name).toMatch(/\.png$/)
    // A real PNG is not empty and decodes to bytes starting with the PNG signature.
    const bytes = Buffer.from(result.file?.bytes ?? '', 'base64')
    expect(bytes.length).toBeGreaterThan(100)
    expect(bytes.subarray(0, 4).toString('hex')).toBe('89504e47')
  }, 120_000)

  it('reports a reaped context as not_found, not as a crash', async () => {
    const out = await exec({
      tool: 'browser-navigate',
      context_id: 'definitely-not-a-context',
      args: { url: 'about:blank' },
    })
    expect(out['ok']).toBe(false)
    expect(out['code']).toBe('not_found')
  }, 60_000)
})
