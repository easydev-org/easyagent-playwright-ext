/**
 * Permission enforcement, playwright side.
 *
 * The THIRD shape of the same mechanism: gitea guards a repository slug, sandbox-ext guards a
 * sandbox name, and this one guards a browser context. Nothing about the mechanism changes — the
 * agent asks "does this session hold a grant for this key", and this file decides whether that
 * grant covers the context this call is about to drive.
 *
 * WHY a context and not "the browser": a session may hold several contexts at once (one per tab
 * tree it is working in), and a session trusted to click around in its own scratch context should
 * not automatically be trusted to drive one it did not create.
 */

import { requirePermission, type GrantParams } from '@easydev-org/easybus-sdk'

/** Permission keys this extension declares. */
export const PermBrowserRead = 'browser.read'
export const PermBrowserDrive = 'browser.drive'
export const PermBrowserScript = 'browser.script'

/**
 * The target of a call is the browser context it drives.
 *
 * `*` covers any context — the common grant, because a session normally drives the contexts it
 * created itself.
 */
function target(contextId: string): GrantParams {
  return { context: contextId === '' ? '*' : contextId }
}

/**
 * requireRead guards navigation, snapshots, screenshots and anything else that only observes.
 *
 * Reads are gated, unlike the other two extensions, because a browser context is not the
 * session's own data: it can hold a logged-in session, and "look at what is on the page" is
 * exactly what an attacker with a stolen context id would do. The three keys are ordered —
 * `script` implies `drive` implies `read` — so a grant for the broadest one covers the others.
 */
export function requireRead(ctx: AbortSignal, contextId: string): void {
  requireAny(ctx, [PermBrowserRead, PermBrowserDrive, PermBrowserScript], contextId)
}

/**
 * requireDrive guards anything that changes the page: click, type, upload, drag.
 */
export function requireDrive(ctx: AbortSignal, contextId: string): void {
  requireAny(ctx, [PermBrowserDrive, PermBrowserScript], contextId)
}

/**
 * requireScript guards arbitrary code execution in the page: evaluate, run-code-unsafe,
 * set-storage-state.
 *
 * This is the broadest grant this extension offers: code running in the page can read and write
 * everything the page can reach, which includes the drive and read capabilities below it.
 */
export function requireScript(ctx: AbortSignal, contextId: string): void {
  requireAny(ctx, [PermBrowserScript], contextId)
}

/**
 * requireAny accepts a call if it is covered by ANY of the listed keys.
 *
 * The first refusal is raised, so the message names the narrowest key the caller lacks — which is
 * the one a user would have to grant.
 */
function requireAny(ctx: AbortSignal, keys: string[], contextId: string): void {
  const t = target(contextId)
  let firstErr: unknown = null
  for (const key of keys) {
    try {
      requirePermission(ctx, key, t)
      return
    } catch (e) {
      if (firstErr === null) firstErr = e
    }
  }
  throw firstErr
}

/**
 * Tools that only OBSERVE the page.
 *
 * Enumerated rather than pattern-matched on names: "browser-file-upload" reads like a read and
 * writes the page, and a name-based rule would have put it here.
 */
const READ_TOOLS = new Set([
  'browser-navigate',
  'browser-navigate-back',
  'browser-snapshot',
  'browser-find',
  'browser-wait-for',
  'browser-tabs',
  'browser-console-messages',
  'browser-network-requests',
  'browser-network-request',
  'browser-take-screenshot',
  'browser-pdf-save',
])

/**
 * Tools that execute ARBITRARY CODE in the page.
 *
 * These get their own key because the consequence is different in kind from clicking: code running
 * in the page can read the DOM, the network, storage, and anything the site's own scripts can.
 */
const SCRIPT_TOOLS = new Set([
  'browser-evaluate',
  'browser-run-code-unsafe',
  'browser-set-storage-state',
])

/**
 * requireForTool applies the permission matching the tool's effect on the page.
 *
 * Anything not listed requires `drive`: when a new tool is added and nobody classifies it, the
 * failure mode should be "the session needs a grant" rather than "the session silently can".
 */
export function requireForTool(ctx: AbortSignal, tool: string, contextId: string): void {
  if (SCRIPT_TOOLS.has(tool)) {
    requireScript(ctx, contextId)
    return
  }
  if (READ_TOOLS.has(tool)) {
    requireRead(ctx, contextId)
    return
  }
  requireDrive(ctx, contextId)
}
