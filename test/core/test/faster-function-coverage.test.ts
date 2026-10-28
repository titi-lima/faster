import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'pathe'
import { expect, test } from 'vitest'
import { createCLI } from '../../../packages/vitest/src/node/cli/cac'
import { createFunctionModel } from '../../../packages/vitest/src/node/faster/functionCoverage'
import { resolveFasterOptions } from '../../../packages/vitest/src/node/faster/priorityManifest'
import { runInlineTests, runVitest } from '../../test-utils'

test('fingerprints nested function bodies separately from their enclosing function', async () => {
  const before = await createFunctionModel('export function outer() { return () => 1 }')
  const after = await createFunctionModel('export function outer() { return () => 2 }')
  expect(before.shape).toBe(after.shape)
  expect(before.functions.map(fn => fn.hash === after.functions.find(other => other.id === fn.id)?.hash))
    .toEqual([true, false])
  const top = await createFunctionModel('const value = 2; export function outer() { return () => 1 }')
  expect(top.shape).not.toBe(before.shape)
})

const files = {
  'src/index.ts': `export { left, right } from './value'`,
  'src/value.ts': `export function left() { return 1 }; export function right() { return 2 }`,
  'left.test.ts': `import { expect, test } from 'vitest'; import { left } from './src'; test('left', () => expect(left()).toBe(1))`,
  'right.test.ts': `import { expect, test } from 'vitest'; import { right } from './src'; test('right', () => expect(right()).toBe(2))`,
}
const options = {
  cache: { dir: 'node_modules/.vite' },
  faster: { selectAffected: true },
  fileParallelism: false,
  maxWorkers: 1,
}

test('accepts the opt-in CLI controls and rejects invalid tracking options', () => {
  expect(resolveFasterOptions('/repo', {}).selectAffected).toBe(false)
  expect(() => resolveFasterOptions('/repo', { changed: false, selectAffected: true })).toThrow('requires faster.changed')
  expect(createCLI().parse(['node', 'vitest', 'run', '--faster.selectAffected'], { run: false }).options.faster)
    .toEqual({ selectAffected: true })
})

test('keeps nested callback edits separate even when both files call the enclosing factory', async () => {
  const first = await runInlineTests({
    ...files,
    'src/value.ts': 'function factory() { return { left: () => 1, right: () => 2 } }; export function left() { return factory().left() }; export function right() { return factory().right() }',
  }, options)
  await first.ctx!.close()
  first.fs.editFile('src/value.ts', source => source.replace('left: () => 1', 'left: () => 3'))
  const second = await runVitest({ ...options, root: first.root })
  expect(second.ctx!.state.getFiles().map(file => file.name)).toEqual(['left.test.ts'])
})

test('finishes an unchanged warm run successfully without selecting files', async () => {
  const first = await runInlineTests(files, options)
  await first.ctx!.close()
  const second = await runVitest({ ...options, root: first.root })
  expect(second.ctx!.state.getFiles()).toEqual([])
  expect(second.exitCode).toBe(0)
})

test('preserves explicit Vitest force-rerun triggers when selection is enabled', async () => {
  const first = await runInlineTests({ ...files, 'package.json': '{"type":"module"}' }, options)
  await first.ctx!.close()
  const second = await runVitest({
    ...options,
    root: first.root,
    related: [first.fs.resolveFile('package.json')],
    forceRerunTriggers: [first.fs.resolveFile('package.json')],
  })
  expect(second.ctx!.state.getFiles().map(file => file.name).sort()).toEqual(['left.test.ts', 'right.test.ts'])
})

test('selects callers through a shared barrel, retains failures and refreshes only executed files', async () => {
  const first = await runInlineTests(files, options)
  expect(first.ctx!.state.getFiles().map(file => file.name).sort()).toEqual(['left.test.ts', 'right.test.ts'])
  const path = resolve(first.ctx!.config.cache === false ? '' : first.ctx!.config.cache.dir, 'faster-sources.json')
  expect(first.ctx!.config.coverage.enabled).toBe(true)
  expect(first.ctx!.config.coverage.reporter).toEqual([])
  await first.ctx!.close()
  const initial = JSON.parse(await readFile(path, 'utf8'))
  expect(Object.values(initial.functionTests as Record<string, object>).map(value => Object.keys(value).length > 0))
    .toEqual([true, true])
  first.fs.editFile('src/value.ts', source => source.replace('return 1', 'return 3'))
  const second = await runVitest({ ...options, root: first.root })
  expect(second.ctx!.state.getFiles().map(file => file.name)).toEqual(['left.test.ts'])
  expect(second.ctx!.state.getFiles()[0].result?.state).toBe('fail')
  await second.ctx!.close()
  const updated = JSON.parse(await readFile(path, 'utf8'))
  const right = Object.keys(initial.tests).find(key => key.endsWith(':right.test.ts'))!
  expect(updated.tests[right]).toEqual(initial.tests[right])
  const third = await runVitest({ ...options, root: first.root })
  expect(third.ctx!.state.getFiles().map(file => file.name)).toEqual(['left.test.ts'])
  await third.ctx!.close()
  first.fs.editFile('src/value.ts', source => source.replace('return 2', 'return 4'))
  const fourth = await runVitest({ ...options, root: first.root })
  expect(fourth.ctx!.state.getFiles().map(file => file.name).sort()).toEqual(['left.test.ts', 'right.test.ts'])
})

test('falls back to whole-module dependencies for top-level and function-structure changes', async () => {
  const first = await runInlineTests(files, options)
  await first.ctx!.close()
  first.fs.editFile('src/value.ts', source => `${source}; export const added = 3`)
  const second = await runVitest({ ...options, root: first.root })
  expect(second.ctx!.state.getFiles().map(file => file.name).sort()).toEqual(['left.test.ts', 'right.test.ts'])
})

test('old source caches without function coverage conservatively select all affected files', async () => {
  const first = await runInlineTests(files, options)
  const path = resolve(first.ctx!.config.cache === false ? '' : first.ctx!.config.cache.dir, 'faster-sources.json')
  await first.ctx!.close()
  const saved = JSON.parse(await readFile(path, 'utf8'))
  delete saved.functionTests
  await writeFile(path, JSON.stringify(saved))
  first.fs.editFile('src/value.ts', source => source.replace('return 1', 'return 3'))
  const second = await runVitest({ ...options, root: first.root })
  expect(second.ctx!.state.getFiles().map(file => file.name).sort()).toEqual(['left.test.ts', 'right.test.ts'])
})

test('uses isolated per-file coverage and keeps unsupported non-isolated runs conservative', async () => {
  const config = { ...options, isolate: false }
  const first = await runInlineTests(files, config)
  await first.ctx!.close()
  first.fs.editFile('src/value.ts', source => source.replace('return 1', 'return 3'))
  const second = await runVitest({ ...config, root: first.root })
  expect(second.ctx!.state.getFiles().map(file => file.name).sort()).toEqual(['left.test.ts', 'right.test.ts'])
})

test('keeps tests eligible when isolation is disabled after recording callers', async () => {
  const first = await runInlineTests(files, options)
  await first.ctx!.close()
  first.fs.editFile('src/value.ts', source => source.replace('return 1', 'return 3'))
  const second = await runVitest({ ...options, root: first.root, isolate: false })
  expect(second.ctx!.state.getFiles().map(file => file.name).sort()).toEqual(['left.test.ts', 'right.test.ts'])
})
