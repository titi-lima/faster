import type { Reporter, TestCase, Vitest } from 'vitest/node'
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

async function seedDurations(ctx: Vitest, durations: Record<string, number>) {
  for (const [file, duration] of Object.entries(durations)) {
    ctx.cache.getFileTestResults(`${ctx.projects[0].name}:${file}`)!.duration = duration
  }
  await ctx.cache.results.writeToCache()
}

test.each(['dx', 'apfd'] as const)('uses the same duration/size ranking on cold and warm %s runs', async (optimizeFor) => {
  const order: string[] = []
  const options = { ...config(order, false), faster: { changed: false, optimizeFor } }
  const first = await runInlineTests(files, options)
  expect(order).toEqual(['similar file', 'dissimilar file', 'first file'])
  await seedDurations(first.ctx!, { 'a.test.ts': 100, 'b.test.ts': 10, 'c.test.ts': 50 })
  await first.ctx!.close()
  order.length = 0
  await runVitest({ ...options, root: first.root })
  expect(order).toEqual(['first file', 'dissimilar file', 'similar file'])
})

test('keeps affected tests ahead of the remaining suite after edits and reverts', async () => {
  const order: string[] = []
  const options = config(order, true)
  const first = await runInlineTests(files, options)
  expect(order).toEqual(['similar file', 'dissimilar file', 'first file'])
  await seedDurations(first.ctx!, { 'a.test.ts': 10, 'b.test.ts': 100, 'c.test.ts': 50 })
  await first.ctx!.close()
  first.fs.editFile('src/shared.ts', source => `${source}\n// shared dependency changed\n`)
  order.length = 0
  const second = await runVitest({ ...options, root: first.root })
  expect(order).toEqual(['similar file', 'dissimilar file', 'first file'])
  await seedDurations(second.ctx!, { 'a.test.ts': 10, 'b.test.ts': 100, 'c.test.ts': 50 })
  await second.ctx!.close()
  first.fs.editFile('src/shared.ts', () => files['src/shared.ts'])
  order.length = 0
  await runVitest({ ...options, root: first.root })
  expect(order).toEqual(['similar file', 'dissimilar file', 'first file'])
})

test.each(['dx', 'apfd'] as const)('uses path order for equal %s priorities', async (optimizeFor) => {
  const order: string[] = []
  const bodies = {
    'a.test.ts': `import { test } from 'vitest'; test('checkout valid card', () => {})`,
    'b.test.ts': `import { test } from 'vitest'; test('checkout expired card', () => {})`,
    'c.test.ts': `import { test } from 'vitest'; test('database migration rollback', () => {})`,
  }
  const equalSize = Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, body.padEnd(200)]))
  const options = { ...config(order, false), faster: { changed: false, optimizeFor } }
  const first = await runInlineTests(equalSize, options)
  expect(order).toEqual(['checkout valid card', 'checkout expired card', 'database migration rollback'])
  await seedDurations(first.ctx!, { 'a.test.ts': 10, 'b.test.ts': 10, 'c.test.ts': 10 })
  await first.ctx!.close()
  order.length = 0
  await runVitest({ ...options, root: first.root })
  expect(order).toEqual(['checkout valid card', 'checkout expired card', 'database migration rollback'])
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
