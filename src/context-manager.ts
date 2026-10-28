import type { Browser, BrowserContext, Page } from 'playwright-core'

/**
 * One browser context, keyed by an opaque `context_id`. A context is created
 * by `browser-create-context` (which mints the key) and used by every other
 * tool through that key. Contexts are scoped to a (tenant, session) pair so a
 * key minted in one tenant/session can never be used from another.
 */
export interface BrowserSession {
  contextId: string
  tenant: string
  session: string
  /** Selenium WebDriver session id (DELETE to close) — null for a raw CDP. */
  driverSessionId: string | null
  /** Tears down the driver session this context was created on. Captured at
   *  create time so a later config change cannot orphan the WebDriver slot. */
  releaseDriver?: (() => Promise<void>) | undefined
  browser: Browser
  context: BrowserContext
  page: Page
  createdAt: number
  lastUsedAt: number
  /** Per-context serialization: one tool action at a time. */
  busy: boolean
}

/**
 * One context, as the browser UI sees it.
 *
 * Metadata only, and everything optional that a live Page might refuse to answer: a page can be
 * mid-navigation or already closing, and a listing endpoint that throws because one context is busy
 * would hide the other seven.
 */
export interface ContextInfo {
  contextId: string
  /** Which conversation opened it — the UI shows this so a reader knows where it came from. */
  session: string
  url: string
  title: string
  createdAt: number
  lastUsedAt: number
  /** True while a tool action is running: a screenshot then may be mid-change. */
  busy: boolean
  /** False for a page that has been closed but whose record has not been reaped yet. */
  alive: boolean
}

/** The current URL, or '' when the page cannot say (closed, mid-navigation). */
function safeURL(page: Page): string {
  try {
    return page.url()
  } catch {
    return ''
  }
}

/**
 * A title for the row, from the URL when the document has not been read yet.
 *
 * Deliberately NOT `await page.title()`: a listing must not await every page, because one that is
 * mid-load would hold the whole list. The URL's last segment is a good enough label for a list of
 * browsers, and the page itself is one click away.
 */
function safeTitle(page: Page): string {
  try {
    const u = new URL(page.url())
    return u.host + (u.pathname === '/' ? '' : u.pathname)
  } catch {
    return ''
  }
}

export interface ContextManagerOpts {
  /** Close a context after this many ms without a tool call (0 disables). */
  idleTimeoutMs: number
  /** Hard cap on live contexts; creating beyond it evicts the LRU idle one. */
  maxContexts: number
  /** Create the underlying browser session (Selenium/WebDriver or raw CDP)
   *  for the calling (tenant, session). The target may be resolved per call
   *  from extension config, so it receives the scope. */
  createBrowser: (
    tenant: string,
    session: string,
  ) => Promise<{
    browser: Browser
    context: BrowserContext
    page: Page
    driverSessionId: string | null
    /** Tear down the underlying driver session (WebDriver DELETE). Captured
     *  per session so a config change between creates cannot orphan it. */
    releaseDriver?: () => Promise<void>
  }>
  /** Tear the underlying browser session down. */
  destroyBrowser: (s: BrowserSession) => Promise<void>
  onError?: (err: unknown, ctx: string) => void
}

/**
 * Owns the live browser contexts: creation, lookup (with tenant/session
 * checks), LRU eviction, and idle reaping. Actions route through [withContext]
 * so a context is only touched by one tool call at a time and its `lastUsedAt`
 * is refreshed.
 */
export class ContextManager {
  private readonly sessions = new Map<string, BrowserSession>()
  private reaper: ReturnType<typeof setInterval> | undefined

  constructor(private readonly opts: ContextManagerOpts) {}

  start(): void {
    if (this.opts.idleTimeoutMs <= 0 || this.reaper !== undefined) return
    // Sweep at a fraction of the idle window so a context is closed within
    // ~1.2x its idle timeout of going unused.
    const period = Math.max(15_000, Math.floor(this.opts.idleTimeoutMs / 4))
    this.reaper = setInterval(() => {
      void this.reapIdle()
    }, period)
    this.reaper.unref?.()
  }

