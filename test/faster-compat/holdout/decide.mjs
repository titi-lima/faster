import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Computes one host's FASTER decisions for the checked-out revision without
 * running any test: the full order, the `selectAffected` set and the order of
 * that set. Vitest is loaded from the subject's `node_modules`, which points
 * at either the fork or upstream Vitest with the plugin.
 *
 * Environment:
 * - HOLDOUT_ROOT, HOLDOUT_CONFIG, HOLDOUT_PROJECT: the subject.
 * - HOLDOUT_FASTER: FASTER options the patched configuration reads.
 * - HOLDOUT_OUT: where to write the JSON result.
 * - HOLDOUT_DURATIONS (optional): a JSON file mapping result keys to
 *   durations. They replace this host's recorded durations, and only them, so
 *   both hosts can rank files by the same durations.
 */
const root = resolve(process.env.HOLDOUT_ROOT)
const vitestDirectory = realpathSync(join(root, 'node_modules/vitest'))
const { exports } = JSON.parse(readFileSync(join(vitestDirectory, 'package.json'), 'utf8'))
const nodeEntry = exports['./node'].import?.default ?? exports['./node'].import ?? exports['./node'].default
const { createVitest } = await import(pathToFileURL(join(vitestDirectory, nodeEntry)).href)

const vitest = await createVitest('test', {
  root,
  config: resolve(root, process.env.HOLDOUT_CONFIG),
  project: [process.env.HOLDOUT_PROJECT],
  watch: false,
  reporters: [],
})

try {
  const host = globalThis[Symbol.for('vitest-faster.hosts')]?.get(vitest)
  // The fork reads `vitest.cache`; the plugin reads its own results file.
  const history = host ? host.results : vitest.cache
  const method = host ? 'get' : 'getFileTestResults'
  const read = history[method].bind(history)

  const all = await vitest.globTestSpecifications()
  const key = specification => `${specification.project.name}:${relative(vitest.config.root, specification.moduleId)}`
  const recorded = Object.fromEntries(all.map(specification => [key(specification), read(key(specification)) ?? null]).sort(([a], [b]) => a.localeCompare(b)))

  if (process.env.HOLDOUT_DURATIONS) {
    const durations = JSON.parse(readFileSync(process.env.HOLDOUT_DURATIONS, 'utf8'))
    history[method] = (name) => {
      const result = read(name)
      return result && Object.hasOwn(durations, name) ? { ...result, duration: durations[name] } : result
    }
  }

  const Sequencer = vitest.config.sequence.sequencer
  const sequencer = new Sequencer(vitest)
  const file = specification => relative(root, specification.moduleId)
  let started = performance.now()
  const order = (await sequencer.sort(all)).map(file)
  const sortMs = performance.now() - started
  started = performance.now()
  const selection = await vitest.specifications.getRelevantTestSpecifications()
  const selectMs = performance.now() - started
  const selectedOrder = (await sequencer.sort(selection)).map(file)

  // The fork skips its own sequencer whenever the user config has a `sequence`
  // object: `resolved.sequence` aliases `options.sequence`, so the default it
  // just assigned reads as a user sequencer. Its FasterSequencer is not
  // exported, so take the class from a configuration without `sequence`.
  let intended
  if (!host && vitest.config.faster.enabled && Sequencer.name !== 'FasterSequencer') {
    const FasterSequencer = await forkFasterSequencer()
    const faster = new FasterSequencer(vitest)
    intended = {
      sequencer: FasterSequencer.name,
      order: (await faster.sort(all)).map(file),
      selectedOrder: (await faster.sort(selection)).map(file),
    }
  }

  writeFileSync(process.env.HOLDOUT_OUT, JSON.stringify({
    vitest: vitest.version,
    plugin: Boolean(host),
    sequencer: Sequencer.name,
    intended,
    faster: vitest.projects.map(project => ({ project: project.name, options: host ? host.faster(project) : project.config.faster })),
    files: all.length,
    timings: { sortMs, selectMs },
    order,
    selected: [...selectedOrder].sort(),
    selectedOrder,
    history: recorded,
  }, null, 2))
}
finally {
  await vitest.close()
}

async function forkFasterSequencer() {
  const empty = mkdtempSync(join(tmpdir(), 'holdout-sequencer-'))
  writeFileSync(join(empty, 'vitest.config.mjs'), 'export default { test: { faster: {} } }\n')
  const probe = await createVitest('test', { root: empty, config: join(empty, 'vitest.config.mjs'), watch: false, reporters: [] })
  try {
    const Sequencer = probe.config.sequence.sequencer
    if (Sequencer.name !== 'FasterSequencer') {
      throw new Error(`Expected the fork's FasterSequencer, found ${Sequencer.name}`)
    }
    return Sequencer
  }
  finally {
    await probe.close()
    rmSync(empty, { recursive: true, force: true })
  }
}
