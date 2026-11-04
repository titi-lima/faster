import { builtinModules, createRequire } from 'node:module'
import nodeResolve from '@rollup/plugin-node-resolve'
import oxc from 'unplugin-oxc/rollup'

const require = createRequire(import.meta.url)
const pkg = require('./package.json')

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
      nodeResolve({ extensions: ['.ts', '.js', '.mjs'] }),
      oxc({ transform: { target: 'node20' } }),
    ],
  },
]
