import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { nativeExecutionEnvironment } from '../javascript/native-env'
import { restoreNativeDependencies } from '../javascript/native-install'
import { linkWorkspaceModules } from '../javascript/overlay-runtime'
import { restoreTree, snapshotTree } from '../javascript/work-tree'

// Replays recorded study revisions against several FASTER builds without touching the recorded study data:
// private copies of the per-revision native installs and the recorded prior caches. The study facade links the
// fork outside node_modules, so FASTER tracks the fork's own dist files and their location shapes function models;
// every build is therefore cloned once and renamed into one fixed path before it runs. The replay checkout must be
// research/work/<out>/checkout, the depth at which the recorded caches' relative fork paths were written.

interface Entry { revision: string; parent: string; runtime: string; nativeRuntime: string; nativeConfig?: string; buildArtifacts?: string[] }
interface Build { name: string; repo: string }
interface Execution { order: string[]; modules: { file: string; state: string; errors: string[] }[]; cases: { file: string; id: string; name: string; state: string; errors?: unknown[] }[]; errors: string[] }

const here = dirname(fileURLToPath(import.meta.url))
const mainRepo = resolve(process.env.FASTER_MAIN_REPO || resolve(here, '../..'))
const { values } = parseArgs({ options: {
  'study': { type: 'string' },
  'out': { type: 'string' },
  'builds': { type: 'string' },
  'revisions': { type: 'string', default: 'all' },
  'checks': { type: 'string', default: 'features,execute' },
  'bench': { type: 'string', default: '0' },
  'stock': { type: 'boolean', default: false },
  'isolate': { type: 'boolean', default: false },
  'project': { type: 'string' },
  'seed': { type: 'string', default: '20261030' },
  'cpu-prof': { type: 'boolean', default: false },
  'forks': { type: 'string' },
  'installs': { type: 'string' },
} })
if (!values.study || !values.out || !values.builds) {
  throw new Error('Usage: node --import tsx research/perf/replay.ts --study STUDY --out DIR --builds old=REPO,new=REPO [--revisions all|r1,r2] [--checks features,execute] [--bench PAIRS] [--stock]')
}
const study = resolve(values.study)
const out = resolve(values.out)
const builds: Build[] = values.builds.split(',').map((item) => {
  const [name, repo] = item.split('=')
  return { name, repo: resolve(repo) }
})
const forks = resolve(values.forks || join(dirname(out), 'perf-forks'))
const fork = join(forks, 'fork')
const installs = resolve(values.installs || join(dirname(out), 'perf-installs'), study.split('/').at(-1)!)
const checks = new Set(values.checks!.split(',').filter(Boolean))
const pairs = Number(values.bench)
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function write(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

const manifest = json(join(study, 'manifest.json')) as { repository: string; subjectDir?: string; entries: Entry[] }
const subjectDir = manifest.subjectDir ?? ''
const ledger = json(join(study, 'ledger.json')) as { revision: string; status: string }[]
const completed = new Set(ledger.filter(row => row.status === 'completed').map(row => row.revision))
const wanted = values.revisions === 'all' ? undefined : new Set(values.revisions!.split(','))
const entries = manifest.entries.filter(entry => completed.has(entry.revision) && (!wanted || [...wanted].some(prefix => entry.revision.startsWith(prefix))))
const work = join(out, 'checkout')
const root = join(work, subjectDir)
const cache = join(root, '.study-cache')
const env = { ...process.env, CI: 'true', TZ: 'UTC', NO_COLOR: '1', LANG: 'en_US.UTF-8' }
let currentConfig = ''

// Hash of what a build executes: every package dist plus the FASTER sources and harness the phases import.
function buildFingerprint(repo: string) {
  const digest = createHash('sha256')
  const visit = (directory: string) => {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = join(directory, item.name)
      if (item.isDirectory()) {
        visit(path)
      }
      else if (item.isFile()) {
        digest.update(path.slice(repo.length)).update(readFileSync(path))
      }
    }
  }
  for (const name of readdirSync(join(repo, 'packages')).sort()) {
    if (existsSync(join(repo, 'packages', name, 'dist'))) {
      visit(join(repo, 'packages', name, 'dist'))
    }
  }
  visit(join(repo, 'packages/vitest/src/node/faster'))
  visit(join(repo, 'packages/vitest/src/node/sequencers'))
  visit(join(repo, 'research/javascript'))
  digest.update(readFileSync(join(repo, 'pnpm-lock.yaml')))
  return digest.digest('hex')
}

