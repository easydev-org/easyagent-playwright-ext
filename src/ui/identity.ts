// Turn a bearer token into the tenant it belongs to.
//
// WHY ASK THE AGENT: the token is a row in the agent's database, and the mapping token -> tenant
// lives there. An extension cannot verify one on its own — it has no table and no key — so it asks
// the component that issued it. `AgentService.GetIdentity` already answers exactly this question, so
// no new RPC is needed.
//
// This is the same contract the Go extensions use; a panel mounted from one language must not have a
// weaker notion of identity than one mounted from another.

/** The caller presented no usable bearer. Distinct from "the agent could not be reached". */
export class Unauthenticated extends Error {
  constructor(message = 'a bearer token is required') {
    super(message)
    this.name = 'Unauthenticated'
  }
}

export interface IdentityResolver {
  /** The tenant this token belongs to. Throws `Unauthenticated` when it does not. */
  tenant(token: string): Promise<string>
}

export interface IdentityOpts {
  /** The agent's base URL, e.g. http://agent.dev.svc.cluster.local */
  agentURL: string
  /** Injected for tests. */
  fetch?: typeof fetch
}

/**
 * A resolver backed by the agent's `GetIdentity`.
 *
 * A failure to REACH the agent is deliberately NOT `Unauthenticated`: a network fault must not look
 * like an invalid credential, or a brief outage would log every reader out with a misleading message.
 * The caller distinguishes the two and answers 503 vs 401.
 */
export function agentIdentity(opts: IdentityOpts): IdentityResolver {
  const doFetch = opts.fetch ?? fetch
  return {
    async tenant(token: string): Promise<string> {
      if (token.trim() === '') throw new Unauthenticated()
      if (opts.agentURL === '') throw new Error('identity: no agent URL configured')

      const res = await doFetch(
        `${opts.agentURL.replace(/\/+$/, '')}/agent.v1.AgentService/GetIdentity`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: '{}',
          // A hung agent must not hold a panel request open indefinitely.
          signal: AbortSignal.timeout(5000),
        },
      )
      if (res.status === 401 || res.status === 403) {
        throw new Unauthenticated('the token was rejected')
      }
      if (!res.ok) {
        // Reached the agent, got an error we do not understand. NOT an auth failure.
        throw new Error(`identity: agent answered ${res.status}`)
      }
      const body = (await res.json()) as { tenant?: unknown }
      const tenant = typeof body.tenant === 'string' ? body.tenant : ''
      if (tenant === '') throw new Unauthenticated('the token maps to no tenant')
      return tenant
    },
  }
}
