import { readFileSync } from 'node:fs'
import { Session } from 'node:inspector/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { FUNCTION_COVERAGE_ENV, startFunctionCoverage } from '../../../packages/vitest-faster/src/coverage'
import { readState } from './harness'
import { createRepository, runVitest } from './repository'

function branchy(value: number): string {
  if (value > 0) {
    return 'positive'
  }
  return 'other'
}

test('starts the provider\'s V8 coverage without block counts and restores the inspector', async () => {
  const post = Session.prototype.post
  const session = new Session()
  session.connect()
  try {
    await startFunctionCoverage(async () => {
      await session.post('Profiler.enable')
      await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true })
    })
    expect(Session.prototype.post).toBe(post)
    branchy(1)
    const { result } = await session.post('Profiler.takePreciseCoverage')
    const script = result.find(entry => entry.url === import.meta.url)!
    const fn = script.functions.find(entry => entry.functionName === 'branchy')!
    expect({ isBlockCoverage: fn.isBlockCoverage, ranges: fn.ranges.length, count: fn.ranges[0].count }).toMatchInlineSnapshot(`
      {
        "count": 1,
        "isBlockCoverage": false,
        "ranges": 1,
      }
    `)
  }
  finally {
    await session.post('Profiler.stopPreciseCoverage').catch(() => {})
    session.disconnect()
  }
})

function createProjects(userCoverage: boolean) {
  const coverage = userCoverage ? { enabled: true, reporter: ['json-summary'] } : {}
  const files: Record<string, string> = {
    '.gitignore': 'node_modules\ncoverage\n',
    'vitest.config.mjs': `import { faster } from 'vitest-faster'\nexport default { plugins: [faster()], test: ${JSON.stringify({
      maxWorkers: 1,
      coverage,
      projects: [{ extends: true, test: { name: 'one', include: ['test/one.test.js'] } }, { extends: true, test: { name: 'two', include: ['test/two.test.js'] } }],
    })} }\n`,
    'src/value.js': 'export function value(x) {\n  if (x) {\n    return 1\n  }\n  return 2\n}\n',
  }
  for (const name of ['one', 'two']) {
    files[`test/${name}.test.js`] = [
      `import { appendFileSync } from 'node:fs'`,
      `import { expect, test } from 'vitest'`,
      `import { value } from '../src/value.js'`,
      `test('${name}', () => {`,
      `  appendFileSync('workers.log', '${name}: ' + (process.env.${FUNCTION_COVERAGE_ENV} ?? 'unset') + '\\n')`,
      `  expect(value(true)).toBe(1)`,
      `})`,
      '',
    ].join('\n')
  }
  return createRepository('coverage-', files)
}

function recordedFunctions(root: string) {
  const [state] = Object.values(readState(root) as Record<string, { functionTests: Record<string, Record<string, { functions: Record<string, { called: boolean | null }> }>> }>)
  return Object.fromEntries(Object.entries(state.functionTests).map(([test, paths]) => [
    test,
    Object.values(paths['src/value.js'].functions).map(fn => fn.called),
  ]))
}

test('workers of every project skip block coverage when FASTER alone enables it', async () => {
  const root = createProjects(false)
  const { files } = await runVitest(root, { CI: 'true' })
  expect(files).toEqual(['one.test.js', 'two.test.js'])
  expect(readFileSync(join(root, 'workers.log'), 'utf8').split('\n').filter(Boolean).sort()).toEqual(['one: 1', 'two: 1'])
  expect(recordedFunctions(root)).toMatchInlineSnapshot(`
    {
      "one:forks:test/one.test.js": [
        true,
        true,
      ],
      "two:forks:test/two.test.js": [
        true,
        true,
      ],
    }
  `)
})

test('workers keep block coverage for the user\'s coverage report', async () => {
  const root = createProjects(true)
  const { files } = await runVitest(root, { CI: 'true' })
  expect(files).toEqual(['one.test.js', 'two.test.js'])
  expect(readFileSync(join(root, 'workers.log'), 'utf8').split('\n').filter(Boolean).sort()).toEqual(['one: unset', 'two: unset'])
  expect(JSON.parse(readFileSync(join(root, 'coverage/coverage-summary.json'), 'utf8')).total.branches).toMatchInlineSnapshot(`
    {
      "covered": 1,
      "pct": 50,
      "skipped": 0,
      "total": 2,
    }
  `)
  expect(recordedFunctions(root)).toMatchInlineSnapshot(`
    {
      "one:forks:test/one.test.js": [
        true,
        true,
      ],
      "two:forks:test/two.test.js": [
        true,
        true,
      ],
    }
  `)
})