function stageBuilds() {
  mkdirSync(forks, { recursive: true })
  restoreActiveFork()
  return Object.fromEntries(builds.map((build) => {
    const clone = join(forks, build.name)
    const expected = buildFingerprint(build.repo)
    if (existsSync(clone) && buildFingerprint(clone) !== expected) {
      rmSync(clone, { recursive: true, force: true })
    }
    if (!existsSync(clone)) {
      execFileSync('cp', ['-cR', build.repo, clone])
      rmSync(join(clone, '.git'), { recursive: true, force: true })
      writeFileSync(join(clone, '.perf-build'), build.name)
    }
    return [build.name, { repo: build.repo, fingerprint: expected }]
  }))
}

function restoreActiveFork() {
  if (existsSync(fork)) {
    renameSync(fork, join(forks, readFileSync(join(fork, '.perf-build'), 'utf8')))
  }
}

function activate(build: Build) {
  if (existsSync(fork) && readFileSync(join(fork, '.perf-build'), 'utf8') === build.name) {
    return
  }
  restoreActiveFork()
  renameSync(join(forks, build.name), fork)
}

function prepareInstall(entry: Entry) {
  const install = join(installs, entry.revision)
  const native = join(install, 'native')
  if (!existsSync(join(install, 'ready'))) {
    rmSync(install, { recursive: true, force: true })
    cpSync(entry.nativeRuntime, native, { recursive: true, filter: path => !path.slice(entry.nativeRuntime.length).split('/').includes('node_modules') })
    restoreNativeDependencies(native, install, mainRepo, subjectDir)
    writeFileSync(join(install, 'ready'), '')
  }
  const facade = join(install, 'facade')
  if (!existsSync(facade)) {
    mkdirSync(join(facade, 'node_modules/@vitest'), { recursive: true })
    for (const file of ['package.json', 'pnpm-lock.yaml']) {
      cpSync(join(entry.runtime, file), join(facade, file))
    }
    for (const name of readdirSync(join(entry.runtime, 'node_modules'))) {
      const source = join(entry.runtime, 'node_modules', name)
      if (name === '@vitest') {
        for (const scoped of readdirSync(source)) {
          symlinkSync(join(fork, 'packages', scoped), join(facade, 'node_modules/@vitest', scoped), 'dir')
        }
      }
      else if (name === 'vitest') {
        symlinkSync(join(fork, 'packages/vitest'), join(facade, 'node_modules/vitest'), 'dir')
      }
      else if (lstatSync(source).isSymbolicLink()) {
        const target = readlinkSync(source)
        if (!target.startsWith(`${entry.nativeRuntime}/`)) {
          throw new Error(`Unexpected facade link ${source} -> ${target}`)
        }
        symlinkSync(join(native, target.slice(entry.nativeRuntime.length + 1)), join(facade, 'node_modules', name), 'dir')
      }
    }
  }
  return { native, facade }
}

function checkout(entry: Entry, native: string) {
  rmSync(work, { force: true, recursive: true })
  mkdirSync(work, { recursive: true })
  const archive = execFileSync('git', ['-C', manifest.repository, 'archive', entry.revision], { maxBuffer: 100_000_000 })
  execFileSync('tar', ['-x', '-C', work], { input: archive })
  cpSync(native, work, { recursive: true, filter: path => !['node_modules', '.git', '.study-cache', '.turbo', 'coverage'].some(part => path.slice(native.length).split('/').includes(part)) })
  linkWorkspaceModules(native, work)
  if (subjectDir) {
    symlinkSync(join(native, 'node_modules'), join(work, 'node_modules'), 'dir')
    rmSync(join(root, 'node_modules'), { force: true, recursive: true })
  }
  for (const artifact of entry.buildArtifacts || []) {
    cpSync(join(native, artifact), join(work, artifact), { recursive: true })
  }
  return snapshotTree(work)
}

