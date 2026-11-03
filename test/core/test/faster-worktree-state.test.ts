import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'pathe'
import { expect, test } from 'vitest'
import { getFasterSourcesStateFile } from '../../../packages/vitest/src/node/faster/sourceChanges'
import { resolveFasterStateFile } from '../../../packages/vitest/src/node/faster/stateFile'
import { runInlineTests, runVitest } from '../../test-utils'

function git(cwd: string, ...args: string[]) {
  execFileSync('git', ['-c', 'user.name=faster', '-c', 'user.email=faster@test', ...args], { cwd, stdio: 'pipe' })
}

const files = {
  '.gitignore': 'node_modules\n',
  'src/value.ts': 'export function left() { return 1 }; export function right() { return 2 }',
  'left.test.ts': `import { expect, test } from 'vitest'; import { left } from './src/value'; test('left', () => expect(left()).toBe(1))`,
  'right.test.ts': `import { expect, test } from 'vitest'; import { right } from './src/value'; test('right', () => expect(right()).toBe(2))`,
}
const options = {
  cache: { dir: 'node_modules/.vite' },
  faster: { selectAffected: true },
  fileParallelism: false,
  maxWorkers: 1,
}

test('keeps history per Git worktree and starts a new worktree from the main worktree history', async () => {
  const first = await runInlineTests(files, options)
  await first.ctx!.close()
  const main = first.root
  const worktree = `${main}-worktree`
  git(main, 'init', '-q')
  git(main, 'add', '.')
  git(main, 'commit', '-qm', 'init')
  try {
    const mainRun = await runVitest({ ...options, root: main })
    expect(mainRun.ctx!.state.getFiles()).toEqual([])
    expect(getFasterSourcesStateFile(mainRun.ctx!)!.path.startsWith(join(main, '.git/faster/'))).toBe(true)
    await mainRun.ctx!.close()

    git(main, 'worktree', 'add', '-q', worktree)
    const seeded = await runVitest({ ...options, root: worktree })
    expect(seeded.ctx!.state.getFiles()).toEqual([])
    const worktreeState = getFasterSourcesStateFile(seeded.ctx!)!.path
    expect(worktreeState.startsWith(join(main, '.git/worktrees', basename(worktree), 'faster/'))).toBe(true)
    expect(existsSync(worktreeState)).toBe(true)
    await seeded.ctx!.close()

    writeFileSync(join(worktree, 'src/value.ts'), files['src/value.ts'].replace('return 1', 'return 1 + 0'))
    const edited = await runVitest({ ...options, root: worktree })
    expect(edited.ctx!.state.getFiles().map(file => file.name)).toEqual(['left.test.ts'])
    await edited.ctx!.close()

    const mainAfter = await runVitest({ ...options, root: main })
    expect(mainAfter.ctx!.state.getFiles()).toEqual([])
    await mainAfter.ctx!.close()

    const cleared = await runVitest({ ...options, root: worktree })
    await cleared.ctx!.experimental_clearCache()
    await cleared.ctx!.close()
    const afterClear = await runVitest({ ...options, root: worktree })
    expect(afterClear.ctx!.state.getFiles().map(file => file.name).sort()).toEqual(['left.test.ts', 'right.test.ts'])
    await afterClear.ctx!.close()

    git(main, 'worktree', 'remove', '--force', worktree)
    expect(existsSync(worktreeState)).toBe(false)
  }
  finally {
    rmSync(worktree, { recursive: true, force: true })
  }
})

test('keeps history in the Vitest cache directory outside the top of a Git worktree', () => {
  const repository = mkdtempSync(join(tmpdir(), 'vitest-faster-state-'))
  try {
    git(repository, 'init', '-q')
    const nested = join(repository, 'packages/app')
    mkdirSync(nested, { recursive: true })
    const nestedCache = join(nested, 'node_modules/.vite/vitest')
    expect(resolveFasterStateFile(nested, nestedCache, 'faster-sources.json').path).toBe(join(nestedCache, 'faster-sources.json'))

    const outsideCache = join(tmpdir(), 'elsewhere/vitest')
    expect(resolveFasterStateFile(repository, outsideCache, 'faster-sources.json').path).toBe(join(outsideCache, 'faster-sources.json'))

    const plain = mkdtempSync(join(tmpdir(), 'vitest-faster-plain-'))
    const plainCache = join(plain, 'node_modules/.vite/vitest')
    expect(resolveFasterStateFile(plain, plainCache, 'faster-sources.json')).toEqual({
      path: join(plainCache, 'faster-sources.json'),
      seeds: [],
    })
    rmSync(plain, { recursive: true, force: true })
  }
  finally {
    rmSync(repository, { recursive: true, force: true })
  }
})
