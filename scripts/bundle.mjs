import { build } from 'esbuild'

// Bundle the SIDECAR into one ESM file, so the runtime image needs no transpiler.
//
// IT BUNDLES LESS THAN IT USED TO. The easybus SDK is gone — the protocol moved to Go — so what is
// inlined now is the tool layer, the context manager and the HTTP endpoint. `playwright-core` stays
// external: it is a real package with its own runtime files, not something to inline.
//
// THE MANIFEST IS NO LONGER INLINED. `src/main.ts` does not import it any more: the Go shell reads it
// at startup, and the sidecar is told what to do per call. That is why the `.yaml` loader below is
// only a fallback for any stale import a future edit reintroduces.
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  outfile: 'dist/main.js',
  external: ['playwright-core'],
  loader: { '.yaml': 'text' },
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
})
