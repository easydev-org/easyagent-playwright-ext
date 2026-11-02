/**
 * The sidecar: a browser driver, and NOTHING ELSE.
 *
 * WHAT MOVED OUT: the NATS connection, the easybus protocol, the manifest, discovery, config,
 * permissions, file ingest. All of that is now a Go process beside this one.
 *
 * WHY. The protocol has one implementation (Go). Playwright has one implementation (this file). The
 * previous arrangement had BOTH sides doing both jobs: a TypeScript SDK re-implementing subjects, KV
 * keys and envelope rules that the Go SDK already had, and which drifted — this extension was six
 * versions behind on the wire while its own tools kept working.
 *
 * WHAT A SPLIT NEEDS IS A SEAM THAT DOES NOT LEAK, and there are exactly two things that would have
 * leaked:
 *
 *   1. `page` IS NOT TRANSFERABLE. `browser-run-code-unsafe` hands the caller a live Playwright page
 *      object; no RPC can carry that. So the CODE runs here, and only the RESULT crosses.
 *   2. BINARY RESULTS need the agent's blob store. A screenshot must become the same durable
 *      `file:<code>` a generated image does, and only the Go side owns the blob backend. So bytes go
 *      out base64-encoded and are ingested there.
 *
 * The contract is ONE endpoint. Not one per tool: a per-tool RPC would mean the tool's semantics were
 * described twice — once here and once in Go — which is the same duplication this split removes. Go
 * sends a tool name and its arguments; this decides what that means.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { BrowserSession } from './context-manager.js'
import type { ContextManager } from './context-manager.js'
import { newContextLogs, pwTools, wirePageLogging, type Exec, type ToolCtx } from './tools/browser.js'
import type { PlaywrightDeps } from './deps.js'

/** Longest request body accepted, in bytes. Tool arguments are JSON and small; a megabyte is room. */
const MAX_BODY = 1 << 20

/**
 * A tool result, as it crosses to Go.
 *
 * `content` is the natural-language text the model reads. `data` is the structured value the console
 * renders. `file` is present when the tool produced BYTES — Go turns it into a `file:<code>`, because
 * the blob backend belongs there and nowhere else.
 */
interface SidecarResult {
  content: string
  data?: unknown
  file?: {
    name: string
    /** base64. It crossed as bytes; JSON is the only channel this seam has. */
    bytes: string
    mime: string
  }
}

/** One request to /exec. */
interface ExecRequest {
  tool: string
  /** Absent for `browser-create-context`, which mints one. */
  context_id?: string
  tenant: string
  session: string
  args?: Record<string, unknown>
}

interface ExecResponse {
  ok: boolean
  result?: SidecarResult
  /** The context this call ran against — the minted one, for create-context. */
  context_id?: string
  error?: string
  /** Set when the failure is the CALLER's (bad argument, missing context), not this process. */
  code?: 'invalid_argument' | 'not_found' | 'permission_denied' | 'internal'
}

export interface SidecarOptions {
  manager: ContextManager
  /** Per-action timeout, also the bound on `browser-run-code-unsafe`. */
  defaultTimeoutMs: number
  /**
   * Where to fetch a `file:<code>`'s bytes from.
   *
   * THIS IS THE ONE THING THAT STILL POINTS BACK AT GO, and it has to: the blob backend lives there.
   * It is deliberately a plain HTTP callback rather than a second protocol — the sidecar asks
   * "give me code X for tenant Y" and gets bytes, which is the whole of what it needs.
   *
   * When empty, tools that READ a file:<code> report that the file cannot be fetched rather than
   * failing obscurely.
   */
  fetchFile?: (code: string, tenant: string) => Promise<{ data: Uint8Array; name: string; mime: string }>
}

/**
 * A sidecar-local deps implementation.
 *
 * `ingestFile` DOES NOT UPLOAD. Bytes produced here travel out in the RESULT and Go stores them; this
 * returns a placeholder so a handler that wants a name still gets one. That split is what keeps the
 * blob backend in one place — a second uploader here would mean two components writing files with
 * two notions of when they expire.
 *
 * `getFile` DOES call back, because reading is the direction this process cannot do alone.
 */
