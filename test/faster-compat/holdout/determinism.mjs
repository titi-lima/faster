import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { canonicalStates } from '../test/harness.ts'
import { differences, fullRun, functionDifferences, HOSTS, log, readPersisted, subjects, work } from './run.mjs'

/**
 * Run after run.mjs, on the clones it left at the last revision. Each host
 * runs the full suite HOLDOUT_REPEATS times (default 3), with the hosts
 * alternating. The recorded function observations are compared with the
 * host's own previous run, and with the other host's run of the same round.
 * A test whose observations differ between two runs of the same host
 * observes the code nondeterministically, whatever the host.
 *
 *   node test/faster-compat/holdout/determinism.mjs [subject...]
 */
const here = dirname(fileURLToPath(import.meta.url))
const repeats = Number(process.env.HOLDOUT_REPEATS ?? 3)

function testDifferences(left, right, labels) {
  const result = {}
  for (const directory of new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])) {
    const a = left?.[directory]?.functionTests ?? {}
    const b = right?.[directory]?.functionTests ?? {}
    for (const test of differences(a, b)) {
      result[test] = functionDifferences(a[test], b[test], labels)
    }
    if (!isDeepStrictEqual(left?.[directory]?.tests, right?.[directory]?.tests)) {
      result['(source snapshots)'] = differences(left?.[directory]?.tests ?? {}, right?.[directory]?.tests ?? {})
    }
  }
  return result
}

for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(subjects)) {
  const subject = subjects[name]
  const states = { fork: [], plugin: [] }
  const outcomes = { fork: [], plugin: [] }
  for (let round = 0; round < repeats; round++) {
    for (const host of round % 2 === 0 ? HOSTS : [...HOSTS].reverse()) {
      const result = fullRun(subject, join(work, name, host))
      log(`${name}: ${host} repeat ${round + 1}: exit ${result.exitCode} in ${(result.wallMs / 1000).toFixed(1)} s`)
      outcomes[host].push(Object.fromEntries(Object.entries(result.files).map(([file, value]) => [file, value.state])))
      states[host].push(readPersisted(join(work, name, host)).sources)
    }
  }
  const canonical = Object.fromEntries(HOSTS.map(host => [host, canonicalStates(states[host])]))
  const report = {
    subject: name,
    repeats,
    withinHost: Object.fromEntries(HOSTS.map(host => [host, canonical[host].slice(1).map((state, index) => ({
      runs: [index + 1, index + 2],
      differingTests: testDifferences(canonical[host][index], state, [`run${index + 1}`, `run${index + 2}`]),
    }))])),
    acrossHosts: canonical.fork.map((state, index) => ({
      round: index + 1,
      differingTests: testDifferences(state, canonical.plugin[index]),
    })),
    outcomesEqual: outcomes.fork.map((value, index) => isDeepStrictEqual(value, outcomes.plugin[index])),
  }
  const output = join(here, 'results', `${name}.determinism.json`)
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  log(`${name}: wrote ${output}`)
}
