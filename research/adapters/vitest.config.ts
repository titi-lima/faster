import { resolve } from 'node:path'
import ResearchReporter from './vitest-reporter'

const root = process.env.FASTER_REPLICATION_ROOT!
const project = process.env.FASTER_REPLICATION_PROJECT
const phase = process.env.FASTER_REPLICATION_PHASE
const pinia = project === 'pinia'

export default {
  root,
  resolve: {
    conditions: pinia ? undefined : ['@zod/source', 'default'],
    alias: pinia
      ? [{ find: /^pinia$/, replacement: resolve(root, 'packages/pinia/src') }]
      : [
          { find: /^zod\/v4\/core$/, replacement: resolve(root, 'packages/zod/src/v4/core/index.ts') },
          { find: /^zod\/mini$/, replacement: resolve(root, 'packages/zod/src/mini/index.ts') },
          { find: /^zod\/v4\/mini$/, replacement: resolve(root, 'packages/zod/src/v4/mini/index.ts') },
          { find: /^zod\/v4$/, replacement: resolve(root, 'packages/zod/src/v4/index.ts') },
          { find: /^zod$/, replacement: resolve(root, 'packages/zod/src/index.ts') },
        ],
  },
  define: pinia ? { __DEV__: 'true', __TEST__: 'true', __BROWSER__: 'true', __USE_DEVTOOLS__: 'false' } : undefined,
  test: {
    name: project,
    include: pinia ? ['packages/pinia/__tests__/*.spec.ts'] : ['packages/zod/src/v4/classic/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.test-d.ts', '**/dist.test.ts'],
    cache: { dir: resolve(root, '.study-cache') },
    faster: phase === 'base' ? false : { changed: true, optimizeFor: 'apfd', selectAffected: phase === 'selected', immediateFailureOutput: false },
    fileParallelism: false,
    maxWorkers: 1,
    pool: 'forks',
    isolate: true,
    typecheck: { enabled: false },
    environment: pinia ? 'happy-dom' : 'node',
    setupFiles: pinia ? [resolve(root, 'packages/pinia/__tests__/vitest-setup.ts')] : [],
    fakeTimers: pinia ? { now: 1_000_000_000_000 } : undefined,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    watch: false,
    reporters: ['default', new ResearchReporter()],
  },
}