async function phase(directory: string, build: Build, facade: string, native: string, request: Record<string, unknown>) {
  activate(build)
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  rmSync(join(root, 'node_modules'), { force: true })
  symlinkSync(join(facade, 'node_modules'), join(root, 'node_modules'), 'dir')
  write(join(directory, 'request.json'), request)
  const nativeEnv = nativeExecutionEnvironment(native, join(installs, 'toolchain'), mainRepo, subjectDir).env
  const hook = join(fork, 'research/javascript/runner-redirect.mjs')
  const log = openSync(join(directory, 'execution.log'), 'w')
  const load = loadavg()[0]
  const start = performance.now()
  let code: number | null
  try {
    code = await new Promise<number | null>((accept, reject) => {
      const child = spawn(process.execPath, [
        ...values['cpu-prof'] ? ['--cpu-prof', `--cpu-prof-dir=${join(directory, 'profile')}`, '--import', join(here, 'main-only-profile.mjs')] : [],
        '--import',
        join(fork, 'node_modules/tsx/dist/loader.mjs'),
        join(fork, 'research/javascript/phase.ts'),
      ], {
        cwd: root,
        env: { ...env, ...nativeEnv, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=file://${hook}`].filter(Boolean).join(' '), FASTER_STUDY_RUNNER_PARENT: join(facade, 'package.json'), FASTER_REPLICATION_ROOT: root, FASTER_REPLICATION_PHASE: 'full', FASTER_STUDY_ADAPTER: 'native', FASTER_STUDY_NATIVE_RUNTIME: join(native, subjectDir), FASTER_STUDY_NATIVE_CONFIG: currentConfig, FASTER_STUDY_TEST_PROJECTS: values.project ? JSON.stringify([values.project]) : '', FASTER_STUDY_ISOLATE: String(values.isolate), FASTER_STUDY_REQUEST: join(directory, 'request.json'), FASTER_STUDY_OUTPUT: join(directory, 'result.json') },
        stdio: ['ignore', log, log, 'ipc'],
      })
      child.on('error', reject)
      child.on('close', accept)
    })
  }
  finally {
    closeSync(log)
  }
  const processMs = performance.now() - start
  if ((code !== 0 && code !== 1) || !existsSync(join(directory, 'result.json'))) {
    throw new Error(`${directory} failed (code=${code}); inspect execution.log`)
  }
  const result = json(join(directory, 'result.json'))
  // Reporter timestamps are performance.now() of the Vitest process: before the first module starts,
  // while modules run, and after the last one ends (including process exit).
  const modules = (result.modules ?? []) as { startedMs?: number; endedMs: number }[]
  const first = Math.min(...modules.map(m => m.startedMs ?? m.endedMs))
  const last = Math.max(...modules.map(m => m.endedMs))
  const windows = modules.length ? { beforeFirstModuleMs: first, modulesMs: last - first, afterLastModuleMs: processMs - last } : undefined
  const timing = { build: build.name, processMs, code, load1Before: load, load1After: loadavg()[0], windows }
  write(join(directory, 'process.json'), timing)
  return { result, timing }
}

function cacheFiles(directory: string) {
  const files: Record<string, unknown> = {}
  const visit = (path: string) => {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, item.name)
      if (item.isDirectory()) {
        visit(child)
      }
      else {
        files[child.slice(directory.length + 1)] = json(child)
      }
    }
  }
  if (existsSync(directory)) {
    visit(directory)
  }
  return files
}

