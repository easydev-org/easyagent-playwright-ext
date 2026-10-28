// The browser panel's data API.
//
// Two endpoints, both READ-ONLY:
//
//   GET api/contexts          every live context for the caller's tenant
//   GET api/contexts/:id/frame  one JPEG screenshot of that context's page
//
// WHY A SCREENSHOT AND NOT A LIVE STREAM. A screencast needs a WebSocket held open per context, a
// backpressure story, and a teardown path for every way a browser tab can disappear — for a debugging
// panel that is a lot of machinery to get right. A screenshot is one request, cannot leak, and the
// page is a cache entry that dies with the response.
//
// The cost is that "live" means "refreshed on a timer", and the UI polls at about 1 fps. For watching
// an agent drive a browser that is enough to see what it is doing; it is not a remote desktop.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ContextManager } from '../context-manager.js'
import type { IdentityResolver } from './identity.js'

export interface UIDeps {
  contexts: ContextManager
  identity: IdentityResolver
}

/** The bearer the caller sent, or '' when absent. */
function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization
  if (typeof h !== 'string') return ''
  return /^bearer /i.test(h) ? h.slice(7).trim() : ''
}

/**
 * The UI's request handler.
 *
 * Authentication first, on every request: a context is somebody's browser, and the tenant comes from
 * the token rather than from a query parameter. That is the same rule the rest of this extension
 * follows, and it is why the panel can be mounted without a second notion of identity.
 */
export function uiHandler(deps: UIDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'

    if (!path.endsWith('/api/contexts') && !path.includes('/api/contexts/')) {
      sendJSON(res, 404, { error: 'not found' })
      return
    }

    const token = bearer(req)
    if (token === '') {
      sendJSON(res, 401, { error: 'a bearer token is required' })
      return
    }
    let tenant = ''
    try {
      tenant = await deps.identity.tenant(token)
    } catch (e) {
      // A network failure to the agent is NOT a 401: reporting it as one would log the user out over
      // a momentary blip.
      const status = e instanceof Error && e.name === 'Unauthenticated' ? 401 : 503
      sendJSON(res, status, { error: e instanceof Error ? e.message : String(e) })
      return
    }

    if (path.endsWith('/api/contexts')) {
      const list = deps.contexts.listForTenant(tenant)
      sendJSON(res, 200, { contexts: list, count: list.length })
      return
    }

    // api/contexts/<id>/frame
    const m = /\/api\/contexts\/([^/]+)\/frame$/.exec(path)
    if (!m) {
      sendJSON(res, 404, { error: 'not found' })
      return
    }
    const id = decodeURIComponent(m[1] ?? '')
    let session
    try {
      // The full scope is required to reach the page. Session is taken from the CONTEXT itself —
      // the listing already resolved it — rather than from the caller, who may legitimately be
      // browsing from a tab that has no session at all.
      const known = deps.contexts.listForTenant(tenant).find(c => c.contextId === id)
      if (!known) {
        sendJSON(res, 404, { error: 'no such context' })
        return
      }
      session = deps.contexts.get(id, tenant, known.session)
    } catch (e) {
      sendJSON(res, 404, { error: e instanceof Error ? e.message : String(e) })
      return
    }

    try {
      // `jpeg` at moderate quality: a PNG of a real page is megabytes, and this is refreshed about
      // once a second.
      const buf = await session.page.screenshot({ type: 'jpeg', quality: 70 })
      res.statusCode = 200
      res.setHeader('content-type', 'image/jpeg')
      // Never cached: the whole point is that it is the CURRENT page.
      res.setHeader('cache-control', 'no-store')
      res.end(buf)
    } catch (e) {
      // A page that navigated away mid-capture, or a browser that died. 503 rather than 500: it is a
      // transient state of a live resource, and the panel retries on its next tick.
      sendJSON(res, 503, { error: e instanceof Error ? e.message : String(e) })
    }
  }
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}
