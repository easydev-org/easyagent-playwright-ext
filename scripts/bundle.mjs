import { build } from 'esbuild'

// Bundle the extension + the SDK. The SDK now ships COMPILED JS from the public
// npm registry (`@easydev-org/easybus-sdk`), so there is no TS source to bundle
// from node_modules — esbuild just inlines the runtime the extension imports
// into a single ESM file so the runtime image needs no transpiler.
// `playwright-core` is precompiled JS and stays external (it is a real,
// resolvable package), as do Node builtins.
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  outfile: 'dist/main.js',
  external: ['playwright-core'],
  // The manifest is imported as a raw string; inline it into the bundle.
  loader: { '.yaml': 'text' },
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
})
