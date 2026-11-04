import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fullRun, HOSTS, log, subjects, work } from './run.mjs'

/**
 * Times the small runs `selectAffected` produces, where fixed per-run costs
 * weigh most. Run after run.mjs, on the clones it left at the last revision.
 * Each host runs, with FASTER on and `HOLDOUT_SMALL_REPEATS` times each
 * (default 5), alternating hosts:
 * - the files FASTER selected at the last target;
 * - the first of them alone.
 *
 *   node test/faster-compat/holdout/small-runs.mjs [subject...]
 */
const here = dirname(fileURLToPath(import.meta.url))
const repeats = Number(process.env.HOLDOUT_SMALL_REPEATS ?? 5)

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(subjects)) {
  const subject = subjects[name]
  const result = JSON.parse(readFileSync(join(here, 'results', `${name}.json`), 'utf8'))
  const last = result.revisions.at(-1)
  const selected = last.decisions.fork.selected
  const sets = { selected, single: selected.slice(0, 1) }
  const report = { subject: name, revision: last.revision, repeats, sets, runs: {} }
  for (const [label, files] of Object.entries(sets)) {
    const samples = Object.fromEntries(HOSTS.map(host => [host, []]))
    for (let round = 0; round < repeats; round++) {
      for (const host of round % 2 === 0 ? HOSTS : [...HOSTS].reverse()) {
        const run = fullRun({ ...subject, filters: files }, join(work, name, host))
        samples[host].push({ wallMs: run.wallMs, exitCode: run.exitCode, files: Object.keys(run.files).length })
        log(`${name}: ${label} (${files.length} files) ${host} #${round + 1}: ${(run.wallMs / 1000).toFixed(1)} s`)
      }
    }
    const medians = Object.fromEntries(HOSTS.map(host => [host, median(samples[host].map(sample => sample.wallMs))]))
    report.runs[label] = { files: files.length, samples, medianMs: medians, pluginOverFork: medians.plugin / medians.fork }
  }
  const output = join(here, 'results', `${name}.small-runs.json`)
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  log(`${name}: wrote ${output}`)
}
