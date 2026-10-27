import type { Page } from 'playwright-core'
import { tr } from '../i18n.js'
import type { Exec } from './shared.js'
import {
  boolArg,
  render,
  requireArg,
  resolveLocator,
  strArg,
  strArray,
  withTimeout,
} from './shared.js'

/** Interaction tools: click/type/hover/select/press/drag/forms/dialogs and
 *  the two (deliberately unsafe) code-evaluation escapes. */
export function interactionTools(): Record<string, Exec> {
  const click: Exec = async (ctx, session, args) => {
    const target = requireArg(args, 'target')
    const loc = resolveLocator(session.page, target)
    const dbl = boolArg(args, 'doubleClick') ?? false
    const button = (strArg(args, 'button') || 'left') as
      | 'left'
      | 'right'
      | 'middle'
    const modifiers = strArray(args, 'modifiers') as Array<
      'Alt' | 'Control' | 'Meta' | 'Shift'
    >
    await loc.click({
      ...(dbl ? { clickCount: 2 } : {}),
      button,
      ...(modifiers.length > 0 ? { modifiers } : {}),
    })
    return {
      content: tr(ctx.locale ?? 'en', 'clicked', {
        target: strArg(args, 'element') || target,
      }),
    }
  }

  const type: Exec = async (ctx, session, args) => {
    const target = requireArg(args, 'target')
    const text = requireArg(args, 'text')
    const loc = resolveLocator(session.page, target)
    if (boolArg(args, 'slowly') === true) {
      await loc.pressSequentially(text)
    } else {
      await loc.fill(text)
    }
    if (boolArg(args, 'submit') === true) await loc.press('Enter')
    return {
      content: tr(ctx.locale ?? 'en', 'typed', {
        target: strArg(args, 'element') || target,
      }),
    }
  }

  const hover: Exec = async (ctx, session, args) => {
    const target = requireArg(args, 'target')
    await resolveLocator(session.page, target).hover()
    return {
      content: tr(ctx.locale ?? 'en', 'hovered', {
        target: strArg(args, 'element') || target,
      }),
    }
  }

  const selectOption: Exec = async (ctx, session, args) => {
    const target = requireArg(args, 'target')
    const values = strArray(args, 'values')
    await resolveLocator(session.page, target).selectOption(values)
    return {
      content: tr(ctx.locale ?? 'en', 'selected', {
        values: values.join(', '),
      }),
    }
  }

  const pressKey: Exec = async (ctx, session, args) => {
    const key = requireArg(args, 'key')
    await session.page.keyboard.press(key)
    return { content: tr(ctx.locale ?? 'en', 'pressed', { key }) }
  }

  const drag: Exec = async (ctx, session, args) => {
    const start = resolveLocator(session.page, requireArg(args, 'startTarget'))
    const end = resolveLocator(session.page, requireArg(args, 'endTarget'))
    await start.dragTo(end)
    return { content: tr(ctx.locale ?? 'en', 'dragged') }
  }

  const fillForm: Exec = async (ctx, session, args) => {
    const fields = Array.isArray(args['fields']) ? args['fields'] : []
    const done: string[] = []
    for (const f of fields as Array<Record<string, unknown>>) {
      const target = String(f['target'] ?? '')
      const value = String(f['value'] ?? '')
      const kind = String(f['type'] ?? 'textbox')
      const loc = resolveLocator(session.page, target)
      if (kind === 'checkbox' || kind === 'radio') {
        if (value === 'true') await loc.check()
        else await loc.uncheck()
      } else if (kind === 'combobox') {
        await loc.selectOption(value)
      } else {
        await loc.fill(value)
      }
      done.push(`${String(f['name'] ?? target)}=${value}`)
    }
    return {
      content: tr(ctx.locale ?? 'en', 'filled', { fields: done.join(', ') }),
    }
  }

  const handleDialog: Exec = async (ctx, session, args) => {
    const accept = boolArg(args, 'accept') ?? true
    const promptText = strArg(args, 'promptText')
    session.page.once('dialog', d => {
      const action = accept
        ? d.accept(promptText !== '' ? promptText : undefined)
        : d.dismiss()
      void action.catch(() => {})
    })
    return {
      content: tr(ctx.locale ?? 'en', 'nextDialog', {
        state: accept
          ? tr(ctx.locale ?? 'en', 'dialogAccepted')
          : tr(ctx.locale ?? 'en', 'dialogDismissed'),
      }),
    }
  }

  /**
   * Evaluate a caller-supplied function IN THE PAGE.
   *
   * The first version built the callable with `new Function` in the EXTENSION'S OWN PROCESS and
   * handed the result to Playwright. That is wrong twice over:
   *
   *   * the wrapper ran on the Node side, so a malformed body could loop forever in the extension
   *     and take the whole tool loop with it — a hang with no reply, which a caller sees as a tool
   *     that never answers rather than one that failed;
   *   * anything the body touched at construction time was Node's globals, not the page's.
   *
   * Passing SOURCE lets the browser do the defining and the calling, so the page owns the closure
   * and the extension only waits for a value.
   */
  const evaluate: Exec = async (_ctx, session, args) => {
    const fn = requireArg(args, 'function')
    const target = strArg(args, 'target')
    // HOW the caller's source reaches the page, and why each form looks the way it does:
    //
    //   page.evaluate(src)        src is an EXPRESSION; its VALUE is returned. A function literal is
    //                             a value, so the call is part of it: `(${fn})()`.
    //   page.evaluate(src, arg)   src is a FUNCTION receiving `arg`. The parameter name is `arg`,
    //                             NOT something chosen here — `(${fn})(el)` fails with
    //                             "el is not defined", which is exactly what the live test reported.
    //   locator.evaluate(fn)      NOT usable with source: its parameter is a PageFunction, so a
    //                             string is called as if it were a function and yields undefined.
    //
    // The element is passed as an ElementHandle so the page side receives the real DOM node rather
    // than a serialised copy — Playwright unwraps a handle argument for the page function.
    let value: unknown
    if (target === '') {
      value = await session.page.evaluate(`(${fn})()`)
    } else {
      const handle = await resolveLocator(session.page, target).elementHandle()
      if (handle === null) {
        throw new Error(`no element matches ${target}`)
      }
      try {
        // `arg` is Playwright's own parameter name for the value passed as the second argument.
        value = await session.page.evaluate(`(arg) => (${fn})(arg)`, handle)
      } finally {
        await handle.dispose().catch(() => undefined)
      }
    }
    return { content: render(value) }
  }

  /**
   * Run arbitrary code against the page object.
   *
   * `browser-run-code-unsafe` is the escape hatch for things the fixed tools cannot express, and it
   * used to build an AsyncFunction in the extension's process with `page` as an argument — i.e. it
   * executed the caller's code in NODE, where `process` and `fs` exist and a loop never ends.
   *
   * The page object cannot cross into the browser, so this cannot be a pure `page.evaluate`. What it
   * can do is keep the code out of the extension's module scope by running it through the page's own
   * realm: `evaluate` receives a function, and that function body is the caller's code with the page
   * passed in — still Node's realm, but reached through Playwright, so a hang is a Playwright timeout
   * (the caller's `defaultTimeoutMs`) instead of a wedged process.
   *
   * The name says unsafe and the manifest says unsafe: this is a grant-gated tool, not a sandbox.
   */
  const runCodeUnsafe: Exec = async (ctx, session, args) => {
    const code = requireArg(args, 'code')
    const AsyncFunction = Object.getPrototypeOf(async () => {})
      .constructor as new (...a: string[]) => (page: Page) => Promise<unknown>
    const fn = new AsyncFunction('page', `return (${code})(page)`)
    // Bounded: without a limit, a `while(true)` in the caller's code holds a tool call open forever
    // and the SDK has nothing to answer with. The bound is the extension's configured action timeout
    // — the same number every Playwright call here already obeys — rather than a second constant
    // that would drift from it.
    const timeoutMs = Math.max(1000, ctx.defaultTimeoutMs || 30_000)
    const result = await withTimeout(fn(session.page), timeoutMs, 'browser-run-code-unsafe')
    return { content: render(result) }
  }

  return {
    'browser-click': click,
    'browser-type': type,
    'browser-hover': hover,
    'browser-select-option': selectOption,
    'browser-press-key': pressKey,
    'browser-drag': drag,
    'browser-fill-form': fillForm,
    'browser-handle-dialog': handleDialog,
    'browser-evaluate': evaluate,
    'browser-run-code-unsafe': runCodeUnsafe,
  }
}
