import type { Vitest } from 'vitest/node'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'pathe'
import { expect, test } from 'vitest'
import { runInlineTests } from '../../test-utils'

const files = {
  'src/value.ts': 'export function left() { return 1 }\nexport function right() { return 2 }\n',
  'left.test.ts': `import { expect, test } from 'vitest'; import { left } from './src/value'; test('left', () => expect(left()).toBe(1))`,
}
const options = {
  cache: { dir: 'node_modules/.vite' },
  fileParallelism: false,
  maxWorkers: 1,
}

function readFasterState(ctx: Vitest) {
  const directory = ctx.config.cache === false ? '' : ctx.config.cache.dir
  return JSON.parse(readFileSync(resolve(directory, 'faster-sources.json'), 'utf8')) as {
    tests: Record<string, Record<string, string>>
    functionTests: Record<string, Record<string, { functions: Record<string, { called: boolean | null }> }>>
  }
}

test('collects function coverage for FASTER without running the coverage report pipeline', async () => {
  const { ctx, fs } = await runInlineTests({ ...files, 'coverage/previous.txt': 'kept' }, options)
  await ctx!.close()
  const state = readFasterState(ctx!)
  const [snapshot] = Object.values(state.functionTests)
  expect(Object.values(snapshot['src/value.ts'].functions).map(fn => fn.called)).toMatchInlineSnapshot(`
    [
      true,
      false,
      true,
      false,
    ]
  `)
  expect(existsSync(fs.resolveFile('coverage/previous.txt'))).toBe(true)
})

test('keeps reporting coverage the user enabled while FASTER reads the same data', async () => {
  const { ctx, fs } = await runInlineTests(files, { ...options, coverage: { enabled: true, reporter: ['json'] } })
  await ctx!.close()
  const [snapshot] = Object.values(readFasterState(ctx!).functionTests)
  expect(Object.values(snapshot['src/value.ts'].functions).map(fn => fn.called)).toMatchInlineSnapshot(`
    [
      true,
      false,
      true,
      false,
    ]
  `)
  expect(existsSync(fs.resolveFile('coverage/coverage-final.json'))).toBe(true)
})

test('keeps enforcing configured coverage thresholds when coverage only feeds FASTER', async () => {
  const { ctx, exitCode, stderr } = await runInlineTests(files, { ...options, coverage: { thresholds: { functions: 100 } } })
  await ctx!.close()
  expect(exitCode).toBe(1)
  expect(stderr.split('\n').filter(line => line.startsWith('ERROR'))).toMatchInlineSnapshot(`
    [
      "ERROR: Coverage for functions (50%) does not meet global threshold (100%)",
    ]
  `)
})

test('snapshots sources before test code runs although workers start meanwhile', async () => {
  const original = 'export const value = 1\n'
  const { ctx, fs } = await runInlineTests({
    'src/value.ts': original,
    'edit.test.ts': `
      import { writeFileSync } from 'node:fs'
      import { test } from 'vitest'
      writeFileSync(new URL('./src/value.ts', import.meta.url), 'export const value = 2\\n')
      test('imports the edited source', async () => { await import('./src/value') })
    `,
  }, {
    ...options,
    $viteConfig: {
      plugins: [{
        name: 'slow-source-snapshot',
        async transform(_, id) {
          if (this.environment.name === 'ssr' && id.endsWith('/src/value.ts')) {
            await new Promise(resolve => setTimeout(resolve, 1000))
          }
        },
      }],
    },
  })
  await ctx!.close()
  expect(fs.readFile('src/value.ts')).toBe('export const value = 2\n')
  const state = readFasterState(ctx!)
  const key = Object.keys(state.tests).find(key => key.endsWith(':edit.test.ts'))!
  expect(state.tests[key]['src/value.ts']).toBe(createHash('sha1').update(original).digest('hex'))
  expect(state.functionTests[key]).toEqual({})
})