  async stop(): Promise<void> {
    if (this.reaper !== undefined) {
      clearInterval(this.reaper)
      this.reaper = undefined
    }
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map(s => this.destroy(s)))
  }

  size(): number {
    return this.sessions.size
  }

  /**
   * Every live context belonging to one TENANT, most recently used first.
   *
   * For the browser UI, which shows what is running. Tenant-scoped rather than session-scoped on
   * purpose: a context is the tenant's own browser, and the same person looking at the panel from
   * another conversation — or from the extension's own tab, which has no session — is still the same
   * person. Ownership that stopped at the session would show a list and then refuse to open it.
   *
   * Returns a SNAPSHOT of metadata, never the Playwright objects: the caller serialises this to JSON,
   * and a Page is a live handle that would either fail to serialise or leak internals.
   */
  listForTenant(tenant: string): ContextInfo[] {
    const out: ContextInfo[] = []
    for (const s of this.sessions.values()) {
      if (s.tenant !== tenant) continue
      out.push({
        contextId: s.contextId,
        session: s.session,
        url: safeURL(s.page),
        title: safeTitle(s.page),
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        busy: s.busy,
        // A closed page can still have a record for a moment; the UI must not offer a screenshot it
        // cannot take.
        alive: !s.page.isClosed(),
      })
    }
    // Most recently used first: a map's iteration order would reshuffle on every request, which reads
    // as "the one I just touched moved somewhere".
    out.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    return out
  }

  /** Create a context and return its minted key. */
  async create(tenant: string, session: string): Promise<string> {
    if (
      this.opts.maxContexts > 0 &&
      this.sessions.size >= this.opts.maxContexts
    ) {
      await this.evictLru()
    }
    const { browser, context, page, driverSessionId, releaseDriver } =
      await this.opts.createBrowser(tenant, session)
    const contextId = crypto.randomUUID()
    const now = Date.now()
    this.sessions.set(contextId, {
      contextId,
      tenant,
      session,
      driverSessionId,
      ...(releaseDriver !== undefined ? { releaseDriver } : {}),
      browser,
      context,
      page,
      createdAt: now,
      lastUsedAt: now,
      busy: false,
    })
    return contextId
  }

  /**
   * Resolve a context for the caller, enforcing that the key belongs to the
   * same (tenant, session). Throws on unknown/foreign keys.
   */
  get(contextId: string, tenant: string, session: string): BrowserSession {
    const s = this.sessions.get(contextId)
    if (s === undefined) {
      throw new Error(
        `unknown context_id ${contextId} (it may have been reaped for inactivity — call browser-create-context again)`,
      )
    }
    if (s.tenant !== tenant || (session !== '' && s.session !== session)) {
      throw new Error(`context_id ${contextId} does not belong to this session`)
    }
    return s
  }

  /** Serialize access to one context and refresh its liveness. */
  async withContext<T>(
    contextId: string,
    tenant: string,
    session: string,
    fn: (s: BrowserSession) => Promise<T>,
  ): Promise<T> {
    const s = this.get(contextId, tenant, session)
    while (s.busy) await new Promise(r => setTimeout(r, 25))
    s.busy = true
    s.lastUsedAt = Date.now()
    try {
      return await fn(s)
    } finally {
      s.busy = false
      s.lastUsedAt = Date.now()
    }
  }

  /** Explicitly close a context (browser-close-context). */
  async close(
    contextId: string,
    tenant: string,
    session: string,
  ): Promise<void> {
    const s = this.get(contextId, tenant, session)
    this.sessions.delete(contextId)
    await this.destroy(s)
  }

  /** Close every context belonging to a session (lifecycle: deleted). Returns
   *  the number closed. */
  async closeSession(tenant: string, session: string): Promise<number> {
    const doomed = [...this.sessions.values()].filter(
      s => s.tenant === tenant && s.session === session,
    )
    for (const s of doomed) this.sessions.delete(s.contextId)
    await Promise.all(doomed.map(s => this.destroy(s)))
    return doomed.length
  }

  /** Close contexts idle beyond the configured timeout. */
  async reapIdle(): Promise<void> {
    if (this.opts.idleTimeoutMs <= 0) return
    const cutoff = Date.now() - this.opts.idleTimeoutMs
    const doomed = [...this.sessions.values()].filter(
      s => !s.busy && s.lastUsedAt < cutoff,
    )
    for (const s of doomed) this.sessions.delete(s.contextId)
    await Promise.all(doomed.map(s => this.destroy(s)))
  }

  private async evictLru(): Promise<void> {
    const idle = [...this.sessions.values()]
      .filter(s => !s.busy)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    const victim = idle[0]
    if (victim === undefined) return
    this.sessions.delete(victim.contextId)
    await this.destroy(victim)
  }

  private async destroy(s: BrowserSession): Promise<void> {
    // The in-pod driver session is torn down by destroyBrowser (DELETE
    // /session for WebDriver, or closing the CDP connection).
    await this.opts.destroyBrowser(s).catch(e => {
      this.opts.onError?.(e, `destroy ${s.contextId}`)
    })
  }
}
