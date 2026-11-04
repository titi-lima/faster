import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { x } from 'tinyexec'

const vitestBin = join(resolve(import.meta.dirname, '..'), 'node_modules/vitest/vitest.mjs')

export function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=faster', '-c', 'user.email=faster@test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: 'pipe' })
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
