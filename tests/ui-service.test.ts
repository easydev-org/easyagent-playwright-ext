/**
 * The panel's data API.
 *
 * Three rules are worth pinning, and each one is a mistake that is easy to make and hard to see:
 *
 *   * the tenant comes from the TOKEN, never from the request — otherwise naming a tenant would read
 *     somebody else's browsers;
 *   * an unreachable agent is NOT "unauthenticated", or a momentary blip logs the reader out;
 *   * a context is reachable from a DIFFERENT session of the same tenant, because the panel is opened
 *     from a tab that has no session at all.
 *
 * THE TESTS CALL THE SERVICE METHODS DIRECTLY rather than over HTTP. What is under test is the
 * decisions the service makes — which code for which failure, and whose data — not the transport,
 * which Connect's own suite covers.
 */
import { Code, ConnectError, createHandlerContext } from '@connectrpc/connect'
import type { HandlerContext } from '@connectrpc/connect'
import { describe, expect, it } from 'vitest'

import { uiService } from '../src/ui/service.js'
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

/** An identity resolver that maps exactly one token. */
function fakeIdentity(): IdentityResolver {
  return {
    tenant: (token: string) => {
      if (token === 'good') return Promise.resolve('alice')
      return Promise.reject(new Unauthenticated('no such token'))
    },
  } as never
}

/**
 * A handler context carrying one Authorization header.
 *
 * THE FIELDS ARE FILLED WITHOUT MEANING because the service reads exactly one of them. Building a real
 * context would need a service descriptor and a URL, and would test Connect's plumbing rather than the
 * decisions this file is about.
 */
function ctxWith(authorization: string): HandlerContext {
  return createHandlerContext({
    service: undefined as never,
    method: undefined as never,
    protocolName: 'connect',
    requestMethod: 'POST',
    url: 'http://test/ui.v1.UiService/Call',
    requestHeader: authorization === '' ? undefined : { authorization },
  })
}

function service(list: ContextInfo[]) {
  return uiService({ contexts: fakeContexts(list), identity: fakeIdentity() })
}

const oneContext: ContextInfo[] = [
  {
    contextId: 'c1',
    session: 'other-session',
    url: 'https://example.test/',
    title: 'Example',
    createdAt: 1_700_000_000_000,
    lastUsedAt: 1_700_000_001_000,
    busy: false,
    alive: true,
  },
]

describe('listContexts', () => {
  it('answers for the tenant the TOKEN names', async () => {
    const res = await service(oneContext).listContexts(
      { $typeName: 'ui.v1.ListContextsRequest' },
      ctxWith('Bearer good'),
    )
    expect(res.contexts).toHaveLength(1)
    expect(res.contexts[0]?.contextId).toBe('c1')
    // Millisecond timestamps arrive as bigint, because proto3 spells int64 that way.
    expect(res.contexts[0]?.createdAt).toBe(1_700_000_000_000n)
  })

  it('refuses without a bearer', async () => {
    const err = await service(oneContext)
      .listContexts({ $typeName: 'ui.v1.ListContextsRequest' }, ctxWith(''))
      .catch(e => e)
    expect(err).toBeInstanceOf(ConnectError)
    expect((err as ConnectError).code).toBe(Code.Unauthenticated)
  })

  it('refuses a token the agent does not know', async () => {
    const err = await service(oneContext)
      .listContexts({ $typeName: 'ui.v1.ListContextsRequest' }, ctxWith('Bearer wrong'))
      .catch(e => e)
    expect((err as ConnectError).code).toBe(Code.Unauthenticated)
  })

  it('treats an unreachable agent as UNAVAILABLE, not as a bad token', async () => {
    // THE DISTINCTION MATTERS TO A READER: "your session ended" and "the server is briefly down" ask
    // for different things, and the first one logs them out.
    const down: IdentityResolver = {
      tenant: () => Promise.reject(new Error('dial tcp: connection refused')),
    } as never
    const svc = uiService({ contexts: fakeContexts(oneContext), identity: down })
    const err = await svc
      .listContexts({ $typeName: 'ui.v1.ListContextsRequest' }, ctxWith('Bearer good'))
      .catch(e => e)
    expect((err as ConnectError).code).toBe(Code.Unavailable)
  })
})

describe('getFrame', () => {
  it('returns the screenshot for a context of the caller', async () => {
    const res = await service(oneContext).getFrame(
      { contextId: 'c1', $typeName: 'ui.v1.GetFrameRequest' },
      ctxWith('Bearer good'),
    )
    expect(Array.from(res.jpeg)).toEqual([0xff, 0xd8, 0xff])
  })

  it("reaches a context from a session other than the caller's", async () => {
    // THE PANEL IS OPENED FROM A TAB WITH NO SESSION. A context belongs to whichever conversation
    // opened it, and the reader is the same person — so the session comes from the CONTEXT, not from
    // the caller.
    const res = await service(oneContext).getFrame(
      { contextId: 'c1', $typeName: 'ui.v1.GetFrameRequest' },
      ctxWith('Bearer good'),
    )
    expect(res.jpeg.length).toBeGreaterThan(0)
  })

  it('answers NOT_FOUND for an id that is not the caller’s', async () => {
    const err = await service(oneContext)
      .getFrame({ contextId: 'nope', $typeName: 'ui.v1.GetFrameRequest' }, ctxWith('Bearer good'))
      .catch(e => e)
    expect((err as ConnectError).code).toBe(Code.NotFound)
  })

  it('requires an id', async () => {
    const err = await service(oneContext)
      .getFrame({ contextId: '', $typeName: 'ui.v1.GetFrameRequest' }, ctxWith('Bearer good'))
      .catch(e => e)
    expect((err as ConnectError).code).toBe(Code.InvalidArgument)
  })
})