function sidecarDeps(fetchFile: SidecarOptions['fetchFile']): PlaywrightDeps {
  return {
    ingestFile: async ({ name }) => ({ code: name, mime: 'application/octet-stream' }),
    getFile: async (code, tenant) => {
      if (fetchFile === undefined) {
        throw new Error(`cannot fetch ${code}: this sidecar has no file backend wired`)
      }
      return fetchFile(code, tenant ?? '')
    },
    // Session variables (locale) come from the agent too, and a sidecar has no bus. Empty is the
    // documented "unset" answer and every caller already falls back to English.
    getSessionVariable: async () => '',
  }
}

/**
 * Tools whose result is BYTES rather than text.
 *
 * A SET, NOT A CONVENTION: these handlers return `data` carrying base64 in a shape only they produce,
 * so the conversion has to be named somewhere or it would be re-derived by whoever reads the result.
 * Keeping it here means Go learns one rule — "if the result has bytes, ingest them" — instead of five.
 */
const FILE_TOOLS = new Set([
  'browser-take-screenshot',
  'browser-pdf-save',
  'browser-storage-state',
])

/**
 * Handlers that create or destroy a context, and therefore cannot run INSIDE one.
 *
 * They are routed before `withContext` is reached: create has no context yet, and close must not take
 * the per-context lock it is about to tear down.
 */
const ROUTED_TOOLS = new Set(['browser-create-context', 'browser-close-context'])

export function startSidecar(opts: SidecarOptions): { close: () => Promise<void> } {
  const tools = pwTools()

  // The deps exist so tools that produce or consume files have somewhere to go. Producing stays local
  // (the bytes ride out in the result); consuming calls back to Go, which owns the blob backend.
  const deps = sidecarDeps(opts.fetchFile)

  const run = async (req: ExecRequest): Promise<ExecResponse> => {
    const tool = req.tool
    if (tool === undefined || tool === '') {
      return { ok: false, code: 'invalid_argument', error: 'tool is required' }
    }

    if (tool === 'browser-create-context') {
      const id = await opts.manager.create(req.tenant, req.session)
      return { ok: true, context_id: id, result: { content: `context ${id}` } }
    }

    // EVERY OTHER TOOL NEEDS A CONTEXT, including close. A missing id is the caller's error and is
    // reported as one: "not found" from here is distinguishable from "the browser is broken".
    const contextId = req.context_id ?? ''
    if (contextId === '') {
      return { ok: false, code: 'invalid_argument', error: 'context_id is required for ' + tool }
    }

    if (tool === 'browser-close-context') {
      await opts.manager.close(contextId, req.tenant, req.session)
      return { ok: true, result: { content: 'context closed' } }
    }

    const handler: Exec | undefined = tools[tool]
    if (handler === undefined) {
      return { ok: false, code: 'not_found', error: `no such tool: ${tool}` }
    }

    try {
      const out = await opts.manager.withContext(
        contextId,
        req.tenant,
        req.session,
        async (session: BrowserSession) => {
          const ctx: ToolCtx = {
            manager: opts.manager,
            deps,
            logs: newContextLogs(), // replaced below with the session's own
            defaultTimeoutMs: opts.defaultTimeoutMs,
            locale: 'en',
          }
          // THE SESSION'S LOGS, NOT A FRESH SET. `browser-console-messages` reads this object, and a
          // new one per call would report an empty console every time — which reads as "the page
          // logged nothing" rather than "the collector was replaced".
          return handler({ ...ctx, logs: logsFor(session) }, session, req.args ?? {})
        },
      )

      const result: SidecarResult = { content: out.content }
      if (out.data !== undefined) {
        const asFile = FILE_TOOLS.has(tool) ? fileFrom(out.data) : null
        if (asFile !== null) result.file = asFile
        else result.data = out.data
      }
      return { ok: true, result, context_id: contextId }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // A MISSING CONTEXT IS THE CALLER'S PROBLEM and must stay distinguishable from a tool that
      // threw: Go maps this to a not_found result the model can act on, rather than retrying.
      const missing = /no context|not found|unknown context/i.test(message)
      return {
        ok: false,
        code: missing ? 'not_found' : 'internal',
        error: message,
      }
    }
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, run, opts.manager)
  })

  const port = Number.parseInt(process.env['SIDECAR_PORT'] ?? '9222', 10)
  server.listen(port, '127.0.0.1', () => {
    console.log(`[playwright] sidecar on 127.0.0.1:${port} (no protocol, no NATS)`)
  })

  return {
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve())
      }),
  }
}

