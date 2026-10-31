import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Checks that the decision code in `packages/vitest-faster/src/decision` is the
 * FASTER fork's code, byte for byte, except for the module specifiers of its
 * import and export declarations.
 *
 *   node test/faster-compat/scripts/check-decision-code.mjs [ref]
 *
 * `ref` is a commit of this repository that still holds the fork. It defaults
 * to `FASTER_FORK_REF`, then to the commit that merged the plugin.
 */
export const DEFAULT_FORK_REF = '3e78239dc736f07be37256e1ac049a02c0870711'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const decision = 'packages/vitest-faster/src/decision'

export const origins = {
  'affectedTests.ts': 'packages/vitest/src/node/faster/affectedTests.ts',
  'apfdPriority.ts': 'packages/vitest/src/node/faster/apfdPriority.ts',
  'functionCoverage.ts': 'packages/vitest/src/node/faster/functionCoverage.ts',
  'priorityManifest.ts': 'packages/vitest/src/node/faster/priorityManifest.ts',
  'sourceChanges.ts': 'packages/vitest/src/node/faster/sourceChanges.ts',
  'FasterSequencer.ts': 'packages/vitest/src/node/sequencers/FasterSequencer.ts',
  'BaseSequencer.ts': 'packages/vitest/src/node/sequencers/BaseSequencer.ts',
  'priority.ts': 'packages/runner/src/utils/priority.ts',
  'git.ts': 'packages/vitest/src/node/vcs/git.ts',
  'vcs.ts': 'packages/vitest/src/node/vcs/vcs.ts',
  'errors.ts': 'packages/vitest/src/node/errors.ts',
  'hash.ts': 'packages/vitest/src/node/hash.ts',
}

const SPECIFIER = /^((?:import|export)\b.*\bfrom '|\} from ')([^']+)('\s*)$/

function specifiers(source) {
  const found = []
  const masked = source.split('\n').map((line, index) => line.replace(SPECIFIER, (_, head, specifier, tail) => {
    found.push({ line: index + 1, specifier })
    return `${head}<specifier>${tail}`
  }))
  return { masked, found }
}

export function checkDecisionCode(ref = process.env.FASTER_FORK_REF || DEFAULT_FORK_REF) {
  const commit = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repository, encoding: 'utf8' }).trim()
  const report = { commit, files: [], unchecked: [], ok: true }
  const present = readdirSync(join(repository, decision)).filter(file => file.endsWith('.ts'))
  report.unchecked = present.filter(file => !(file in origins))
  report.ok = report.unchecked.length === 0
  for (const [file, origin] of Object.entries(origins)) {
    const before = execFileSync('git', ['show', `${commit}:${origin}`], { cwd: repository, encoding: 'utf8', maxBuffer: 1 << 26 })
    const after = readFileSync(join(repository, decision, file), 'utf8')
    const left = specifiers(before)
    const right = specifiers(after)
    const entry = { file, origin, identical: before === after, specifiers: [], difference: undefined }
    const lines = Math.max(left.masked.length, right.masked.length)
    for (let index = 0; index < lines && !entry.difference; index++) {
      if (left.masked[index] !== right.masked[index]) {
        entry.difference = { line: index + 1, before: left.masked[index], after: right.masked[index] }
      }
    }
    if (!entry.difference) {
      entry.specifiers = left.found
        .map((found, index) => ({ line: found.line, before: found.specifier, after: right.found[index].specifier }))
        .filter(change => change.before !== change.after)
    }
    report.ok &&= !entry.difference
    report.files.push(entry)
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkDecisionCode(process.argv[2])
  console.log(`Decision code against ${report.commit}:`)
  for (const entry of report.files) {
    if (entry.difference) {
      console.log(`  FAIL ${entry.file} differs from ${entry.origin} at line ${entry.difference.line}:`)
      console.log(`    - ${entry.difference.before ?? '(end of file)'}`)
      console.log(`    + ${entry.difference.after ?? '(end of file)'}`)
      continue
    }
    console.log(`  ok   ${entry.file} = ${entry.origin}${entry.identical ? ' (identical)' : ''}`)
    for (const change of entry.specifiers) {
      console.log(`         line ${change.line}: '${change.before}' -> '${change.after}'`)
    }
  }
  for (const file of report.unchecked) {
    console.log(`  FAIL ${file} has no origin in the fork; add it to \`origins\` or move it out of ${decision}`)
  }
  process.exitCode = report.ok ? 0 : 1
}
