import type { Reporter, TestCase } from 'vitest/node'
import { describe, expect, test } from 'vitest'
import { createCLI } from '../../../packages/vitest/src/node/cli/cac'
import { getApfdPriorityScores } from '../../../packages/vitest/src/node/faster/apfdPriority'
import { resolveFasterOptions } from '../../../packages/vitest/src/node/faster/priorityManifest'
import { runInlineTests, runVitest } from '../../test-utils'

test('defaults to DX and validates the ordering objective', () => {
  expect(resolveFasterOptions('/repo', undefined).optimizeFor).toBe('dx')
  expect(resolveFasterOptions('/repo', { optimizeFor: 'apfd' }).optimizeFor).toBe('apfd')
  expect(() => resolveFasterOptions('/repo', { optimizeFor: 'unknown' as any }))
    .toThrow('Invalid faster.optimizeFor')
  const cli = createCLI().parse(['node', 'vitest', 'run', '--faster.optimizeFor=apfd'], { run: false })
  expect(cli.options.faster).toEqual({ optimizeFor: 'apfd' })
})

describe.each(['dx', 'apfd'] as const)('objective %s', (optimizeFor) => {
  test('orders an unchanged cached failure against an affected passing file', async () => {
    const order: string[] = []
    const reporter: Reporter = {
      onTestCaseReady(testCase: TestCase) {
        order.push(testCase.name)
      },
    }
    const config = {
      cache: { dir: 'node_modules/.vite' },
      faster: { optimizeFor },
      fileParallelism: false,
      maxWorkers: 1,
      reporters: [reporter],
    }
    const first = await runInlineTests({
      'src/value.ts': 'export const value = 1',
      'affected.test.ts': `
        import { expect, test } from 'vitest'
        import { value } from './src/value'
        test('affected pass', () => expect(value).toBe(1))
      `,
      'failure.test.ts': `
        import { expect, test } from 'vitest'
        test('unchanged failure', () => expect(1).toBe(2))
      `,
      'passing.test.ts': `
        import { test } from 'vitest'
        test('unchanged pass', () => {})
      `,
    }, config)
    await first.ctx!.close()
    first.fs.editFile('src/value.ts', source => `${source}\n// changed since the previous run\n`)
    order.length = 0

    const second = await runVitest({ ...config, root: first.root })
    expect(order).toEqual(optimizeFor === 'apfd'
      ? ['unchanged failure', 'affected pass', 'unchanged pass']
      : ['affected pass', 'unchanged failure', 'unchanged pass'])
    expect(second.ctx!.state.getTestModules().flatMap(module => [...module.children.allTests()])
      .map(testCase => testCase.result().state).sort()).toEqual(['failed', 'passed', 'passed'])
  })
})

test('uses rank-based history and breadth without allowing NaN to corrupt ordering', () => {
  expect(getApfdPriorityScores([
    { duration: 100, bytes: 10 },
    { duration: 10, bytes: 100 },
    { bytes: 100 },
    { duration: Number.NaN, bytes: 10 },
  ])).toEqual([1, 0.6, 0.1, 0])
})

test('APFD promotes edited and new tests ahead of slow transitively affected tests', async () => {
  const order: string[] = []
  const reporter: Reporter = {
    onTestCaseReady(testCase) {
      order.push(testCase.name)
    },
  }
  const options = {
    cache: { dir: 'node_modules/.vite' },
    faster: { optimizeFor: 'apfd' as const },
    fileParallelism: false,
    maxWorkers: 1,
    reporters: [reporter],
  }
  const first = await runInlineTests({
    'src/value.ts': 'export const value = 1',
    'a.test.ts': `import { test } from 'vitest'; import { value } from './src/value'; test('slow affected', async () => { await new Promise(resolve => setTimeout(resolve, 40)); return value })`,
    'b.test.ts': `import { test } from 'vitest'; test('edited', async () => { await new Promise(resolve => setTimeout(resolve, 5)) })`,
    'f.test.ts': `import { test, expect } from 'vitest'; test('cached failure', () => expect(1).toBe(2))`,
  }, options)
  await first.ctx!.close()
  first.fs.editFile('src/value.ts', source => `${source}\n// source change\n`)
  first.fs.editFile('b.test.ts', source => `${source}\n// test change\n`)
  first.fs.createFile('c.test.ts', `import { test } from 'vitest'; test('new test', () => {})`)
  order.length = 0
  await runVitest({ ...options, root: first.root })
  expect(order).toEqual(['cached failure', 'edited', 'new test', 'slow affected'])
})