/**
 * The logs a session has been accumulating.
 *
 * Stored ON THE SESSION rather than in a side table: the collectors were attached to this page, so the
 * page's own record is the only place they cannot get out of step with it.
 */
function logsFor(session: BrowserSession): ReturnType<typeof newContextLogs> {
  const holder = session as unknown as { logs?: ReturnType<typeof newContextLogs> }
  if (holder.logs === undefined) {
    holder.logs = newContextLogs()
    wirePageLogging(session.page, holder.logs)
  }
  return holder.logs
}

/**
 * Turn a tool's `data` into bytes for Go.
 *
 * THE SHAPES DIFFER BY TOOL and that is why this is one function with a switch rather than a
 * convention: a screenshot returns a Buffer under `data`, a PDF returns one under `pdf`, and
 * storage-state returns a JSON document. Guessing wrong would send an empty file and the model would
 * receive a `file:<code>` that opens to nothing.
 */
function fileFrom(data: unknown): SidecarResult['file'] | null {
  if (data === null || data === undefined) return null
  const d = data as Record<string, unknown>

  for (const key of ['bytes', 'pdf', 'data', 'buffer'] as const) {
    const v = d[key]
    if (typeof v === 'string' && v !== '') {
      return { name: String(d['name'] ?? 'file'), bytes: v, mime: String(d['mime'] ?? 'application/octet-stream') }
    }
    if (v instanceof Uint8Array) {
      return {
        name: String(d['name'] ?? 'file'),
        bytes: Buffer.from(v).toString('base64'),
        mime: String(d['mime'] ?? 'application/octet-stream'),
      }
    }
  }
  return null
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  run: (r: ExecRequest) => Promise<ExecResponse>,
  manager: ContextManager,
): Promise<void> {
  const reply = (status: number, body: unknown): void => {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }

  const path = (req.url ?? '/').split('?')[0] ?? '/'

  // A liveness probe that does NOT touch the browser: a sidecar whose Chrome is wedged is still
  // healthy as a PROCESS, and that is what the Go side's readiness needs to know.
  if (path === '/healthz') {
    reply(200, { ok: true })
    return
  }

  // Context listings for the panel. Read-only, and answered from the manager's own records, so the
  // panel keeps working even while a context is busy. Scoped by tenant, which the Go side supplies —
  // this process has no identity of its own and must not be asked to invent one.
  if (path === '/contexts' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://localhost')
    reply(200, { contexts: manager.listForTenant(url.searchParams.get('tenant') ?? '') })
    return
  }

  if (path !== '/exec' || req.method !== 'POST') {
    reply(404, { ok: false, error: 'not found' })
    return
  }

  // BOUNDED BEFORE READING. An unbounded body from a wedged caller is a way to run this process out
  // of memory, and the endpoint is reachable from the sibling container only — but "only" is not a
  // guarantee, and the bound costs one comparison.
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const b = chunk as Buffer
    size += b.length
    if (size > MAX_BODY) {
      reply(413, { ok: false, code: 'invalid_argument', error: 'request body too large' })
      return
    }
    chunks.push(b)
  }

  let parsed: ExecRequest
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ExecRequest
  } catch {
    reply(400, { ok: false, code: 'invalid_argument', error: 'body is not JSON' })
    return
  }

  try {
    const out = await run(parsed)
    reply(200, out)
  } catch (e) {
    reply(500, { ok: false, code: 'internal', error: e instanceof Error ? e.message : String(e) })
  }
}
