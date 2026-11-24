import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createRepository, git, runVitest } from './repository'

const values = {
  'src/helper.js': 'export function one() { return 1 }\nexport function two() { return 2 }\n',
  'src/value.js': 'import { two } from \'./helper.js\'\nexport function left() { return 1 }\nexport function right() { return two() }\n',
  'src/unrelated.js': 'export function unrelated() { return 3 }\n',
}

const project = {
  '.gitignore': 'node_modules\n',
  'vitest.config.mjs': `import { faster } from 'vitest-faster'\nexport default { plugins: [faster({ selectAffected: true })], test: { maxWorkers: 1 } }\n`,
  ...values,
  'test/left.test.js': `import { expect, test } from 'vitest'\nimport { left } from '../src/value.js'\ntest('left', () => expect(left()).toBe(1))\n`,
  'test/right.test.js': `import { expect, test } from 'vitest'\nimport { right } from '../src/value.js'\ntest('right', () => expect(right()).toBe(2))\n`,
  'test/unrelated.test.js': `import { expect, test } from 'vitest'\nimport { unrelated } from '../src/unrelated.js'\ntest('unrelated', () => expect(unrelated()).toBe(3))\n`,
}

const untrusted = { VITEST_FASTER_OPTIONS: '{"trustedBranch":false}' }

async function run(root: string, env: Record<string, string> = {}) {
  const { files, output } = await runVitest(root, { CI: '', ...env })
  const trusted = output.split('\n').find(line => line.includes('[vitest-faster] trusted'))
  return { files, trusted: trusted?.replace(/at [0-9a-f]{9}/, 'at <commit>') }
}

function commitOnTrustedBranch(root: string, files: Record<string, string>) {
  write(root, files)
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'upstream')
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
}

function write(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(root, file), content)
  }
}

async function repositoryWithHistory() {
  const root = createRepository('trusted-', project)
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  expect((await run(root, untrusted)).files).toEqual(['left.test.js', 'right.test.js', 'unrelated.test.js'])
  expect((await run(root, untrusted)).files).toEqual([])
  return root
}

test('skips tests whose changes since their last run are all on the trusted branch', async () => {
  const root = await repositoryWithHistory()
  commitOnTrustedBranch(root, { 'src/value.js': values['src/value.js'].replace('return 1 }', 'return 2 - 1 }') })

  expect(await run(root)).toMatchInlineSnapshot(`
    {
      "files": [],
      "trusted": "[vitest-faster] trusted origin/main at <commit>: skipped 1 test file(s) whose changes since their last run all come from it",
    }
  `)
  expect((await run(root, { CI: 'true' })).files).toEqual(['left.test.js'])
})

test('runs a test that a trusted change now leads into code changed off the trusted branch', async () => {
  const root = await repositoryWithHistory()
  commitOnTrustedBranch(root, {
    'src/value.js': values['src/value.js'].replace('{ two }', '{ one, two }').replace('return 1 }', 'return one() }'),
  })
  write(root, { 'src/helper.js': values['src/helper.js'].replace('return 1 }', 'return 2 - 1 }') })

  expect((await run(root)).files).toEqual(['left.test.js', 'right.test.js'])
})

test('keeps function-level selection for a test with changes on and off the trusted branch', async () => {
  const root = await repositoryWithHistory()
  commitOnTrustedBranch(root, { 'src/helper.js': values['src/helper.js'].replace('return 1 }', 'return 2 - 1 }') })
  write(root, { 'src/value.js': values['src/value.js'].replace('return 1 }', 'return 2 - 1 }') })

  expect((await run(root)).files).toEqual(['left.test.js'])
})

test('runs a test whose trusted change imports a file changed off the trusted branch', async () => {
  const root = await repositoryWithHistory()
  commitOnTrustedBranch(root, {
    'src/value.js': `import { unrelated } from './unrelated.js'\n${values['src/value.js'].replace('return 1 }', 'return unrelated() - 2 }')}`,
  })

  expect((await run(root)).files).toEqual([])

  write(root, { 'src/unrelated.js': values['src/unrelated.js'].replace('return 3', 'return 1 + 2') })
  expect((await run(root)).files).toEqual(['left.test.js', 'right.test.js', 'unrelated.test.js'])
})

test('skips every test of a checkout without history that matches the trusted branch', async () => {
  const root = createRepository('trusted-', project)
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')

  expect((await run(root)).files).toEqual([])

  write(root, { 'src/helper.js': values['src/helper.js'].replace('return 2', 'return 1 + 1') })
  expect((await run(root)).files).toEqual(['left.test.js', 'right.test.js'])
})

test('skips a new test file from the trusted branch until it reaches code changed off it', async () => {
  const root = await repositoryWithHistory()
  commitOnTrustedBranch(root, {
    'test/added.test.js': `import { expect, test } from 'vitest'\nimport { unrelated } from '../src/unrelated.js'\ntest('added', () => expect(unrelated()).toBe(3))\n`,
  })

  expect((await run(root)).files).toEqual([])

  write(root, { 'src/unrelated.js': values['src/unrelated.js'].replace('return 3', 'return 1 + 2') })
  expect((await run(root)).files).toEqual(['added.test.js', 'unrelated.test.js'])
})

test('trusts nothing without a remote-tracking branch', async () => {
  const root = await repositoryWithHistory()
  git(root, 'update-ref', '-d', 'refs/remotes/origin/main')
  write(root, { 'src/value.js': values['src/value.js'].replace('return 1 }', 'return 2 - 1 }') })
  git(root, 'commit', '-qam', 'local only')

  expect(await run(root)).toMatchInlineSnapshot(`
    {
      "files": [
        "left.test.js",
      ],
      "trusted": undefined,
    }
  `)
})

test('treats a file a test read like one of its sources', async () => {
  const root = createRepository('trusted-', {
    ...project,
    'data/value.txt': '1',
    'test/read.test.js': `import { readFileSync } from 'node:fs'\nimport { expect, test } from 'vitest'\ntest('read', () => expect(readFileSync('data/value.txt', 'utf8')).toMatch(/^1/))\n`,
  })
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  await run(root, untrusted)
  expect((await run(root, untrusted)).files).toEqual([])

  commitOnTrustedBranch(root, { 'data/value.txt': '1 from upstream' })
  expect((await run(root)).files).toEqual([])

  write(root, { 'data/value.txt': '1 from me' })
  expect((await run(root)).files).toEqual(['read.test.js'])
})