// The study facade links the fork's own packages outside node_modules, so FASTER tracks their dist files.
// Their location differs per build; content is compared after mapping every location to one token.
function normalizeFork(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeFork)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [normalizePath(key), normalizeFork(item)]))
  }
  return typeof value === 'string' ? normalizePath(value) : value
}
function normalizePath(path: string) {
  return path.replace(/^(?:\.\.\/)+(?:[^/]+\/)*?packages\/([a-z-]+)\/dist\//, '<fork>/$1/dist/')
}
// Function models hash Vite's transform of each module. Module-level code embeds the absolute paths of resolved
// imports (fork, native install), which differ from the recorded study; so does every function of the fork's own
// dist. Those hashes are masked against the recording; builds staged at one path are compared unmasked.
function maskLocationDependent(cache: unknown) {
  const value = structuredClone(cache) as Record<string, { functionTests?: Record<string, Record<string, { shape: string; functions: Record<string, { hash: string }> }>> }>
  for (const file of Object.values(value)) {
    for (const snapshots of Object.values(file.functionTests ?? {})) {
      for (const [path, snapshot] of Object.entries(snapshots)) {
        snapshot.shape = '<location-dependent>'
        if (path.startsWith('<fork>/')) {
          for (const fn of Object.values(snapshot.functions)) {
            fn.hash = '<location-dependent>'
          }
        }
      }
    }
  }
  return value
}
function withoutTimings(results: unknown) {
  const value = structuredClone(results) as { results?: [string, { duration?: number }][] }
  for (const [, item] of value.results ?? []) {
    delete item.duration
  }
  return value
}
function comparableCache(directory: string) {
  return Object.fromEntries(Object.entries(cacheFiles(directory)).map(([path, value]) => [path, normalizeFork(path.endsWith('results.json') ? withoutTimings(value) : value)]))
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item)
}
// Some subjects print their working directory in test names; the recorded runs used the study's checkout.
function caseIdentity(execution: Execution, checkoutPath: string) {
  const name = (value: string) => value.split(checkoutPath).join('<checkout>')
  return { order: execution.order, modules: execution.modules.map(m => [m.file, m.state, m.errors.length]), cases: execution.cases.map(t => [t.file, t.id, name(t.name), t.state]), errors: execution.errors }
}
function diffKeys(left: unknown, right: unknown, path = ''): string[] {
  if (canonical(left) === canonical(right)) {
    return []
  }
  if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    return [...keys].flatMap(key => diffKeys((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], `${path}/${key}`)).slice(0, 20)
  }
  return [path || '/']
}

function shuffle<T>(items: T[], key: string) {
  return [...items].sort((a, b) => sha(`${key}:${JSON.stringify(a)}`).localeCompare(sha(`${key}:${JSON.stringify(b)}`)))
}

