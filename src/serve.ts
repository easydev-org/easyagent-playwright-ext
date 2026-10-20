import { type Bus, connect, Extension } from '@easydev-org/easybus-sdk'
import {
  createPlaywrightExtension,
  type PlaywrightExtensionOpts,
} from './index.js'

export interface ServePlaywrightOpts {
  /** NATS URL the extension connects to (shared with the agent). */
  natsUrl: string
  /** Browser/extension tuning (target, timeouts, caps). */
  extension: Omit<PlaywrightExtensionOpts, 'deps' | 'getConfig'>
}

/**
 * Connect to NATS and serve the playwright extension. Resolves once the
 * extension has registered (discovery/config/tools/lifecycle subscriptions);
 * returns a stop function for shutdown.
 *
 * The extension's `selenium-url` config (per tenant, UI-editable) overrides
 * the boot-time env target; `getConfig` is bound to the live Extension so a
 * saved value takes effect on the next `browser-create-context`.
 */
export async function servePlaywright(
  opts: ServePlaywrightOpts,
): Promise<{ stop: () => Promise<void>; bus: Bus; controller: AbortController }> {
  const bus = await connect(opts.natsUrl)
  const controller = new AbortController()
  let ext: Extension | undefined
  const bundle = createPlaywrightExtension(bus, {
    ...opts.extension,
    getConfig: (name, sessionName, tenant) =>
      ext?.getConfig(tenant ?? '', name, sessionName ?? ''),
  })
  ext = new Extension(bus, bundle.config)
  await ext.serve(controller.signal)
  return {
    bus,
    controller,
    stop: async () => {
      controller.abort()
      await bundle.stop()
      await ext?.close()
    },
  }
}
