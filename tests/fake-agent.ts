/**
 * The part of the AGENT this extension's file tools depend on, and nothing else.
 *
 * `ingestFile` is a request to the agent on `easybus.<tenant>.file.ingest`: the extension has
 * already put the bytes in the transient object store and asks the agent to persist them and
 * return a code plus the media type it DERIVED from those bytes.
 *
 * A test with no agent has two honest options for that request: skip the file tools, or answer it.
 * Skipping would leave screenshots and PDFs — the tools whose output is bytes rather than text —
 * completely unverified, so this answers it. It is deliberately NOT a stub that returns a canned
 * code: it FETCHES the object the extension wrote, so a screenshot that never reached the store
 * fails here instead of passing on a fabricated reply.
 */
import { type Bus, tenantObjectName } from '@easydev-org/easybus-sdk'
import { chFileIngest } from '@easydev-org/easybus-sdk/protocol'

/** The subset of the wire shapes this responder reads and writes. */
interface FileIngestRequest {
  code?: string
  name: string
  object: string
  session_name?: string
}

interface FileIngestResponse {
  ok: boolean
  code?: string
  mime?: string
  error?: { code: string; message: string }
}

/**
 * Derive a media type from the first bytes, which is what the agent does.
 *
 * Sniffing rather than trusting the filename: the extension names a screenshot
 * `screenshot-<ts>.png`, so a name-based answer would agree with itself even if the bytes were
 * something else entirely.
 */
function sniffMime(data: Uint8Array): string {
  const b = data
  const starts = (...sig: number[]): boolean => sig.every((v, i) => b[i] === v)
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57) return 'image/webp'
  if (starts(0x25, 0x50, 0x44, 0x46)) return 'application/pdf'
  return 'application/octet-stream'
}

/**
 * Start answering `file.ingest` for one tenant. Returns a stop function.
 */
export async function serveFakeAgentFiles(bus: Bus, tenant: string, signal: AbortSignal): Promise<void> {
  const sub = await bus.subscribe(signal, chFileIngest(tenant), {})
  void (async () => {
    for (;;) {
      const env = await sub.next(signal)
      if (!env) return
      if (!env.replyTo) continue // the transport always sets it; a request without one is a bug
      const req = env.payload as unknown as FileIngestRequest
      let res: FileIngestResponse
      try {
        // READ WHAT THE EXTENSION ACTUALLY WROTE. This is the assertion the test is really making:
        // a canned reply would let a broken screenshot pass.
        const data = await bus.objectGet(signal, tenantObjectName(tenant, req.object))
        if (!data || data.length === 0) {
          res = { ok: false, error: { code: 'not_found', message: `object ${req.object} is empty or missing` } }
        } else {
          res = { ok: true, code: req.code ?? `file-${req.object}`, mime: sniffMime(data) }
        }
      } catch (e) {
        res = { ok: false, error: { code: 'internal', message: e instanceof Error ? e.message : String(e) } }
      }
      // The responder pattern every extension uses: publish to the request's reply subject. There
      // is no dedicated `reply` on the Bus — a reply IS a publish to replyTo, which is also why the
      // tenant has to ride the options here.
      await bus.publish(signal, env.replyTo, res, { tenant })
    }
  })()
}