async function main() {
  mkdirSync(out, { recursive: true })
  write(join(out, `run-${Date.now()}.json`), { startedUTC: new Date().toISOString(), argv: process.argv.slice(2), builds: stageBuilds(), node: process.version, study })
  const rows: Record<string, unknown>[] = existsSync(join(out, 'rows.json')) ? json(join(out, 'rows.json')) : []
  for (const [index, entry] of entries.entries()) {
    const recordedDirectory = join(study, 'revisions', entry.revision)
    process.stdout.write(`[${index + 1}/${entries.length}] ${entry.revision.slice(0, 12)}\n`)
    const row: Record<string, unknown> = { revision: entry.revision }
    try {
      const { native, facade } = prepareInstall(entry)
      currentConfig = entry.nativeConfig ?? ''
      const frozen = checkout(entry, native)
      const restore = (name: string) => {
        const restored = restoreTree(work, frozen)
        if (restored.modified.length || restored.deleted.length) {
          throw new Error(`Subject files changed during ${name}`)
        }
        rmSync(cache, { recursive: true, force: true })
        if (existsSync(join(recordedDirectory, 'prior-cache'))) {
          cpSync(join(recordedDirectory, 'prior-cache'), cache, { recursive: true })
        }
      }
      const directory = join(out, 'revisions', entry.revision)
      if (checks.has('features')) {
        const recorded = json(join(recordedDirectory, 'features/result.json'))
        const request = json(join(recordedDirectory, 'features/request.json'))
        const comparable = (value: { files: unknown; policies: unknown }) => JSON.stringify({ files: value.files, policies: value.policies })
        const features: Record<string, unknown> = {}
        for (const build of shuffle(builds, `${values.seed}:${entry.revision}:features`)) {
          restore(`features-${build.name}`)
          const result = (await phase(join(directory, `features-${build.name}`), build, facade, native, request)).result
          features[build.name] = { identical: comparable(result) === comparable(recorded), analysisMs: result.analysisMs, isolate: result.isolate, differences: diffKeys({ files: result.files, policies: result.policies }, { files: recorded.files, policies: recorded.policies }) }
        }
        restore('features')
        row.features = features
      }
      if (checks.has('execute')) {
        const request = json(join(recordedDirectory, 'oracle/request.json'))
        const recordedExecution = caseIdentity(json(join(recordedDirectory, 'oracle/result.json')), join(study, 'checkout'))
        const recordedCache = maskLocationDependent(comparableCache(join(recordedDirectory, 'oracle-cache')))
        const execute: Record<string, Record<string, unknown>> = {}
        const outputs = new Map<string, { cases: unknown; cache: unknown }>()
        for (const build of shuffle(builds, `${values.seed}:${entry.revision}:execute`)) {
          restore(`execute-${build.name}`)
          const target = join(directory, `execute-${build.name}`)
          const { result, timing } = await phase(target, build, facade, native, request)
          cpSync(cache, join(target, 'cache'), { recursive: true })
          const restored = restoreTree(work, frozen)
          const cacheValue = comparableCache(join(target, 'cache'))
          outputs.set(build.name, { cases: caseIdentity(result, work), cache: cacheValue })
          execute[build.name] = {
            casesIdentical: JSON.stringify(caseIdentity(result, work)) === JSON.stringify(recordedExecution),
            cacheIdentical: canonical(maskLocationDependent(cacheValue)) === canonical(recordedCache),
            cacheDifferences: diffKeys(maskLocationDependent(cacheValue), recordedCache),
            cases: result.cases.length,
            failed: result.cases.filter((t: { state: string }) => t.state === 'failed').length,
            processMs: timing.processMs,
            generated: restored.generated,
          }
        }
        restore('execute')
        const [first, ...others] = builds.map(build => outputs.get(build.name)!)
        row.executeBuildsIdentical = {
          cases: others.every(other => JSON.stringify(other.cases) === JSON.stringify(first.cases)),
          cache: others.every(other => canonical(other.cache) === canonical(first.cache)),
          cacheDifferences: others.flatMap(other => diffKeys(other.cache, first.cache)),
        }
        row.execute = execute
      }
      if (pairs > 0) {
        const request = { ...json(join(recordedDirectory, 'oracle/request.json')) }
        const arms = [...builds.map(build => ({ arm: build.name, build, instrumented: true })), ...values.stock ? [{ arm: 'stock', build: builds[0], instrumented: false }] : []]
        const timings: Record<string, unknown>[] = []
        for (let pair = 0; pair < pairs; pair++) {
          for (const arm of shuffle(arms.map(a => a.arm), `${values.seed}:${entry.revision}:bench:${pair}`).map(name => arms.find(a => a.arm === name)!)) {
            restore(`bench-${arm.arm}`)
            const { timing } = await phase(join(directory, 'bench', `${pair}-${arm.arm}`), arm.build, facade, native, { ...request, instrumented: arm.instrumented })
            timings.push({ pair, arm: arm.arm, processMs: timing.processMs, windows: timing.windows, load1Before: timing.load1Before, load1After: timing.load1After })
          }
        }
        restore('bench')
        row.bench = timings
      }
      row.status = 'completed'
    }
    catch (error) {
      row.status = 'failed'
      row.reason = String(error)
    }
    rows.push(row)
    write(join(out, 'rows.json'), rows)
    process.stdout.write(`  ${row.status}${row.reason ? `: ${row.reason}` : ''} ${JSON.stringify({ features: row.features && Object.fromEntries(Object.entries(row.features as Record<string, { identical: boolean }>).map(([k, v]) => [k, v.identical])), execute: row.execute && Object.fromEntries(Object.entries(row.execute as Record<string, { casesIdentical: boolean; cacheIdentical: boolean; processMs: number }>).map(([k, v]) => [k, [v.casesIdentical, v.cacheIdentical, Math.round(v.processMs)]])), buildsIdentical: row.executeBuildsIdentical && [(row.executeBuildsIdentical as { cases: boolean }).cases, (row.executeBuildsIdentical as { cache: boolean }).cache] })}\n`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(restoreActiveFork)
