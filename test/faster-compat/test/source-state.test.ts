import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readState } from './harness'
import { createRepository, runVitest } from './repository'

function recordedTests(root: string): string[] {
  const [state] = Object.values(readState(root) as Record<string, { tests: Record<string, unknown> }>)
  return Object.keys(state.tests).sort()
}

test('forgets deleted test files of the projects that ran, and only those', async () => {
  const root = createRepository('sources-', {
    '.gitignore': 'node_modules\n',
    'vitest.config.mjs': `import { faster } from 'vitest-faster'\nexport default { plugins: [faster()], test: ${JSON.stringify({
      maxWorkers: 1,
      projects: [
        { extends: true, test: { name: 'a', include: ['test/a*.test.js'] } },
        { extends: true, test: { name: 'a:b', include: ['test/b.test.js'] } },
      ],
    })} }\n`,
    'test/a.test.js': `import { test } from 'vitest'\ntest('a', () => {})\n`,
    'test/a-gone.test.js': `import { test } from 'vitest'\ntest('a gone', () => {})\n`,
    'test/b.test.js': `import { test } from 'vitest'\ntest('b', () => {})\n`,
  })
  expect((await runVitest(root, { CI: 'true' })).files).toEqual(['a-gone.test.js', 'a.test.js', 'b.test.js'])

  rmSync(join(root, 'test/a-gone.test.js'))
  expect((await runVitest(root, { CI: 'true' }, ['--project', 'a'])).files).toEqual(['a.test.js'])
  expect(recordedTests(root)).toMatchInlineSnapshot(`
    [
      "a:b:forks:test/b.test.js",
      "a:forks:test/a.test.js",
    ]
  `)
})
