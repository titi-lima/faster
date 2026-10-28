import type { Reporter, TestCase } from 'vitest/node'
import { describe, expect, test } from 'vitest'
import { runInlineTests, runVitest } from '../../test-utils'

function orderReporter(order: string[]): Reporter {
  return {
    onTestCaseReady(testCase: TestCase) {
      order.push(testCase.name)
    },
  }
}

const project = {
  '.faster/priorities.json': JSON.stringify({
    schemaVersion: 1,
    tests: {
      'affected.test.ts::affected': 1,
      'remaining.test.ts::remaining': 100,
    },
  }),
  'src/affected.ts': 'export const value = 1',
  'src/remaining.ts': 'export const value = 2',
  'affected.test.ts': `
    import { expect, test } from 'vitest'
    import { value } from './src/affected'
    test('affected', () => expect(value).toBe(1))
  `,
  'remaining.test.ts': `
    import { expect, test } from 'vitest'
    import { value } from './src/remaining'
    test('remaining', () => expect(value).toBe(2))
  `,
}

describe('Faster prioritization', () => {
  test('runs tests affected by changed source before higher-scored remaining tests', async () => {
    const order: string[] = []

    const config = {
      faster: true,
      cache: { dir: 'node_modules/.vite' },
      fileParallelism: false,
      maxWorkers: 1,
      reporters: [orderReporter(order)],
    }
    const first = await runInlineTests(project, config)
    await first.ctx!.close()
    first.fs.editFile('src/affected.ts', source => `${source}\n// source changed\n`)
    order.length = 0
    await runVitest({ ...config, root: first.root })

    expect(order).toEqual(['affected', 'remaining'])
  })

  test('uses producer scores for the remaining suite', async () => {
    const order: string[] = []

    await runInlineTests(project, {
      faster: {
        changed: false,
      },
      fileParallelism: false,
      maxWorkers: 1,
      reporters: [orderReporter(order)],
    })

    expect(order).toEqual(['remaining', 'affected'])
  })

  test('prioritizes larger test files without execution history', async () => {
    const order: string[] = []

    await runInlineTests({
      'a.test.ts': `
        /* ............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................ */
        import { test } from 'vitest'
        const checkoutValidCardPayment = 'checkout valid card payment approved'
        test('first file', () => checkoutValidCardPayment)
      `,
      'b.test.ts': `
        import { test } from 'vitest'
        const checkoutExpiredCardPayment = 'checkout expired card payment declined'
        test('similar file', () => checkoutExpiredCardPayment)
      `,
      'c.test.ts': `
        import { test } from 'vitest'
        const databaseMigrationRollback = 'database schema migration rollback transaction'
        test('dissimilar file', () => databaseMigrationRollback)
      `,
    }, {
      faster: {
        changed: false,
      },
      reporters: [orderReporter(order)],
    })

    expect(order).toEqual(['first file', 'dissimilar file', 'similar file'])
  })

  test('uses producer scores within a test file', async () => {
    const order: string[] = []

    await runInlineTests({
      '.faster/priorities.json': JSON.stringify({
        schemaVersion: 1,
        tests: {
          'unit.test.ts::first': 1,
          'unit.test.ts::second': 10,
        },
      }),
      'unit.test.ts': `
        import { test } from 'vitest'
        test('first', () => {})
        test('second', () => {})
      `,
    }, {
      faster: {
        changed: false,
      },
      reporters: [orderReporter(order)],
    })

    expect(order).toEqual(['second', 'first'])
  })

  test('uses built-in lazy FAST ordering when no manifest score exists', async () => {
    const order: string[] = []

    await runInlineTests({
      'unit.test.ts': `
        import { test } from 'vitest'
        test('checkout valid card', () => {})
        test('checkout expired card', () => {})
        test('database migration rollback', () => {})
      `,
    }, {
      faster: {
        changed: false,
      },
      reporters: [orderReporter(order)],
    })

    expect(order).toEqual([
      'checkout valid card',
      'database migration rollback',
      'checkout expired card',
    ])
  })

  test('preserves declaration order when Faster is disabled', async () => {
    const order: string[] = []

    await runInlineTests({
      'unit.test.ts': `
        import { test } from 'vitest'
        test('checkout valid card', () => {})
        test('checkout expired card', () => {})
        test('database migration rollback', () => {})
      `,
    }, {
      faster: false,
      reporters: [orderReporter(order)],
    })

    expect(order).toEqual([
      'checkout valid card',
      'checkout expired card',
      'database migration rollback',
    ])
  })

  test('prints each failure immediately without duplicating it in the final error list', async () => {
    const { stderr } = await runInlineTests({
      'failure.test.ts': `
        import { expect, test } from 'vitest'
        test('fails now', () => expect(1).toBe(2))
      `,
    }, {
      faster: {
        changed: false,
      },
    })

    expect(stderr.match(/Failed Test/g)).toHaveLength(1)
    expect(stderr.match(/AssertionError/g)).toHaveLength(1)
  })

  test('preserves Vitest final error reporting when immediate output is disabled', async () => {
    const { ctx, stderr } = await runInlineTests({
      'failure.test.ts': `
        import { expect, test } from 'vitest'
        test('fails later', () => expect(1).toBe(2))
      `,
    }, {
      faster: {
        changed: false,
        immediateFailureOutput: false,
      },
    })

    expect(ctx?.projects[0].config.faster.immediateFailureOutput).toBe(false)
    expect(stderr).toMatch(/Failed Tests 1/)
    expect(stderr).not.toMatch(/Failed Test ⎯/)
    expect(stderr.match(/AssertionError/g)).toHaveLength(1)
  })
})
