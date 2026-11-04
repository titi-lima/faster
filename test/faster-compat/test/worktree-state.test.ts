import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { markFasterStateDirCleared, resolveFasterStateDir, seedFasterStateDir } from '../../../packages/vitest-faster/src/stateFile'
import { git, runVitest } from './repository'

const compat = resolve(import.meta.dirname, '..')
const cleanup: string[] = []

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createRepository(parent: string, files: Record<string, string>) {
  const main = mkdtempSync(join(parent, 'repository-'))
  const worktree = `${main}-worktree`
  cleanup.push(main, worktree)
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(main, file, '..'), { recursive: true })
    writeFileSync(join(main, file), content)
  }
  git(main, 'init', '-q')
  git(main, 'add', '.')
  git(main, 'commit', '-qm', 'init')
  return { main, worktree }
}

async function runFaster(root: string): Promise<string[]> {
  return (await runVitest(root, { CI: 'true' })).files
}

const project = {
  '.gitignore': 'node_modules\n',
  'vitest.config.mjs': `import { faster } from 'vitest-faster'\nexport default { plugins: [faster({ selectAffected: true })], test: { maxWorkers: 1 } }\n`,
  'src/value.js': 'export function left() { return 1 }\nexport function right() { return 2 }\n',
  'test/left.test.js': `import { expect, test } from 'vitest'\nimport { left } from '../src/value.js'\ntest('left', () => expect(left()).toBe(1))\n`,
  'test/right.test.js': `import { expect, test } from 'vitest'\nimport { right } from '../src/value.js'\ntest('right', () => expect(right()).toBe(2))\n`,
  'test/broken.test.js': `import { expect, test } from 'vitest'\ntest('broken', () => expect(1).toBe(2))\n`,
}

test('a new worktree starts from the main worktree\'s history and keeps its own afterwards', async () => {
  const fixtures = join(compat, 'fixtures')
  mkdirSync(fixtures, { recursive: true })
  const { main, worktree } = createRepository(fixtures, project)

  expect(await runFaster(main)).toEqual(['broken.test.js', 'left.test.js', 'right.test.js'])
  expect(await runFaster(main)).toEqual(['broken.test.js'])
  expect(existsSync(join(main, '.git/faster/node_modules/.vite/vitest'))).toBe(true)

  git(main, 'worktree', 'add', '-q', worktree)
  expect(await runFaster(worktree)).toEqual(['broken.test.js'])
  const worktreeState = join(main, '.git/worktrees', basename(worktree), 'faster')
  expect(existsSync(worktreeState)).toBe(true)

  writeFileSync(join(worktree, 'src/value.js'), project['src/value.js'].replace('return 1', 'return 1 + 0'))
  expect(await runFaster(worktree)).toEqual(['broken.test.js', 'left.test.js'])
  expect(await runFaster(main)).toEqual(['broken.test.js'])

  git(main, 'worktree', 'remove', '--force', worktree)
  expect(existsSync(worktreeState)).toBe(false)
})

test('locates history in the worktree\'s Git directory only at the top of a worktree', () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'vitest-faster-state-')))
  cleanup.push(repository, `${repository}-worktree`)
  const cache = (root: string) => join(root, 'node_modules/.vite/vitest/hash')
  git(repository, 'init', '-q')
  expect(resolveFasterStateDir(repository, cache(repository))).toEqual({
    dir: join(repository, '.git/faster/node_modules/.vite/vitest/hash'),
    seedDirs: [cache(repository)],
  })
  expect(resolveFasterStateDir(repository, join(repository, '..vitest/cache')).dir)
    .toBe(join(repository, '.git/faster/..vitest/cache'))
  expect(resolveFasterStateDir(repository, join(tmpdir(), 'elsewhere')).dir).toBe(join(tmpdir(), 'elsewhere'))
  const nested = join(repository, 'packages/app')
  mkdirSync(nested, { recursive: true })
  expect(resolveFasterStateDir(nested, cache(nested))).toEqual({ dir: cache(nested), seedDirs: [] })

  writeFileSync(join(repository, 'a.js'), '')
  git(repository, 'add', '.')
  git(repository, 'commit', '-qm', 'init')
  const worktree = `${repository}-worktree`
  git(repository, 'worktree', 'add', '-q', worktree)
  expect(resolveFasterStateDir(worktree, cache(worktree))).toEqual({
    dir: join(repository, '.git/worktrees', basename(worktree), 'faster/node_modules/.vite/vitest/hash'),
    seedDirs: [cache(worktree), join(repository, '.git/faster/node_modules/.vite/vitest/hash')],
  })

  const stale = mkdtempSync(join(tmpdir(), 'vitest-faster-stale-'))
  cleanup.push(stale)
  writeFileSync(join(stale, '.git'), `gitdir: ${join(repository, '.git/worktrees/gone')}\n`)
  expect(resolveFasterStateDir(stale, cache(stale))).toEqual({ dir: cache(stale), seedDirs: [] })
  expect(existsSync(join(repository, '.git/worktrees/gone'))).toBe(false)
})

test('copies the first history it finds once and never over a cleared one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vitest-faster-seed-'))
  cleanup.push(root)
  const own = join(root, 'own')
  const main = join(root, 'main')
  const location = { dir: join(root, 'worktree'), seedDirs: [own, main] }
  mkdirSync(own, { recursive: true })
  mkdirSync(main, { recursive: true })
  writeFileSync(join(own, 'faster-results.json'), 'own results')
  writeFileSync(join(main, 'faster-results.json'), 'main results')
  writeFileSync(join(main, 'faster-sources.json'), 'main sources')

  await seedFasterStateDir(location)
  expect(readFileSync(join(location.dir, 'faster-results.json'), 'utf8')).toBe('own results')
  expect(readFileSync(join(location.dir, 'faster-sources.json'), 'utf8')).toBe('main sources')

  writeFileSync(join(main, 'faster-sources.json'), 'newer main sources')
  await seedFasterStateDir(location)
  expect(readFileSync(join(location.dir, 'faster-sources.json'), 'utf8')).toBe('main sources')

  await markFasterStateDirCleared(location)
  await seedFasterStateDir(location)
  expect(readFileSync(join(location.dir, 'faster-sources.json'), 'utf8')).toBe('')
  expect(readFileSync(join(location.dir, 'faster-results.json'), 'utf8')).toBe('')
})
