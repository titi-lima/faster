import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fullRun, HOSTS, log, subjects, work } from './run.mjs'

/**
 * Attributes the fixed per-run cost of the plugin on a one-file run (the
 * single file of `small-runs.mjs`). Run after small-runs.mjs.
 * - Each host runs the file 5 times per configuration, interleaved:
 *   FASTER on, FASTER on without change tracking (`changed: false`, so no
 *   source snapshot and no forced coverage), and FASTER off.
 * - The plugin's `sort` is timed alone 3 times. It waits for the pre-run
 *   source snapshot, which the fork takes while its workers start.
 *
 *   node test/faster-compat/holdout/overhead.mjs [subject...]
 */
const here = dirname(fileURLToPath(import.meta.url))
const rounds = 5

if (process.env.HOLDOUT_SORT_ONLY) {
  const [root, config, project, file] = JSON.parse(process.env.HOLDOUT_SORT_ONLY)
  const directory = realpathSync(join(root, 'node_modules/vitest'))
  const { exports } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const entry = exports['./node'].import?.default ?? exports['./node'].import ?? exports['./node'].default
  const { createVitest } = await import(pathToFileURL(join(directory, entry)).href)
  const vitest = await createVitest('test', { root, config: join(root, config), project: [project], watch: false, reporters: [] })
  const specifications = await vitest.globTestSpecifications([file])
  const started = performance.now()
  const Sequencer = vitest.config.sequence.sequencer
  await new Sequencer(vitest).sort(specifications)
  process.stdout.write(`${JSON.stringify({ files: specifications.length, sortMs: performance.now() - started })}\n`)
  await vitest.close()
  process.exit(0)
}

const { spawnSync } = await import('node:child_process')
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const configurations = [
  ['on', { optimizeFor: 'apfd' }],
  ['no-change-tracking', { optimizeFor: 'apfd', changed: false }],
  ['off', { enabled: false }],
]

for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(subjects)) {
  const subject = subjects[name]
  const [file] = JSON.parse(readFileSync(join(here, 'results', `${name}.small-runs.json`), 'utf8')).sets.single
  const samples = {}
  for (let round = 0; round < rounds; round++) {
    const order = configurations.flatMap(([label, options]) => HOSTS.map(host => [host, label, options]))
    for (const [host, label, options] of round % 2 ? order.reverse() : order) {
      const run = fullRun({ ...subject, filters: [file] }, join(work, name, host), options)
      ;(samples[`${host}/${label}`] ??= []).push({ wallMs: run.wallMs, exitCode: run.exitCode })
    }
  }
  const clone = join(work, name, 'plugin')
  const pluginSort = Array.from({ length: 3 }, () => JSON.parse(spawnSync('node', [fileURLToPath(import.meta.url)], {
    cwd: clone,
    encoding: 'utf8',
    env: { ...process.env, HOLDOUT_FASTER: JSON.stringify({ optimizeFor: 'apfd' }), HOLDOUT_SORT_ONLY: JSON.stringify([clone, subject.config, subject.project, file]) },
  }).stdout.trim().split('\n').at(-1)))
  const medians = Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, median(values.map(value => value.wallMs))]))
  const report = {
    subject: name,
    file,
    rounds,
    medianMs: medians,
    pluginMinusForkMs: Object.fromEntries(configurations.map(([label]) => [label, medians[`plugin/${label}`] - medians[`fork/${label}`]])),
    pluginSortWithSnapshotMs: pluginSort.map(value => value.sortMs),
    samples,
  }
  writeFileSync(join(here, 'results', `${name}.overhead.json`), `${JSON.stringify(report, null, 2)}\n`)
  log(`${name}: ${JSON.stringify(report.pluginMinusForkMs)} sort ${pluginSort.map(value => value.sortMs.toFixed(0)).join(' ')}`)
}
