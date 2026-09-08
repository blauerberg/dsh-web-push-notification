import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { rm } from 'node:fs/promises'

const dshExternal = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-*']

await rm('lib', { recursive: true, force: true })

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: [...dshExternal, 'web-push'],
  logLevel: 'info',
})

await build({
  entryPoints: ['src/invariant.ts'],
  outfile: 'lib/invariant.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: dshExternal,
  logLevel: 'info',
})

await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  jsx: 'automatic',
  external: [...dshExternal, 'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'scheduler'],
  banner: {
    js: "window.__ModuleLoader__.load({ id: 'dsh-web-push-notification', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
})

execFileSync('node_modules/.bin/tsc', ['-p', 'tsconfig.json'], { stdio: 'inherit' })
