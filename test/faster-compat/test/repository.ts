import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { x } from 'tinyexec'
import { onTestFinished } from 'vitest'

const compat = resolve(import.meta.dirname, '..')
const vitestBin = join(compat, 'node_modules/vitest/vitest.mjs')

export function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=faster', '-c', 'user.email=faster@test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: 'pipe' })
}

/** Commits `files` to a new Git repository under `fixtures/`, removed when the current test finishes. */
export function createRepository(prefix: string, files: Record<string, string>): string {
  const fixtures = join(compat, 'fixtures')
  mkdirSync(fixtures, { recursive: true })
  const root = mkdtempSync(join(fixtures, prefix))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  git(root, 'init', '-q')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'init')
  return root
}

/** Runs the workspace's Vitest in `root`, returning the names of the test files it ran, sorted, and its output. */
export async function runVitest(root: string, env: Record<string, string>, args: string[] = []): Promise<{ files: string[]; output: string }> {
  const report = join(root, 'node_modules/.report.json')
  rmSync(report, { force: true })
  const run = await x('node', [vitestBin, 'run', '--reporter=json', `--outputFile=${report}`, ...args], {
    nodeOptions: { cwd: root, env: { ...process.env, NO_COLOR: '1', VITEST_FASTER_OPTIONS: '', ...env } },
    throwOnError: false,
  })
  const files = existsSync(report)
    ? JSON.parse(readFileSync(report, 'utf8')).testResults.map((result: { name: string }) => basename(result.name)).sort()
    : []
  return { files, output: `${run.stdout}\n${run.stderr}` }
}
