import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { canonicalStates } from '../test/harness.ts'

/**
 * Replays real commits of holdout subjects through the FASTER fork and through
 * upstream Vitest 4.1.7 with the `vitest-faster` plugin, and compares their
 * decisions. See README.md for the protocol.
 *
 *   node test/faster-compat/holdout/run.mjs [subject...]
 *
 * HOLDOUT_WORK      work directory (default: test/faster-compat/holdout/.work)
 * HOLDOUT_TIMING    interleaved timing repetitions per configuration (default 3, 0 skips)
 */
const here = dirname(fileURLToPath(import.meta.url))
const repository = resolve(here, '../../..')
const work = resolve(process.env.HOLDOUT_WORK ?? join(here, '.work'))
const subjects = JSON.parse(readFileSync(join(here, 'subjects.json'), 'utf8'))
const timingRepetitions = Number(process.env.HOLDOUT_TIMING ?? 3)
const HOSTS = ['fork', 'plugin']
const RUN_OPTIONS = { optimizeFor: 'apfd' }
const DECIDE_OPTIONS = { optimizeFor: 'apfd', selectAffected: true }
const RUN_TIMEOUT = 90 * 60_000

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 30, ...options })
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.signal}):\n${result.stdout?.slice(-4000)}\n${result.stderr?.slice(-4000)}`)
  }
  return result
}

function git(cwd, ...args) {
  return run('git', args, { cwd }).stdout.trim()
}

function stable(value) {
  if (Array.isArray(value)) {
    return value.map(stable)
  }
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
    : value
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(stable(value) ?? null)).digest('hex')
}

function pack() {
  const destination = join(work, 'pack')
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  for (const [name, directory] of [['faster', 'faster'], ['vitest-faster', 'vitest-faster']]) {
    const temporary = join(destination, `${name}-tmp`)
    mkdirSync(temporary)
    run('pnpm', ['pack', '--pack-destination', temporary], {
      cwd: join(repository, 'packages', directory),
      env: { ...process.env, npm_config_ignore_scripts: 'true' },
    })
    renameSync(join(temporary, readdirSync(temporary)[0]), join(destination, `${name}.tgz`))
    rmSync(temporary, { recursive: true })
  }
  return destination
}

/** The `test/faster-compat` hosts, with the subject's Vite and test environments. */
function installHosts(name, subject, packs) {
  const hosts = {}
  for (const host of HOSTS) {
    const directory = join(work, name, 'hosts', host)
    rmSync(directory, { recursive: true, force: true })
    mkdirSync(directory, { recursive: true })
    const dependencies = host === 'fork'
      ? { 'vitest': `file:${join(packs, 'faster.tgz')}`, '@vitest/coverage-v8': '4.1.7' }
      : { 'vitest': '4.1.7', '@vitest/coverage-v8': '4.1.7', 'vitest-faster': `file:${join(packs, 'vitest-faster.tgz')}` }
    writeFileSync(join(directory, 'package.json'), JSON.stringify({
      name: `holdout-host-${name}-${host}`,
      private: true,
      type: 'module',
      dependencies: { ...dependencies, ...subject.hostDependencies },
    }, null, 2))
    run('pnpm', ['install', '--ignore-workspace', '--force'], { cwd: directory })
    hosts[host] = directory
  }
  return hosts
}

function cloneSubject(name, subject) {
  const origin = join(work, name, 'origin')
  if (!existsSync(origin)) {
    log(`${name}: cloning ${subject.repository}`)
    run('git', ['clone', '--quiet', subject.repository, origin])
  }
  const clones = {}
  for (const host of HOSTS) {
    const clone = join(work, name, host)
    rmSync(clone, { recursive: true, force: true })
    run('git', ['clone', '--quiet', '--no-checkout', origin, clone])
    clones[host] = clone
  }
  return { origin, clones }
}

function packageVersion(directory) {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version
}

/** Checks out a revision, installs it as the project pins it, then swaps Vitest for the host. */
function prepare(name, subject, clone, host, hostDirectory, revision) {
  git(clone, 'checkout', '--quiet', '--force', revision)
  git(clone, 'clean', '-fdq')
  const { packageManager } = JSON.parse(readFileSync(join(clone, 'package.json'), 'utf8'))
  if (!packageManager?.startsWith('pnpm@')) {
    throw new Error(`${name}@${revision}: expected a pnpm packageManager, found ${packageManager}`)
  }
  run('npx', ['-y', packageManager.split('+')[0], 'install', '--frozen-lockfile'], {
    cwd: clone,
    env: { ...process.env, CI: 'true' },
  })
  const pinned = {}
  for (const dependency of Object.keys(subject.hostDependencies)) {
    const installed = join(clone, 'node_modules', dependency)
    pinned[dependency] = existsSync(installed) ? packageVersion(installed) : null
    if (pinned[dependency] && pinned[dependency] !== subject.hostDependencies[dependency]) {
      throw new Error(`${name}@${revision} pins ${dependency}@${pinned[dependency]}, hosts use ${subject.hostDependencies[dependency]}; update subjects.json`)
    }
  }
  const projectVitest = packageVersion(join(clone, 'node_modules/vitest'))
  const links = ['vitest', '@vitest/coverage-v8', ...(host === 'plugin' ? ['vitest-faster'] : [])]
  for (const link of links) {
    const target = realpathSync(join(hostDirectory, 'node_modules', link))
    const path = join(clone, 'node_modules', link)
    rmSync(path, { recursive: true, force: true })
    mkdirSync(dirname(path), { recursive: true })
    symlinkSync(target, path, 'dir')
  }
  const config = join(clone, subject.config)
  writeFileSync(config, patchConfig(readFileSync(config, 'utf8'), host))
  return { packageManager, projectVitest, hostVitest: packageVersion(join(clone, 'node_modules/vitest')), pinned }
}

/**
 * Adds the same settings on both hosts, read from `HOLDOUT_FASTER`: the fork
 * takes them as `test.faster`, upstream Vitest as `faster()` in the root
 * plugins. Projects inherit both through `extends`. One worker, so files run
 * one after another.
 */
export function patchConfig(source, host) {
  const options = 'JSON.parse(process.env.HOLDOUT_FASTER)'
  const testPattern = /^ {2}test: \{$/m
  if (!testPattern.test(source)) {
    throw new Error('Could not find the root `test: {` block')
  }
  let patched = source.replace(testPattern, [
    '  test: {',
    '    maxWorkers: 1,',
    '    fileParallelism: false,',
    ...(host === 'fork' ? [`    faster: ${options},`] : []),
  ].join('\n'))
  if (host === 'plugin') {
    const pluginsPattern = /^ {2}plugins: \[$/m
    patched = pluginsPattern.test(patched)
      ? patched.replace(pluginsPattern, `  plugins: [\n    __holdoutFaster(${options}),`)
      : patched.replace(testPattern, `  plugins: [__holdoutFaster(${options})],\n  test: {`)
    patched = `import { faster as __holdoutFaster } from 'vitest-faster'\n${patched}`
  }
  return patched
}

function decide(subject, clone, label, durations) {
  const out = join(clone, '..', `decide-${label}.json`)
  rmSync(out, { force: true })
  const env = {
    ...process.env,
    CI: 'true',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    VITEST_FASTER_OPTIONS: '',
    HOLDOUT_ROOT: clone,
    HOLDOUT_CONFIG: subject.config,
    HOLDOUT_PROJECT: subject.project,
    HOLDOUT_FASTER: JSON.stringify(DECIDE_OPTIONS),
    HOLDOUT_OUT: out,
  }
  if (durations) {
    const file = join(clone, '..', `durations-${label}.json`)
    writeFileSync(file, JSON.stringify(durations))
    env.HOLDOUT_DURATIONS = file
  }
  const started = performance.now()
  run('node', [join(here, 'decide.mjs')], { cwd: clone, env })
  const result = JSON.parse(readFileSync(out, 'utf8'))
  result.timings.processMs = performance.now() - started
  return result
}

function vitestBin(clone) {
  const directory = realpathSync(join(clone, 'node_modules/vitest'))
  const { bin } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  return join(directory, typeof bin === 'string' ? bin : bin.vitest)
}

function fullRun(subject, clone, options = RUN_OPTIONS) {
  const report = join(clone, '..', `report-${basename(clone)}.json`)
  rmSync(report, { force: true })
  const started = performance.now()
  const result = run('node', [vitestBin(clone), 'run', '--project', subject.project, '--reporter=dot', `--reporter=${join(here, 'reporter.mjs')}`, ...(subject.filters ?? [])], {
    cwd: clone,
    allowFailure: true,
    timeout: RUN_TIMEOUT,
    env: {
      ...process.env,
      CI: 'true',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      VITEST_FASTER_OPTIONS: '',
      HOLDOUT_FASTER: JSON.stringify(options),
      HOLDOUT_REPORT: report,
    },
  })
  const wallMs = performance.now() - started
  if (!existsSync(report)) {
    throw new Error(`Run in ${clone} produced no report (${result.status ?? result.signal}):\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`)
  }
  const raw = JSON.parse(readFileSync(report, 'utf8'))
  return { exitCode: result.status, wallMs, ...raw, output: `${result.stdout}\n${result.stderr}`.slice(-3000) }
}

/** FASTER's persisted per-test source and function state, and its per-file history. */
function readPersisted(clone) {
  const cache = join(clone, 'node_modules/.vite/vitest')
  const sources = {}
  const history = {}
  for (const directory of existsSync(cache) ? readdirSync(cache).sort() : []) {
    const state = join(cache, directory, 'faster-sources.json')
    if (existsSync(state)) {
      sources[directory] = JSON.parse(readFileSync(state, 'utf8'))
    }
    for (const file of ['results.json', 'faster-results.json']) {
      const path = join(cache, directory, file)
      if (existsSync(path)) {
        const { results } = JSON.parse(readFileSync(path, 'utf8'))
        history[`${directory}/${file}`] = Object.fromEntries(Array.isArray(results) ? results : Object.entries(results ?? {}))
      }
    }
  }
  return { sources, history }
}

/** Per-file outcome and every test's state, without timing. */
function outcomes(report) {
  return Object.fromEntries(Object.entries(report.files).map(([file, { state, tests }]) => [file, { state, tests }]))
}

function summarizeOutcomes(report) {
  const files = Object.values(report.files)
  const tests = files.flatMap(file => Object.values(file.tests))
  const count = (values, state) => values.filter(value => value === state).length
  return {
    files: files.length,
    failedFiles: Object.entries(report.files).filter(([, file]) => file.state === 'failed').map(([file]) => file),
    tests: tests.length,
    passed: count(tests, 'passed'),
    failed: count(tests, 'failed'),
    skipped: count(tests, 'skipped'),
  }
}

function differences(left, right) {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
  return keys.filter(key => !isDeepStrictEqual(left[key], right[key]))
}

/** Positions at which two orders disagree, and the first few of them. */
function orderDifference(left, right) {
  const positions = left.map((file, index) => file === right[index] ? -1 : index).filter(index => index >= 0)
  return {
    equal: isDeepStrictEqual(left, right),
    sameMembers: isDeepStrictEqual([...left].sort(), [...right].sort()),
    differingPositions: positions.length,
    first: positions.slice(0, 5).map(index => ({ index, fork: left[index], plugin: right[index] })),
  }
}

function durationsOf(history) {
  return Object.fromEntries(Object.entries(history).filter(([, value]) => value).map(([key, value]) => [key, value.duration]))
}

/** Pairs of files whose duration ranks the two hosts disagree on. */
function rankInversions(left, right) {
  const keys = Object.keys(left).filter(key => key in right)
  let inversions = 0
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = Math.sign(left[keys[i]] - left[keys[j]])
      const b = Math.sign(right[keys[i]] - right[keys[j]])
      if (a !== b) {
        inversions++
      }
    }
  }
  return { files: keys.length, pairs: keys.length * (keys.length - 1) / 2, inversions }
}

function compareStates(states) {
  const canonical = Object.fromEntries(HOSTS.map(host => [host, canonicalStates(states[host])]))
  return canonical.fork.map((fork, index) => {
    const plugin = canonical.plugin[index]
    const equal = isDeepStrictEqual(fork, plugin)
    const directories = Object.keys(fork ?? {})
    const tests = directories.reduce((sum, directory) => sum + Object.keys(fork[directory].tests ?? {}).length, 0)
    const functionTests = directories.reduce((sum, directory) => sum + Object.keys(fork[directory].functionTests ?? {}).length, 0)
    const detail = equal
      ? undefined
      : Object.fromEntries([...new Set([...directories, ...Object.keys(plugin ?? {})])].map(directory => [directory, {
          tests: differences(fork?.[directory]?.tests ?? {}, plugin?.[directory]?.tests ?? {}).slice(0, 20),
          functionTests: Object.fromEntries(differences(fork?.[directory]?.functionTests ?? {}, plugin?.[directory]?.functionTests ?? {}).slice(0, 20).map(test => [
            test,
            functionDifferences(fork?.[directory]?.functionTests?.[test], plugin?.[directory]?.functionTests?.[test]),
          ])),
        }]))
    return { equal, cacheDirectories: directories, tests, functionTests, sha256: { fork: sha256(fork), plugin: sha256(plugin) }, detail }
  })
}

/** Which recorded sources, functions and fields of one test differ. */
function functionDifferences(fork = {}, plugin = {}, [first, second] = ['fork', 'plugin']) {
  return differences(fork, plugin).slice(0, 20).map((path) => {
    const left = fork[path]
    const right = plugin[path]
    if (!left || !right) {
      return { path, onlyIn: left ? first : second }
    }
    const fields = differences({ ...left, functions: undefined }, { ...right, functions: undefined })
      .map(field => ({ field, [first]: left[field], [second]: right[field] }))
    const functions = differences(left.functions, right.functions).slice(0, 20).map(id => ({ id, [first]: left.functions[id], [second]: right.functions[id] }))
    return { path, fields, functions }
  })
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

async function replay(name) {
  const subject = subjects[name]
  const output = join(here, 'results', `${name}.json`)
  const packs = pack()
  const hosts = installHosts(name, subject, packs)
  const { origin, clones } = cloneSubject(name, subject)
  const result = {
    subject: name,
    repository: subject.repository,
    project: subject.project,
    config: subject.config,
    protocol: {
      runOptions: RUN_OPTIONS,
      decideOptions: DECIDE_OPTIONS,
      maxWorkers: 1,
      fileParallelism: false,
      hosts: { fork: 'packages/faster packed and installed as vitest, @vitest/coverage-v8@4.1.7', plugin: 'vitest@4.1.7, @vitest/coverage-v8@4.1.7, packages/vitest-faster packed' },
      hostDependencies: subject.hostDependencies,
    },
    faster: git(repository, 'rev-parse', 'HEAD'),
    node: process.version,
    startedAt: new Date().toISOString(),
    revisions: [],
  }
  const states = { fork: [], plugin: [] }
  const save = () => {
    const compared = compareStates(states)
    result.revisions.forEach((revision, index) => {
      revision.persistedState = compared[index]
    })
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
  }

  const revisions = [subject.warmup, ...subject.targets]
  let previous
  for (const [index, revision] of revisions.entries()) {
    const warmup = index === 0
    log(`${name}: ${warmup ? 'warm-up' : `target ${index}/${subject.targets.length}`} ${revision}`)
    const entry = {
      revision,
      role: warmup ? 'warm-up' : 'target',
      subject: git(origin, 'log', '-1', '--format=%s', revision),
      changedFiles: previous ? git(origin, 'diff', '--name-only', previous, revision).split('\n').filter(Boolean) : undefined,
      install: {},
    }
    for (const host of HOSTS) {
      entry.install[host] = prepare(name, subject, clones[host], host, hosts[host], revision)
    }

    const decisions = {}
    for (const host of HOSTS) {
      decisions[host] = decide(subject, clones[host], host)
      log(`${name}: ${host} decided ${decisions[host].order.length} files, selected ${decisions[host].selected.length}`)
    }
    const forkDurations = durationsOf(decisions.fork.history)
    const pluginDurations = durationsOf(decisions.plugin.history)
    const shared = {
      pluginWithForkDurations: decide(subject, clones.plugin, 'plugin-shared', forkDurations),
      forkWithPluginDurations: decide(subject, clones.fork, 'fork-shared', pluginDurations),
    }
    entry.decisions = {
      fork: { order: decisions.fork.order, selected: decisions.fork.selected, selectedOrder: decisions.fork.selectedOrder },
      plugin: { order: decisions.plugin.order, selected: decisions.plugin.selected, selectedOrder: decisions.plugin.selectedOrder },
      pluginWithForkDurations: { order: shared.pluginWithForkDurations.order, selectedOrder: shared.pluginWithForkDurations.selectedOrder },
      forkWithPluginDurations: { order: shared.forkWithPluginDurations.order, selectedOrder: shared.forkWithPluginDurations.selectedOrder },
      forkFasterSequencer: decisions.fork.intended,
      forkFasterSequencerWithPluginDurations: shared.forkWithPluginDurations.intended,
    }
    entry.hostInfo = Object.fromEntries(HOSTS.map(host => [host, { vitest: decisions[host].vitest, sequencer: decisions[host].sequencer, faster: decisions[host].faster, files: decisions[host].files }]))
    entry.comparison = {
      fullOrder: orderDifference(decisions.fork.order, decisions.plugin.order),
      selectedSet: { equal: isDeepStrictEqual(decisions.fork.selected, decisions.plugin.selected), fork: decisions.fork.selected.length, plugin: decisions.plugin.selected.length, onlyFork: decisions.fork.selected.filter(file => !decisions.plugin.selected.includes(file)), onlyPlugin: decisions.plugin.selected.filter(file => !decisions.fork.selected.includes(file)) },
      selectedOrder: orderDifference(decisions.fork.selectedOrder, decisions.plugin.selectedOrder),
      sharedDurations: {
        forkHistory: {
          fullOrder: orderDifference(decisions.fork.order, shared.pluginWithForkDurations.order),
          selectedOrder: orderDifference(decisions.fork.selectedOrder, shared.pluginWithForkDurations.selectedOrder),
        },
        pluginHistory: {
          fullOrder: orderDifference(shared.forkWithPluginDurations.order, decisions.plugin.order),
          selectedOrder: orderDifference(shared.forkWithPluginDurations.selectedOrder, decisions.plugin.selectedOrder),
        },
      },
      // Only when the fork's configuration bypassed its FasterSequencer: the
      // same comparisons against the order FasterSequencer computes.
      forkFasterSequencer: decisions.fork.intended && {
        fullOrder: orderDifference(decisions.fork.intended.order, decisions.plugin.order),
        selectedOrder: orderDifference(decisions.fork.intended.selectedOrder, decisions.plugin.selectedOrder),
        sharedDurations: {
          forkHistory: {
            fullOrder: orderDifference(decisions.fork.intended.order, shared.pluginWithForkDurations.order),
            selectedOrder: orderDifference(decisions.fork.intended.selectedOrder, shared.pluginWithForkDurations.selectedOrder),
          },
          pluginHistory: {
            fullOrder: orderDifference(shared.forkWithPluginDurations.intended.order, decisions.plugin.order),
            selectedOrder: orderDifference(shared.forkWithPluginDurations.intended.selectedOrder, decisions.plugin.selectedOrder),
          },
        },
      },
      history: {
        sameFiles: isDeepStrictEqual(Object.keys(decisions.fork.history), Object.keys(decisions.plugin.history)),
        failedFlagsEqual: isDeepStrictEqual(
          Object.fromEntries(Object.entries(decisions.fork.history).map(([key, value]) => [key, value?.failed ?? null])),
          Object.fromEntries(Object.entries(decisions.plugin.history).map(([key, value]) => [key, value?.failed ?? null])),
        ),
        durationRanks: rankInversions(forkDurations, pluginDurations),
      },
    }
    entry.decisionTimings = Object.fromEntries(HOSTS.map(host => [host, decisions[host].timings]))

    // Alternate which host runs first so machine drift does not favour one.
    const runOrder = index % 2 === 0 ? HOSTS : [...HOSTS].reverse()
    const runs = {}
    for (const host of runOrder) {
      log(`${name}: ${host} full run`)
      runs[host] = fullRun(subject, clones[host])
      log(`${name}: ${host} exit ${runs[host].exitCode} in ${(runs[host].wallMs / 1000).toFixed(1)} s`)
      const persisted = readPersisted(clones[host])
      states[host].push(persisted.sources)
      writeFileSync(join(work, name, `state-${host}-${index}.json`), JSON.stringify(persisted))
    }
    entry.runs = Object.fromEntries(HOSTS.map(host => [host, {
      exitCode: runs[host].exitCode,
      reason: runs[host].reason,
      errors: runs[host].errors,
      wallMs: runs[host].wallMs,
      executedOrderMatchesDecision: isDeepStrictEqual(runs[host].order, decisions[host].order),
      executedOrder: runs[host].order,
      outcomes: summarizeOutcomes(runs[host]),
      outputTail: runs[host].exitCode === 0 ? undefined : runs[host].output,
    }]))
    entry.runOrder = runOrder
    const outcomeDifferences = differences(outcomes(runs.fork), outcomes(runs.plugin))
    entry.comparison.outcomes = {
      equal: outcomeDifferences.length === 0,
      differingFiles: outcomeDifferences.map(file => ({ file, fork: runs.fork.files[file], plugin: runs.plugin.files[file] })),
    }
    result.revisions.push(entry)
    previous = revision
    save()
  }

  if (timingRepetitions > 0) {
    result.timing = timing(name, subject, clones)
  }
  result.finishedAt = new Date().toISOString()
  save()
  log(`${name}: wrote ${output}`)
}

/**
 * Wall-clock runs at the last revision, interleaved so drift spreads over
 * every configuration. `off` disables FASTER on the same host (the plugin
 * then does nothing, which is plain upstream Vitest 4.1.7).
 */
function timing(name, subject, clones) {
  const configurations = [
    { host: 'fork', faster: 'on', options: RUN_OPTIONS },
    { host: 'plugin', faster: 'on', options: RUN_OPTIONS },
    { host: 'fork', faster: 'off', options: { enabled: false } },
    { host: 'plugin', faster: 'off', options: { enabled: false } },
  ]
  const samples = Object.fromEntries(configurations.map(configuration => [`${configuration.host}-${configuration.faster}`, []]))
  for (let repetition = 0; repetition < timingRepetitions; repetition++) {
    const rotation = configurations.map((_, index) => configurations[(index + repetition) % configurations.length])
    for (const configuration of rotation) {
      const key = `${configuration.host}-${configuration.faster}`
      const outcome = fullRun(subject, clones[configuration.host], configuration.options)
      const duration = Object.values(outcome.files).length
      samples[key].push({ wallMs: outcome.wallMs, exitCode: outcome.exitCode, files: duration })
      log(`${name}: timing ${key} #${repetition + 1}: ${(outcome.wallMs / 1000).toFixed(1)} s`)
    }
  }
  const summary = Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, {
    medianMs: median(values.map(value => value.wallMs)),
    minMs: Math.min(...values.map(value => value.wallMs)),
    maxMs: Math.max(...values.map(value => value.wallMs)),
    samples: values,
  }]))
  const ratio = (a, b) => summary[a].medianMs / summary[b].medianMs
  return {
    repetitions: timingRepetitions,
    summary,
    pluginOverFork: ratio('plugin-on', 'fork-on'),
    fasterOverhead: { fork: ratio('fork-on', 'fork-off'), plugin: ratio('plugin-on', 'plugin-off') },
  }
}

export { differences, fullRun, functionDifferences, HOSTS, log, readPersisted, RUN_OPTIONS, subjects, work }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selected = process.argv.slice(2)
  for (const name of selected.length ? selected : Object.keys(subjects)) {
    if (!subjects[name]) {
      throw new Error(`Unknown subject ${name}`)
    }
    await replay(name)
  }
}
