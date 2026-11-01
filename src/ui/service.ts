// The panel's data API, as a Connect service.
//
// THIS REPLACES two hand-written JSON routes. The routes worked; what they did not do is state their
// contract — the panel's shapes were object literals written at the point of emission, so the two
// sides agreed by luck and by review.
//
// A SCREENSHOT COMES BACK AS `bytes`, not as an image response. The panel used to point an <img> at a
// URL; it now asks for the frame and makes a blob, which means the request carries the token the same
// way every other request does — instead of an <img> that has to have a credential put somewhere a URL
// can hold it.

import type { ContextManager } from '../context-manager.js'
import type { IdentityResolver } from './identity.js'
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect'
import { Code, ConnectError } from '@connectrpc/connect'

import type { UiService } from '../gen/ui/v1/ui_pb.js'
import type { Context as ContextMsg } from '../gen/ui/v1/ui_pb.js'

export interface UIDeps {
  contexts: ContextManager
  identity: IdentityResolver
}

/** The tenant this request belongs to, or a Connect error that says why not. */
async function tenantOf(ctx: HandlerContext, deps: UIDeps): Promise<string> {
  const token = bearer(ctx.requestHeader.get('authorization') ?? '')
  if (token === '') {
    throw new ConnectError('a bearer token is required', Code.Unauthenticated)
  }
  try {
    return await deps.identity.tenant(token)
  } catch (e) {
    // A FAILURE TO REACH THE AGENT IS NOT A 401: reporting one as unauthenticated would log the reader
    // out over a momentary blip, and they would not know why.
    const name = e instanceof Error ? e.name : ''
    throw new ConnectError(
      e instanceof Error ? e.message : String(e),
      name === 'Unauthenticated' ? Code.Unauthenticated : Code.Unavailable,
    )
  }
}

function bearer(header: string): string {
  return /^bearer /i.test(header) ? header.slice(7).trim() : ''
}

/**
 * Builds the service.
 *
 * THE TENANT IS RESOLVED PER REQUEST, not once at construction: it comes from the caller's token, and
 * a service that captured one would answer every caller as the first of them.
 */
export function uiService(deps: UIDeps): ServiceImpl<typeof UiService> {
  return {
    async listContexts(_req, ctx) {
      const tenant = await tenantOf(ctx, deps)
      const list = deps.contexts.listForTenant(tenant)
      return {
        contexts: list.map(
          (c): ContextMsg => ({
            contextId: c.contextId,
            session: c.session,
            url: c.url,
            title: c.title,
            createdAt: BigInt(c.createdAt),
            lastUsedAt: BigInt(c.lastUsedAt),
            busy: c.busy,
            alive: c.alive,
            $typeName: 'ui.v1.Context',
          }),
        ),
        count: list.length,
        $typeName: 'ui.v1.ListContextsResponse',
      }
    },

    async getFrame(req, ctx) {
      const tenant = await tenantOf(ctx, deps)
      const id = req.contextId
      if (id === '') {
        throw new ConnectError('context_id is required', Code.InvalidArgument)
      }
      // THE SESSION COMES FROM THE CONTEXT, not from the caller: the listing already resolved it, and
      // a browser tab legitimately has no session of its own to name.
      const known = deps.contexts.listForTenant(tenant).find(c => c.contextId === id)
      if (!known) {
        // NOT_FOUND rather than PERMISSION_DENIED: the caller may know that this id is not theirs, and
        // the alternative would confirm it exists somewhere else.
        throw new ConnectError('no such context', Code.NotFound)
      }
      let buf: Buffer
      try {
        const session = deps.contexts.get(id, tenant, known.session)
        // `jpeg` at moderate quality: a PNG of a real page is megabytes, and this is refreshed about
        // once a second.
        buf = await session.page.screenshot({ type: 'jpeg', quality: 70 })
      } catch (e) {
        // A page that navigated away mid-capture, or a browser that died. UNAVAILABLE rather than
        // INTERNAL: it is a transient state of a live resource, and the panel retries on its next tick.
        throw new ConnectError(e instanceof Error ? e.message : String(e), Code.Unavailable)
      }
      return { jpeg: new Uint8Array(buf), $typeName: 'ui.v1.GetFrameResponse' }
    },
  }
}
