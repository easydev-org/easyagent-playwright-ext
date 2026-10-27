/**
 * `browser-evaluate` must send SOURCE to the page, not a function built in this process.
 *
 * The first version wrapped the caller's body with `new Function(...)` HERE and handed the result to
 * Playwright. Two consequences, one of them a hang: the wrapper ran on the Node side, so a malformed
 * or looping body took the extension with it and the tool call never answered.
 *
 * These tests assert the shape that reaches Playwright — a string whose value is a function being
 * CALLED — because that is what makes the page own the closure.
 */
import { describe, expect, it } from 'vitest'
import { interactionTools } from '../src/tools/interact.js'
import type { BrowserSession } from '../src/context-manager.js'

/** A page double that records what evaluate was given and returns a canned value. */
function fakeSession(seen: string[]): BrowserSession {
  const page = {
    evaluate: (arg: unknown) => {
      seen.push(String(arg))
      return Promise.resolve(7)
    },
    getDefaultTimeout: () => 5000,
    locator: () => ({
      evaluate: (arg: unknown) => {
        seen.push(String(arg))
        return Promise.resolve(7)
      },
    }),
  }
  return { page } as unknown as BrowserSession
}

const ctx = { locale: 'en', defaultTimeoutMs: 5000 } as never

describe('browser-evaluate', () => {
  it('sends a CALLING wrapper as source, not a constructed function', async () => {
    const seen: string[] = []
    const tools = interactionTools()
    await tools['browser-evaluate']!(ctx, fakeSession(seen), { function: '() => 1+1' })

    expect(seen).toHaveLength(1)
    const src = seen[0]!
    expect(typeof src).toBe('string')
    // The wrapper must INVOKE the caller's function. Playwright treats a string as an expression and
    // returns its value WITHOUT calling it, so `(() => 1+1)` alone serialises to nothing — which is
    // exactly the empty result the live browser test caught.
    expect(src).toContain('() => 1+1')
    expect(src).toMatch(/\(\s*\(\) => 1\+1\s*\)\s*\(\s*\)/)
  })

  it('passes the element when a target is given', async () => {
    const seen: string[] = []
    const tools = interactionTools()
    await tools['browser-evaluate']!(ctx, fakeSession(seen), {
      function: '(el) => el.textContent',
      target: '#x',
    })
    expect(seen[0]).toMatch(/\(el\)\s*=>/)
    // The element form IS called by Playwright, with the element as the argument.
    expect(seen[0]).toContain('(el)')
  })

  // A missing argument must be an ERROR, not a hang. This is the case the report could not get a
  // reply for at all, so it is worth pinning: the SDK turns a throw into a tool error, and a hang
  // into nothing.
  it('throws on a missing function instead of hanging', async () => {
    const tools = interactionTools()
    await expect(
      tools['browser-evaluate']!(ctx, fakeSession([]), {}),
    ).rejects.toThrow(/function is required/)
  })
})

describe('withTimeout', () => {
  it('rejects rather than waiting forever', async () => {
    const { withTimeout } = await import('../src/tools/shared.js')
    const never = new Promise<never>(() => {})
    await expect(withTimeout(never, 30, 'op')).rejects.toThrow(/op: no result after 30ms/)
  })

  it('passes a fast value through', async () => {
    const { withTimeout } = await import('../src/tools/shared.js')
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'op')).resolves.toBe('ok')
  })
})

