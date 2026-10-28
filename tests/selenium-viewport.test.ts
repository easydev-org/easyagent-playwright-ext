/**
 * The configured viewport must reach the page SELENIUM created.
 *
 * It never did. `browser.newContext({ viewport })` runs only when the browser has no context, and a
 * Selenium session always has one — so the branch was dead and the option had no effect for its whole
 * life. Measured before the fix: with PLAYWRIGHT_VIEWPORT=1280x720 the page reported 937x891, which is
 * Chrome's default window interior on a 1920x1080 screen. Every screenshot and every responsive layout
 * the agent saw was that size.
 *
 * These tests drive the REAL `create()` — the WebDriver handshake is the only stubbed part — because
 * a test that stubs the page cannot tell whether the method calls `setViewportSize` at all, and that
 * call is the whole fix.
 */
import type { Browser, Page } from 'playwright-core'
import { describe, expect, it, vi } from 'vitest'
import { SeleniumBrowserFactory, type SeleniumBrowserFactoryOpts } from '../src/selenium.js'

/** A page that records the viewport it was given. */
function fakePage() {
  const setViewportSize = vi.fn(() => Promise.resolve())
  return {
    setViewportSize,
    setDefaultTimeout: vi.fn(),
  }
}

/**
 * A browser with one driver-created context, which is the situation that caused the bug.
 *
 * `newContext` throws: if `create()` ever takes that branch with a context present, the test fails
 * loudly instead of quietly doing the wrong thing.
 */
function driverBrowser(page: ReturnType<typeof fakePage>) {
  const cdpSend = vi.fn(() => Promise.resolve({}))
  const context = {
    pages: () => [page],
    newPage: () => Promise.resolve(page),
    // The certificate override goes through CDP, because Playwright has no
    // `context.setIgnoreHTTPSErrors`. Recorded so the tests can assert it was sent.
    newCDPSession: () => Promise.resolve({ send: cdpSend }),
  }
  return {
    contexts: () => [context],
    newlyAttached: cdpSend,
    newContext: () => {
      throw new Error('newContext must not be called: the driver already made one')
    },
  }
}

/** A Selenium /session response carrying an se:cdp capability. */
function sessionResponse(cdpUrl = 'ws://driver/session/abc/se/cdp') {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({ value: { sessionId: 'abc', capabilities: { 'se:cdp': cdpUrl } } }),
  } as unknown as Response
}

function opts(
  viewport: { width: number; height: number } | null,
  over: Partial<SeleniumBrowserFactoryOpts> = {},
): SeleniumBrowserFactoryOpts {
  return {
    baseUrl: 'http://selenium.test:4444',
    browserName: 'chrome',
    viewport,
    ignoreHttpsErrors: false,
    cdpTimeoutMs: 1000,
    ...over,
  }
}

describe('SeleniumBrowserFactory.create', () => {
  it('applies the configured viewport to the driver-created page', async () => {
    const page = fakePage()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(sessionResponse())))

    const f = new SeleniumBrowserFactory(
      opts({ width: 1280, height: 720 }, {
        connect: () => Promise.resolve(driverBrowser(page) as unknown as Browser),
      }),
    )
    await f.create()

    expect(page.setViewportSize).toHaveBeenCalledWith({ width: 1280, height: 720 })
    vi.unstubAllGlobals()
  })

  // A null viewport means "whatever the driver chose", so nothing must be forced.
  it('leaves the driver default alone when no viewport is configured', async () => {
    const page = fakePage()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(sessionResponse())))

    const f = new SeleniumBrowserFactory(
      opts(null, { connect: () => Promise.resolve(driverBrowser(page) as unknown as Browser) }),
    )
    await f.create()

    expect(page.setViewportSize).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('returns the driver session id and the page it attached to', async () => {
    const page = fakePage() as unknown as Page
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(sessionResponse())))

    const f = new SeleniumBrowserFactory(
      opts(null, { connect: () => Promise.resolve(driverBrowser(page as never) as unknown as Browser) }),
    )
    const s = await f.create()

    expect(s.sessionId).toBe('abc')
    expect(s.cdpUrl).toBe('ws://driver/session/abc/se/cdp')
    expect(s.page).toBe(page)
    vi.unstubAllGlobals()
  })

  // The same dead branch made `ignoreHTTPSErrors` do nothing, so a deployment that set
  // PLAYWRIGHT_IGNORE_HTTPS_ERRORS still refused any host with an untrusted certificate.
  it('turns off certificate checks over CDP when configured', async () => {
    const page = fakePage()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(sessionResponse())))

    const f = new SeleniumBrowserFactory(
      opts(null, {
        ignoreHttpsErrors: true,
        connect: () => Promise.resolve(driverBrowser(page) as unknown as Browser),
      }),
    )
    const b = await f.create()

    const send = (b.browser as unknown as { newlyAttached: ReturnType<typeof vi.fn> }).newlyAttached
    expect(send).toHaveBeenCalledWith('Security.enable')
    expect(send).toHaveBeenCalledWith('Security.setIgnoreCertificateErrors', { ignore: true })
    vi.unstubAllGlobals()
  })

  // Off by default: silently disabling certificate checks everywhere would be worse than the bug.
  it('leaves certificate checks alone when not configured', async () => {
    const page = fakePage()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(sessionResponse())))

    const f = new SeleniumBrowserFactory(
      opts(null, { connect: () => Promise.resolve(driverBrowser(page) as unknown as Browser) }),
    )
    const b = await f.create()

    const send = (b.browser as unknown as { newlyAttached: ReturnType<typeof vi.fn> }).newlyAttached
    expect(send).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
