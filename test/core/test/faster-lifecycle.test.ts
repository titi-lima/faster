import type { TestRunEndReason, Vitest } from 'vitest/node'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { captureTestRunSourceSnapshots, getTestSourceChanges, saveTestRunSourceSnapshots } from '../../../packages/vitest/src/node/faster/sourceChanges'
import { runInlineTests, runVitest } from '../../test-utils'

const options = { cache: { dir: 'node_modules/.vite' }, fileParallelism: false, maxWorkers: 1 }
const files = {
  'a.test.ts': `import { test } from 'vitest'; test('a', () => {})`,
  'b.test.ts': `import { test } from 'vitest'; test('b', () => {})`,
}

test.each([
  { faster: false },
  { faster: { changed: false } },
  { faster: true, cache: false as const },
])('does not persist source history with %j', async (config) => {
  const { ctx, root } = await runInlineTests(files, { ...options, ...config })
  const directory = ctx!.config.cache === false ? resolve(root, 'node_modules/.vite/vitest') : ctx!.config.cache.dir
  expect(existsSync(resolve(directory, 'faster-sources.json'))).toBe(false)
})

test('recovers malformed entries independently and clears source history with results', async () => {
  const { ctx } = await runInlineTests(files, options)
  const specifications = await ctx!.globTestSpecifications()
  const path = resolve(ctx!.config.cache === false ? '' : ctx!.config.cache.dir, 'faster-sources.json')
  const state = JSON.parse(await readFile(path, 'utf8'))
  const key = Object.keys(state.tests).find(key => key.endsWith(':b.test.ts'))!
  state.tests[key] = []
  await writeFile(path, JSON.stringify(state))
  const changes = await getTestSourceChanges(ctx!, specifications)
  expect(Object.fromEntries([...changes].map(([specification, change]) => [basename(specification.moduleId), change.known])))
    .toEqual({ 'a.test.ts': true, 'b.test.ts': false })
  await ctx!.experimental_clearCache()
  expect(existsSync(path)).toBe(false)
  expect([...await getTestSourceChanges(ctx!, specifications)].every(([, change]) => !change.known)).toBe(true)
})

test('tracks edits made during execution against the source that was executed', async () => {
  const { ctx } = await runInlineTests({
    'a.test.ts': `
      import { appendFileSync } from 'node:fs'
      import { fileURLToPath } from 'node:url'
      import { test } from 'vitest'
      test('edit source', () => {
        appendFileSync(fileURLToPath(import.meta.url), '\\n// changed during execution\\n')
      })
    `,
  }, options)
  const specifications = await ctx!.globTestSpecifications()
  expect([...await getTestSourceChanges(ctx!, specifications)].map(([, change]) => change))
    .toEqual([{ known: true, changed: true, testChanged: true, changedDependencies: 0 }])
})

test('updates only completed projects when projects share the same test path', async () => {
  const { ctx, fs } = await runInlineTests({ 'shared.test.ts': files['a.test.ts'] }, {
    ...options,
    projects: ['a', 'b'].map(name => ({ test: { name, include: ['shared.test.ts'] } })),
  })
  const specifications = await ctx!.globTestSpecifications()
  fs.editFile('shared.test.ts', source => `${source}\n// changed\n`)
  const snapshots = await captureTestRunSourceSnapshots(ctx!, specifications)
  await saveTestRunSourceSnapshots(ctx!, snapshots, ctx!.state.getFiles().filter(file => file.projectName === 'a'))
  expect(Object.fromEntries([...await getTestSourceChanges(ctx!, specifications)]
    .map(([specification, change]) => [specification.project.name, change.changed])))
    .toEqual({ a: false, b: true })
})

test('does not advance source history when a rerun is interrupted', async () => {
  let vitest: Vitest
  let cancel = false
  let reason: TestRunEndReason | undefined
  const { ctx, fs } = await runInlineTests(files, {
    ...options,
    reporters: [{
      onInit(ctx) {
        vitest = ctx
      },
      onTestModuleCollected() {
        if (cancel) {
          void vitest.cancelCurrentRun('keyboard-input')
        }
      },
      onTestRunEnd(_, __, currentReason) {
        reason = currentReason
      },
    }],
  })
  fs.editFile('a.test.ts', source => `${source}\n// changed\n`)
  fs.editFile('b.test.ts', source => `${source}\n// changed\n`)
  cancel = true
  const specifications = await ctx!.globTestSpecifications()
  await ctx!.runTestSpecifications(specifications)
  expect(reason).toBe('interrupted')
  expect([...await getTestSourceChanges(ctx!, specifications)].map(([, change]) => change.changed)).toEqual([true, true])
})

test('honors per-project opt-outs for ordering and source history', async () => {
  const order: string[] = []
  const config = {
    ...options,
    reporters: [{
      onTestCaseReady(testCase: { name: string }) {
        order.push(testCase.name)
      },
    }],
    projects: [
      { test: { name: 'active', include: ['active.test.ts'], sequence: { groupOrder: 0 } } },
      { test: { name: 'plain', include: ['a.test.ts', 'b.test.ts'], faster: false, sequence: { groupOrder: 1 } } },
    ],
  }
  const first = await runInlineTests({
    'active.test.ts': `import { test } from 'vitest'; test('active', () => {})`,
    'a.test.ts': `import { test } from 'vitest'; test('plain fast', () => {})`,
    'b.test.ts': `import { test } from 'vitest'; test('plain slow', async () => new Promise(resolve => setTimeout(resolve, 40)))`,
  }, config)
  await first.ctx!.close()
  order.length = 0
  const { ctx } = await runVitest({ ...config, root: first.root })
  expect(order).toEqual(['active', 'plain slow', 'plain fast'])
  const path = resolve(ctx!.config.cache === false ? '' : ctx!.config.cache.dir, 'faster-sources.json')
  expect(Object.keys(JSON.parse(await readFile(path, 'utf8')).tests)).toEqual([expect.stringMatching(/^active:/)])
})

test('retains optional Git revision comparisons without snapshot history', async () => {
  const order: string[] = []
  const config = {
    ...options,
    faster: { changed: false },
    reporters: [{
      onTestCaseReady(testCase: { name: string }) {
        order.push(testCase.name)
      },
    }],
  }
  const first = await runInlineTests({
    ...files,
    'src/value.ts': 'export const value = 1',
    'b.test.ts': `import { test } from 'vitest'; import { value } from './src/value'; test('b', () => value)`,
    '.faster/priorities.json': JSON.stringify({ schemaVersion: 1, tests: { 'a.test.ts': 10, 'b.test.ts': 1 } }),
  }, config)
  await first.ctx!.close()
  const git = async (...args: string[]) => (await promisify(execFile)('git', args, { cwd: first.root })).stdout.trim()
  await git('init', '-b', 'main')
  await git('add', 'src/value.ts', 'a.test.ts', 'b.test.ts')
  const commit = () => git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-am', 'fixture')
  await commit()
  const revision = await git('rev-parse', 'HEAD')
  first.fs.editFile('src/value.ts', source => `${source}\n// changed\n`)
  await commit()
  order.length = 0
  await runVitest({ ...config, root: first.root, faster: { changed: revision } })
  expect(order).toEqual(['b', 'a'])
})
