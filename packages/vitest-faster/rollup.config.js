import { builtinModules, createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import nodeResolve from '@rollup/plugin-node-resolve'
import oxc from 'unplugin-oxc/rollup'

const require = createRequire(import.meta.url)
const pkg = require('./package.json')

// The FASTER decision code is bundled verbatim from the fork's sources. Only the
// fork's internal helpers that depend on Vitest internals are replaced here.
const shims = {
  '../../utils/env': fileURLToPath(new URL('./src/shims/env.ts', import.meta.url)),
  '@vitest/utils/helpers': fileURLToPath(new URL('./src/shims/helpers.ts', import.meta.url)),
}

const external = [
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`),
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
  /^vitest(\/|$)/,
  /^@vitest\/coverage-v8(\/|$)/,
  /^vite(\/|$)/,
]

export default () => [
  {
    input: {
      index: 'src/index.ts',
      coverage: 'src/coverage.ts',
      runner: 'src/runner.ts',
      cli: 'src/cli.ts',
    },
    output: {
      dir: 'dist',
      format: 'esm',
      chunkFileNames: 'chunks/[name].[hash].js',
    },
    external,
    plugins: [
      {
        name: 'faster-shims',
        resolveId(source) {
          return shims[source] ?? null
        },
      },
      nodeResolve({ extensions: ['.ts', '.js', '.mjs'] }),
      oxc({ transform: { target: 'node20' } }),
    ],
  },
]
