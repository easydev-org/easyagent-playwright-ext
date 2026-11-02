/**
 * The runtime surface a browser tool relies on.
 *
 * TWO OF THE THREE ARE NOW CALLBACKS OUT OF THIS PROCESS, and that is the seam the split is built
 * around: the blob backend and the session-variable projection both live in the Go shell, so a
 * sidecar cannot answer them itself. They stay declared here because the tools do not care who
 * answers — they ask for bytes and get bytes.
 *
 * `ingestFile` is the exception and is deliberately LOCAL: bytes produced here travel out in the tool
 * result and the Go shell stores them, so a second uploader in this process would mean two
 * components writing files with two notions of when they expire.
 */
export interface PlaywrightDeps {
  /** Name local bytes for the caller; the Go shell performs the actual ingest. */
  ingestFile: (input: {
    name: string
    data: Uint8Array
    session?: string
    tenant?: string
  }) => Promise<{ code: string; mime: string }>
  /** Fetch stored bytes. Answered by the Go shell, which owns the blob backend. */
  getFile: (
    code: string,
    tenant?: string,
  ) => Promise<{ data: Uint8Array; name: string; mime: string }>
  /** Read a session variable the agent projects (e.g. `locale`). '' when unset. */
  getSessionVariable: (
    tenant: string,
    provider: string,
    sessionName: string,
    name: string,
  ) => Promise<string>
}
