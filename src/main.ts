import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { servePlaywright } from './serve.js'
import { mountUI } from '@easydev-org/easybus-sdk'
import { agentIdentity } from './ui/identity.js'
import { uiHandler } from './ui/server.js'

/** Read a positive integer env var, or a default. */
function intEnv(name: string, def: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return def
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : def
}

function viewportEnv(): { width: number; height: number } | null {
  const raw = process.env['PLAYWRIGHT_VIEWPORT']
  if (raw === undefined || raw.trim() === '') return null
  const m = /^(\d+)x(\d+)$/.exec(raw.trim())
  if (m === null) return null
  return { width: Number(m[1]), height: Number(m[2]) }
}

async function main(): Promise<void> {
  const natsUrl = process.env['NATS_URL'] ?? 'nats://127.0.0.1:4222'
  const seleniumUrl = process.env['PLAYWRIGHT_SELENIUM_URL'] ?? ''
  const cdpEndpoint = process.env['PLAYWRIGHT_CDP_ENDPOINT'] ?? ''
  if (seleniumUrl === '' && cdpEndpoint === '') {
    throw new Error(
      'one of PLAYWRIGHT_SELENIUM_URL (Selenium/standalone-chrome base URL) or PLAYWRIGHT_CDP_ENDPOINT (raw CDP endpoint) is required',
    )
  }
  const target: import('./index.js').BrowserTarget =
    seleniumUrl !== ''
      ? {
          kind: 'selenium',
          baseUrl: seleniumUrl,
          browserName: process.env['PLAYWRIGHT_BROWSER'] ?? 'chrome',
          cdpTimeoutMs: intEnv('PLAYWRIGHT_CDP_TIMEOUT_MS', 30_000),
        }
      : { kind: 'cdp', endpoint: cdpEndpoint }

  const { stop, manager } = await servePlaywright({
    natsUrl,
    extension: {
      target,
      viewport: viewportEnv(),
      ignoreHttpsErrors:
        process.env['PLAYWRIGHT_IGNORE_HTTPS_ERRORS'] !== 'false',
      idleTimeoutMs: intEnv('PLAYWRIGHT_IDLE_TIMEOUT_MS', 600_000),
      maxContexts: intEnv('PLAYWRIGHT_MAX_CONTEXTS', 8),
      defaultTimeoutMs: intEnv('PLAYWRIGHT_ACTION_TIMEOUT_MS', 30_000),
    },
  })

  console.log(
    `[playwright] serving over ${natsUrl} -> ${
      seleniumUrl !== '' ? `selenium ${seleniumUrl}` : `cdp ${cdpEndpoint}`
    } (idle=${intEnv('PLAYWRIGHT_IDLE_TIMEOUT_MS', 600_000)}ms, max=${intEnv('PLAYWRIGHT_MAX_CONTEXTS', 8)})`,
  )

  // HTTP surface: Kubernetes probes, plus the browser panel's data API.
  //
  // The PANEL IS OPT-IN. `PLAYWRIGHT_UI_DIR` points at a built frontend; without it the server keeps
  // exactly the surface it had before, so a deployment that does not want a panel pays nothing and
  // changes nothing.
  const port = intEnv('PORT', 8080)

  /** Probes and the extension's own API. */
  const api = (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/v1/health') {
      res.end(JSON.stringify({ ok: true, id: 'playwright' }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  }

  const uiDir = process.env['PLAYWRIGHT_UI_DIR'] ?? ''
  const agentURL = process.env['AGENT_URL'] ?? ''
  // The panel's API answers only when both the bundle AND an identity source are configured: a panel
  // that cannot tell who is asking must not list anybody's browsers.
  const panel =
    uiDir !== '' && agentURL !== ''
      ? uiHandler({ contexts: manager, identity: agentIdentity({ agentURL }) })
      : undefined

  const handler =
    uiDir === ''
      ? api
      : mountUI(
          // Paths outside the mount reach `api`; under the mount, `/api/*` reaches the panel.
          (req, res) => {
            const p = (req.url ?? '/').split('?')[0] ?? '/'
            if (p.startsWith('/ext/playwright/api/')) {
              void (panel ?? api)(req, res)
              return
            }
            api(req, res)
          },
          {
            dir: resolve(uiDir),
            base: '/ext/playwright',
            id: 'playwright',
            title: 'Browser',
            apiPrefix: '/api',
            descriptions: {
              en: 'Open browsers the agent is driving, live.',
              zh: '查看 agent 正在驱动的浏览器，实时画面。',
            },
            icon: '/icon.svg',
          },
        )

  const http = createServer(handler)
  http.listen(port, () => console.log(`[playwright] http :${port}`))

  const shutdown = (): void => {
    http.close()
    void stop().finally(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

void main().catch((e: unknown) => {
  console.error('[playwright] fatal:', e instanceof Error ? e.message : e)
  process.exit(1)
})
