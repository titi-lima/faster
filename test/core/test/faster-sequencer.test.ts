import type { Reporter, TestCase } from 'vitest/node'
import { expect, test } from 'vitest'
import { runInlineTests, runVitest } from '../../test-utils'

const files = {
  'src/shared.ts': `
    export const value = 1
    export async function wait() {
      await new Promise(resolve => setTimeout(resolve, 40))
    }
  `,
  'a.test.ts': `
    import { test } from 'vitest'
    const checkoutValidCardPayment = 'checkout valid card payment approved'
    test('first file', () => checkoutValidCardPayment)
  `,
  'b.test.ts': `
    import { test } from 'vitest'
    import { wait } from './src/shared'
    const checkoutExpiredCardPayment = 'checkout expired card payment declined'
    test('similar file', async () => {
      await wait()
      return checkoutExpiredCardPayment
    })
  `,
  'c.test.ts': `
    import { test } from 'vitest'
    import { value } from './src/shared'
    const databaseMigrationRollback = 'database schema migration rollback transaction'
    test('dissimilar file', () => databaseMigrationRollback + value)
  `,
}

function config(order: string[], changed: boolean) {
  const reporter: Reporter = {
    onTestCaseReady(testCase: TestCase) {
      order.push(testCase.name)
    },
  }
  return {
    faster: { changed },
    cache: { dir: 'node_modules/.vite' },
    fileParallelism: false,
    maxWorkers: 1,
    reporters: [reporter],
  }
}

test('keeps global FAST order after a slower file gains result history', async () => {
  const order: string[] = []
  const options = config(order, false)
  const first = await runInlineTests(files, options)
  expect(order).toEqual(['first file', 'dissimilar file', 'similar file'])
  const name = first.ctx!.projects[0].name
  const results = first.ctx!.cache
  expect(results.getFileTestResults(`${name}:b.test.ts`)!.duration)
    .toBeGreaterThan(results.getFileTestResults(`${name}:a.test.ts`)!.duration)
  await first.ctx!.close()
  order.length = 0
  await runVitest({ ...options, root: first.root })
  expect(order).toEqual(['first file', 'dissimilar file', 'similar file'])
})

test('partitions the global FAST order into affected buckets, including after reverts', async () => {
  const order: string[] = []
  const options = config(order, true)
  const first = await runInlineTests(files, options)
  expect(order).toEqual(['first file', 'dissimilar file', 'similar file'])
  await first.ctx!.close()
  first.fs.editFile('src/shared.ts', source => `${source}\n// shared dependency changed\n`)
  order.length = 0
  const second = await runVitest({ ...options, root: first.root })
  expect(order).toEqual(['dissimilar file', 'similar file', 'first file'])
  await second.ctx!.close()
  first.fs.editFile('src/shared.ts', () => files['src/shared.ts'])
  order.length = 0
  await runVitest({ ...options, root: first.root })
  expect(order).toEqual(['dissimilar file', 'similar file', 'first file'])
})

test.each(['dx', 'apfd'] as const)('honors producer scores on warm %s runs', async (optimizeFor) => {
  const order: string[] = []
  const options = { ...config(order, false), faster: { changed: false, optimizeFor } }
  const first = await runInlineTests({
    ...files,
    '.faster/priorities.json': JSON.stringify({
      schemaVersion: 1,
      tests: { 'c.test.ts::dissimilar file': 10, 'a.test.ts::first file': 1 },
    }),
  }, options)
  expect(order).toEqual(['dissimilar file', 'first file', 'similar file'])
  await first.ctx!.close()
  order.length = 0
  await runVitest({ ...options, root: first.root })
  expect(order).toEqual(['dissimilar file', 'first file', 'similar file'])
})

test('preserves project group order ahead of cached failure buckets', async () => {
  const order: string[] = []
  const options = {
    ...config(order, false),
    projects: [
      { test: { name: 'z', include: ['z.test.ts'], sequence: { groupOrder: 0 } } },
      { test: { name: 'a', include: ['a.test.ts'], sequence: { groupOrder: 1 } } },
    ],
  }
  const first = await runInlineTests({
    'z.test.ts': `import { test } from 'vitest'; test('z group', () => {})`,
    'a.test.ts': `import { test, expect } from 'vitest'; test('a group', () => expect(1).toBe(2))`,
  }, options)
  expect(order).toEqual(['z group', 'a group'])
  await first.ctx!.close()
  order.length = 0
  await runVitest({ ...options, root: first.root })
  expect(order).toEqual(['z group', 'a group'])
})
