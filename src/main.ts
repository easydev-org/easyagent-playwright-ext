/**
 * The playwright sidecar: a browser driver behind one HTTP endpoint.
 *
 * IT NO LONGER SPEAKS THE BUS. The NATS connection, discovery, the manifest, permissions and config
 * are a Go process's job now — see the header of sidecar.ts for why the seam fell exactly here.
 *
 * IT STILL SERVES THE PANEL'S DATA, because only this process knows the live contexts. The panel is
 * same-origin with the console and its API is proxied here by easyagent-ext-ui-host, so the paths keep
 * their absolute `/ext/playwright/api/...` shape.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { connectNodeAdapter } from '@connectrpc/connect-node'
import { ContextManager } from './context-manager.js'
import { SeleniumBrowserFactory } from './selenium.js'
import { CdpBrowserFactory } from './browser.js'
import { startSidecar } from './sidecar.js'
import { agentIdentity } from './ui/identity.js'
import { uiService } from './ui/service.js'
import { UiService } from './gen/ui/v1/ui_pb.js'

/** Read a positive integer env var, or a default. */
function intEnv(name: string, def: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return def
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : def
}

function viewportEnv(): { width: number; height: number } | null {
  const raw = process.env.PLAYWRIGHT_VIEWPORT
  if (raw === undefined || raw.trim() === '') return null
  const m = /^(\d+)x(\d+)$/.exec(raw.trim())
  if (m === null) return null
  return { width: Number(m[1]), height: Number(m[2]) }
}

async function main(): Promise<void> {
  const seleniumUrl = process.env.PLAYWRIGHT_SELENIUM_URL ?? ''
  const cdpEndpoint = process.env.PLAYWRIGHT_CDP_ENDPOINT ?? ''
  if (seleniumUrl === '' && cdpEndpoint === '') {
    throw new Error(
      'one of PLAYWRIGHT_SELENIUM_URL (Selenium/standalone-chrome base URL) or PLAYWRIGHT_CDP_ENDPOINT (raw CDP endpoint) is required',
    )
  }

  const viewport = viewportEnv()
  const ignoreHttpsErrors = process.env.PLAYWRIGHT_IGNORE_HTTPS_ERRORS !== 'false'
  const browserName = process.env.PLAYWRIGHT_BROWSER ?? 'chrome'
  const cdpTimeoutMs = intEnv('PLAYWRIGHT_CDP_TIMEOUT_MS', 30_000)

  // ONE FACTORY, CHOSEN ONCE. A context created against Selenium must be closed against the same
  // driver, which is why the factory owns both halves and the manager only stores the release func.
  const factory =
    seleniumUrl !== ''
      ? new SeleniumBrowserFactory({
          baseUrl: seleniumUrl,
          browserName,
          cdpTimeoutMs,
          viewport,
          ignoreHttpsErrors,
        })
      : new CdpBrowserFactory({ endpoint: cdpEndpoint, viewport, ignoreHttpsErrors })

  const manager = new ContextManager({
    maxContexts: intEnv('PLAYWRIGHT_MAX_CONTEXTS', 8),
    idleTimeoutMs: intEnv('PLAYWRIGHT_IDLE_TIMEOUT_MS', 600_000),
    createBrowser: async () => {
      if (factory instanceof SeleniumBrowserFactory) {
        const s = await factory.create()
        return {
          browser: s.browser,
          context: s.page.context(),
          page: s.page,
          driverSessionId: s.sessionId,
          releaseDriver: () => factory.deleteSession(s.sessionId).catch(() => {}),
        }
      }
      const { browser, page } = await factory.create()
      return { browser, context: page.context(), page, driverSessionId: null }
    },
    destroyBrowser: async s => {
      if (s.releaseDriver !== undefined) {
        // The WebDriver session owns the browser; deleting it closes the context and frees the Grid
        // slot. Disconnect CDP after, so a failed delete cannot leave the socket open.
        await s.releaseDriver()
        await s.browser.close().catch(() => {})
      } else {
        await s.page
          .context()
          .close()
          .catch(() => {})
      }
    },
    onError: () => {},
  })
  // The idle reaper is what stops a forgotten context from holding a Grid slot forever. Starting it
  // is not optional: without it PLAYWRIGHT_IDLE_TIMEOUT_MS is a number nothing reads.
  manager.start()

  /**
   * WHERE file:<code> BYTES COME FROM.
   *
   * The blob backend is Go's, so this asks the sibling process. AGENT_URL points at the Go shell,
   * which exposes a single internal endpoint for exactly this — not the agent's public API, because
   * the sidecar has no tenant credential and must not be given one.
   */
  const shellURL = process.env.SHELL_URL ?? ''
  const fetchFile =
    shellURL === ''
      ? undefined
      : async (code: string, tenant: string) => {
          const res = await fetch(
            `${shellURL}/file?code=${encodeURIComponent(code)}&tenant=${encodeURIComponent(tenant)}`,
          )
          if (!res.ok) throw new Error(`file ${code}: HTTP ${res.status}`)
          const body = (await res.json()) as { bytes: string; name: string; mime: string }
          return { data: Buffer.from(body.bytes, 'base64'), name: body.name, mime: body.mime }
        }

  /**
   * THE PANEL AND THE TOOL ENDPOINT SHARE ONE LISTENER, and that is why this file no longer starts an
   * HTTP server of its own.
   *
   * The Go shell is the pod's only published port: it serves the probes and proxies the panel's
   * `/ext/playwright/api/*` here. A second listener would duplicate that upstream for nothing — and
   * everything here binds loopback anyway, so it would be no safer.
   */
  const agentURL = process.env.AGENT_URL ?? ''
  const panel = connectNodeAdapter({
    routes: router =>
      router.service(
        UiService,
        uiService({ contexts: manager, identity: agentIdentity({ agentURL }) }),
      ),
  })

  /** Hand the panel's paths to Connect; return true when this took the request. */
  const panelRoutes = (req: IncomingMessage, res: ServerResponse): boolean => {
    const p = (req.url ?? '/').split('?')[0] ?? '/'
    if (!p.startsWith('/ext/playwright/api/')) return false
    if (agentURL === '') {
      // SAID PLAINLY. Without an identity source every call would be refused anyway; answering 503
      // with the reason is the version a reader can act on.
      res.statusCode = 503
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({ error: 'AGENT_URL is not configured, so callers cannot be identified' }),
      )
      return true
    }
    // Connect mounts procedures at their absolute path, so the panel's prefix is stripped here rather
    // than duplicated in every generated client.
    const raw = req.url ?? ''
    const query = raw.includes('?') ? raw.slice(raw.indexOf('?')) : ''
    req.url = p.slice('/ext/playwright/api'.length) + query
    panel(req, res)
    return true
  }

  const sidecar = startSidecar({
    manager,
    defaultTimeoutMs: intEnv('PLAYWRIGHT_ACTION_TIMEOUT_MS', 30_000),
    ...(fetchFile !== undefined ? { fetchFile } : {}),
    extraRoutes: panelRoutes,
  })

  console.log(
    `[playwright] browser -> ${seleniumUrl !== '' ? `selenium ${seleniumUrl}` : `cdp ${cdpEndpoint}`}` +
      ` (idle=${intEnv('PLAYWRIGHT_IDLE_TIMEOUT_MS', 600_000)}ms, max=${intEnv('PLAYWRIGHT_MAX_CONTEXTS', 8)})`,
  )

  const shutdown = (): void => {
    void sidecar.close().finally(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

void main().catch((e: unknown) => {
  console.error('[playwright] fatal:', e instanceof Error ? e.message : e)
  process.exit(1)
})
