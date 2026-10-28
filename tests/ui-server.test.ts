/**
 * The panel's data API.
 *
 * Three rules are worth pinning, and each one is a mistake that is easy to make and hard to see:
 *
 *   * the tenant comes from the TOKEN, never from the query — otherwise naming a tenant would read
 *     somebody else's browsers;
 *   * an unreachable agent is NOT a 401, or a momentary blip logs the reader out;
 *   * a context is reachable from a DIFFERENT session of the same tenant, because the panel is opened
 *     from a tab that has no session at all.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { uiHandler } from '../src/ui/server.js'
import { Unauthenticated, type IdentityResolver } from '../src/ui/identity.js'
import type { ContextInfo } from '../src/context-manager.js'

/** A context list for one tenant, with a page that answers a fixed screenshot. */
function fakeContexts(list: ContextInfo[]) {
  const screenshot = Buffer.from([0xff, 0xd8, 0xff])
  return {
    listForTenant: (tenant: string) => list.filter(() => tenant === 'alice'),
    get: (id: string, tenant: string, session: string) => {
      const c = list.find(x => x.contextId === id)
      if (!c || tenant !== 'alice') throw new Error('no such context')
      if (c.session !== session) throw new Error('wrong session')
      return { page: { screenshot: () => Promise.resolve(screenshot) } }
    },
  } as never
}

const one: ContextInfo = {
  contextId: 'ctx-1',
  session: 'chat-a',
  url: 'https://example.test/',
  title: 'example.test',
  createdAt: 1,
  lastUsedAt: 2,
  busy: false,
  alive: true,
}

function identity(tenant = 'alice'): IdentityResolver {
  return {
    tenant: (token: string) =>
      token === 'good' ? Promise.resolve(tenant) : Promise.reject(new Unauthenticated()),
  }
}

/** Drive the handler with a URL and headers. */
async function call(
  url: string,
  opts: { token?: string } = {},
  deps: { list?: ContextInfo[]; identity?: IdentityResolver } = {},
): Promise<{ status: number; type: string; body: string; json: unknown }> {
  const h = uiHandler({
    contexts: fakeContexts(deps.list ?? [one]),
    identity: deps.identity ?? identity(),
  })
  let status = 0
  let type = ''
  let body = ''
  let code = 0
  const res = {
    get statusCode() {
      return code
    },
    set statusCode(v: number) {
      code = v
    },
    setHeader(k: string, v: string) {
      if (k.toLowerCase() === 'content-type') type = v
    },
    end(b?: string | Buffer) {
      body = b === undefined ? '' : Buffer.from(b).toString('binary')
      status = code
    },
  } as unknown as ServerResponse
  const req = {
    url,
    headers: opts.token === undefined ? {} : { authorization: `Bearer ${opts.token}` },
  } as unknown as IncomingMessage
  await h(req, res)
  let json: unknown = null
  try {
    json = JSON.parse(Buffer.from(body, 'binary').toString('utf8'))
  } catch {
    /* a binary body: the screenshot case */
  }
  return { status, type, body, json }
}

describe('uiHandler', () => {
  it('lists contexts for the token OWNER', async () => {
    const r = await call('/ext/playwright/api/contexts', { token: 'good' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ contexts: [one], count: 1 })
  })

  // The tenant comes from the token. A query parameter must not reach another tenant's browsers.
  it('refuses a request with no token', async () => {
    const r = await call('/ext/playwright/api/contexts?tenant=bob')
    expect(r.status).toBe(401)
  })

  it('refuses a rejected token', async () => {
    const r = await call('/ext/playwright/api/contexts', { token: 'bad' })
    expect(r.status).toBe(401)
  })

  // An agent that cannot be reached is NOT an authentication failure: 503 so the client retries
  // instead of logging the reader out over a blip.
  it('answers 503, not 401, when the agent is unreachable', async () => {
    const r = await call(
      '/ext/playwright/api/contexts',
      { token: 'good' },
      {
        identity: {
          tenant: () => Promise.reject(new Error('connect ECONNREFUSED')),
        },
      },
    )
    expect(r.status).toBe(503)
  })

  it('serves a JPEG frame for a context', async () => {
    const r = await call('/ext/playwright/api/contexts/ctx-1/frame', { token: 'good' })
    expect(r.status).toBe(200)
    expect(r.type).toBe('image/jpeg')
  })

  it('404s a context that is not the caller’s', async () => {
    const r = await call('/ext/playwright/api/contexts/ctx-other/frame', { token: 'good' })
    expect(r.status).toBe(404)
  })

  it('404s an unknown path', async () => {
    const r = await call('/ext/playwright/api/nope', { token: 'good' })
    expect(r.status).toBe(404)
  })
})
