import type { File } from '../shims/vitest'
import type { Vitest } from '../shims/vitest'
import type { TestSpecification } from '../shims/vitest'
import type { TestImportCache } from './affectedTests'
import type { FunctionSnapshot, StoredFunctionModel } from './functionCoverage'
import { existsSync } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { slash } from '../shims/helpers'
import { promisify } from 'node:util'
import { brotliCompress, brotliDecompress, constants as zlib } from 'node:zlib'
import { relative, resolve } from 'pathe'
import { FASTER_SOURCES_FILE, writeFasterStateFile } from '../stateFile'
import { hash } from './hash'
import { getTestDependencies } from './affectedTests'
import { collectFasterFunctionSnapshots, isFunctionDependencyAffected, resetFasterFunctionCoverage } from './functionCoverage'
import { getOrCreate } from './getOrCreate'

const STATE_VERSION = 2
const MISSING_SOURCE = '<missing>'
const compress = promisify(brotliCompress)
const decompress = promisify(brotliDecompress)

type SourceSnapshot = Record<string, string>
export type FasterSourceSnapshots = Map<TestSpecification, SourceSnapshot>

/** What a test file's last run depended on: the hash of every tracked source and, per source, the functions it saw. */
interface TestSources {
  sources: SourceSnapshot
  functions: Record<string, FunctionSnapshot>
}

/** Test files by project name, then by `<pool>:<path from the project root>`. */
interface FasterSourceState {
  tests: Map<string, Map<string, TestSources>>
}

/**
 * Selection, ordering and the pre-run snapshot only read the state, and they
 * read it within moments of each other; they share one decoded copy for as
 * long as the file stays the same. Saving reads its own copy, which it changes.
 */
const sharedStates = new Map<string, { version: string; state: Promise<FasterSourceState> }>()

/**
 * The state on disk. Test files load mostly the same modules, so every source
 * version, function model and snapshot is stored once and referenced by
 * index:
 *
 * - `files`: `[path, hash]` per source version.
 * - `models`: `[environment, shape, ids, hashes]` per function model (see
 *   `StoredFunctionModel`).
 * - `snapshots`: `[model, called]` per function snapshot.
 * - `tests`: per project and test file, the indexes of its source versions
 *   and of the snapshot of each source, -1 for none.
 */
interface StoredSourceState {
  version: typeof STATE_VERSION
  files: [string, string][]
  models: [string, string, string, string][]
  snapshots: [number, string][]
  tests: Record<string, Record<string, [number[], number[]]>>
}

export interface FasterSourceChange {
  known: boolean
  changed: boolean
  testChanged: boolean
  changedDependencies: number
}

export async function findTestsAffectedSinceLastRun(
  vitest: Vitest,
  specifications: TestSpecification[],
): Promise<Set<TestSpecification>> {
  const changes = await getTestSourceChanges(vitest, specifications)
  return new Set([...changes].filter(([, change]) => change.changed).map(([specification]) => specification))
}

export async function getTestSourceChanges(
  vitest: Vitest,
  specifications: TestSpecification[],
): Promise<Map<TestSpecification, FasterSourceChange>> {
  const state = await readSharedState(getStatePath(vitest))
  const sources = createSourceCache()
  const comparisons = await Promise.all(specifications.map(async (specification) => {
    const previous = getTest(state, specification)?.sources
    const current = previous
      ? await readSnapshot(specification, Object.keys(previous), sources)
      : undefined
    return [specification, previous, current] as const
  }))

  const changes = new Map<TestSpecification, FasterSourceChange>()
  await Promise.all(comparisons.map(async ([specification, previous, current]) => {
    const ownPath = slash(relative(specification.project.config.root, specification.moduleId))
    const changedPaths = previous && current
      ? Object.keys(previous).filter(path => previous[path] !== current[path])
      : []
    const functions = getTest(state, specification)?.functions
    const changedDependencies = (await Promise.all(changedPaths.filter(path => path !== ownPath).map(path =>
      isFunctionDependencyAffected(specification.project, path, functions?.[path]),
    ))).filter(Boolean).length
    changes.set(specification, {
      known: Boolean(previous),
      changed: changedPaths.includes(ownPath) || changedDependencies > 0,
      testChanged: changedPaths.includes(ownPath),
      changedDependencies,
    })
  }))
  return changes
}

const pendingCaptures = new WeakMap<Vitest, Promise<void>>()

/**
 * Settles once the sources of the current run are snapshotted. Workers may
 * start meanwhile, but every project module they load waits for it, so the
 * snapshot still precedes all test code.
 */
export function getPendingTestRunSourceSnapshots(vitest: Vitest): Promise<void> | undefined {
  return pendingCaptures.get(vitest)
}

export function captureTestRunSourceSnapshots(
  vitest: Vitest,
  specifications: TestSpecification[],
): Promise<FasterSourceSnapshots> {
  const capture = createTestRunSourceSnapshots(vitest, specifications)
  const settled = capture.then(() => {}, () => {})
  pendingCaptures.set(vitest, settled)
  void settled.then(() => {
    if (pendingCaptures.get(vitest) === settled) {
      pendingCaptures.delete(vitest)
    }
  })
  return capture
}

async function createTestRunSourceSnapshots(
  vitest: Vitest,
  specifications: TestSpecification[],
): Promise<FasterSourceSnapshots> {
  resetFasterFunctionCoverage(vitest)
  const eligible = specifications.filter(specification => specification.project.config.faster.enabled && specification.project.config.faster.changed)
  if (vitest.config.cache === false || !eligible.length) {
    return new Map()
  }
  const state = await readSharedState(getStatePath(vitest))
  const sources = createSourceCache()
  return new Map(await Promise.all(eligible.map(async specification => [
    specification,
    await createSnapshot(specification, getTest(state, specification)?.sources, sources),
  ] as const)))
}

export async function saveTestRunSourceSnapshots(
  vitest: Vitest,
  snapshots: FasterSourceSnapshots,
  files: File[],
): Promise<void> {
  const statePath = getStatePath(vitest)
  if (!statePath || !snapshots.size) {
    return
  }
  const executedFiles = new Set(files
    .filter(file => file.result && ['pass', 'fail', 'skip'].includes(file.result.state))
    .map(file => `${file.projectName || ''}:${file.pool || 'forks'}:${resolve(file.filepath)}`))
  const state = await readState(statePath)
  const sources = createSourceCache()
  let updated = false
  for (const [specification, snapshot] of snapshots) {
    if (!executedFiles.has(`${specification.project.name}:${specification.pool}:${resolve(specification.moduleId)}`)) {
      continue
    }
    const current = await readSnapshot(specification, Object.keys(snapshot), sources)
    const [project, file] = getTestKey(specification)
    getOrCreate(state.tests, project, () => new Map()).set(file, {
      sources: snapshot,
      functions: sameSnapshot(snapshot, current)
        ? await collectFasterFunctionSnapshots(specification.project, specification.moduleId, snapshot)
        : Object.create(null),
    })
    updated = true
  }
  if (updated) {
    forgetDeletedTests(state, snapshots.keys())
    await writeState(statePath, state)
  }
}

/**
 * Drops the history of test files that no longer exist in the projects of
 * this run, so renamed and deleted tests do not keep their sources forever.
 */
function forgetDeletedTests(state: FasterSourceState, specifications: Iterable<TestSpecification>): void {
  const roots = new Map(Array.from(specifications, specification => [specification.project.name, specification.project.config.root]))
  for (const [project, root] of roots) {
    const tests = state.tests.get(project)
    for (const file of tests?.keys() ?? []) {
      // Pool names hold no colon.
      if (!existsSync(resolve(root, file.slice(file.indexOf(':') + 1)))) {
        tests!.delete(file)
      }
    }
  }
}

export async function clearFasterSourceSnapshots(vitest: Vitest): Promise<void> {
  const statePath = getStatePath(vitest)
  if (statePath) {
    sharedStates.delete(statePath)
    await rm(statePath, { force: true })
  }
}

/**
 * Shared by all test files of one pass over the sources, so each source is
 * read, hashed and resolved once instead of once per test file.
 */
interface SourceCache {
  /** Hash of each source by absolute path, once read. */
  hashes: Map<string, string>
  pending: Map<string, Promise<void>>
  /** Per project root, the relative path of each absolute path, and the reverse. */
  relativePaths: Map<string, Map<string, string>>
  absolutePaths: Map<string, Map<string, string>>
  imports: TestImportCache
}

function createSourceCache(): SourceCache {
  return { hashes: new Map(), pending: new Map(), relativePaths: new Map(), absolutePaths: new Map(), imports: new WeakMap() }
}

async function createSnapshot(
  specification: TestSpecification,
  previous: SourceSnapshot | undefined,
  sources: SourceCache,
): Promise<SourceSnapshot> {
  let dependencies: Set<string>
  try {
    dependencies = await getTestDependencies(specification, new Set(), sources.imports)
  }
  catch {
    // A broken transform should not prevent the test run. Keep tracking the
    // last known graph so changes can still be detected while it is broken.
    dependencies = new Set(Object.keys(previous || {}).map(path => resolve(specification.project.config.root, path)))
  }
  dependencies.add(specification.moduleId)

  const root = specification.project.config.root
  const relativePaths = getOrCreate(sources.relativePaths, root, () => new Map())
  const paths = Array.from(dependencies, filepath => getOrCreate(relativePaths, filepath, () => slash(relative(root, filepath))))
  return readSnapshot(specification, paths, sources)
}

/**
 * Hashes the given sources of a test file. Each source is read once per
 * cache, and the snapshot is built once all of them are known, so a source
 * shared by every test file costs one read, not one wait per test file.
 */
async function readSnapshot(
  specification: TestSpecification,
  paths: string[],
  sources: SourceCache,
): Promise<SourceSnapshot> {
  const root = specification.project.config.root
  const absolutePaths = getOrCreate(sources.absolutePaths, root, () => new Map())
  const filepaths = paths.map(relativePath => getOrCreate(absolutePaths, relativePath, () => resolve(root, relativePath)))
  const reads: Promise<void>[] = []
  for (const filepath of filepaths) {
    if (!sources.hashes.has(filepath)) {
      let read = sources.pending.get(filepath)
      if (!read) {
        read = readFile(filepath)
          .then(contents => hash('sha1', contents, 'hex'))
          .catch(() => MISSING_SOURCE)
          .then((digest) => {
            sources.hashes.set(filepath, digest)
          })
        sources.pending.set(filepath, read)
      }
      reads.push(read)
    }
  }
  await Promise.all(reads)
  const snapshot: SourceSnapshot = Object.create(null)
  for (let index = 0; index < paths.length; index++) {
    snapshot[paths[index]] = sources.hashes.get(filepaths[index])!
  }
  return snapshot
}

function sameSnapshot(previous: SourceSnapshot, current: SourceSnapshot): boolean {
  const previousPaths = Object.keys(previous)
  const currentPaths = Object.keys(current)
  return previousPaths.length === currentPaths.length
    && previousPaths.every(path => Object.hasOwn(current, path) && previous[path] === current[path])
}

/** The project of a test file and its key within the project. */
function getTestKey(specification: TestSpecification): [string, string] {
  const filepath = slash(relative(specification.project.config.root, specification.moduleId))
  return [specification.project.name, `${specification.pool}:${filepath}`]
}

function getTest(state: FasterSourceState, specification: TestSpecification): TestSources | undefined {
  const [project, file] = getTestKey(specification)
  return state.tests.get(project)?.get(file)
}

function getStatePath(vitest: Vitest): string | undefined {
  return vitest.config.cache === false ? undefined : resolve(vitest.config.cache.dir, FASTER_SOURCES_FILE)
}

async function readSharedState(filepath?: string): Promise<FasterSourceState> {
  if (!filepath) {
    return emptyState()
  }
  const stats = await stat(filepath).catch(() => undefined)
  const version = stats ? `${stats.ino}:${stats.size}:${stats.mtimeMs}` : ''
  let shared = sharedStates.get(filepath)
  if (shared?.version !== version) {
    shared = { version, state: readState(filepath) }
    sharedStates.set(filepath, shared)
  }
  return shared.state
}

async function readState(filepath?: string): Promise<FasterSourceState> {
  try {
    return filepath ? decodeState(JSON.parse((await decompress(await readFile(filepath))).toString('utf8'))) : emptyState()
  }
  catch {
    return emptyState()
  }
}

function emptyState(): FasterSourceState {
  return { tests: new Map() }
}

/**
 * Indexes that point nowhere throw, which discards the whole history as a
 * version change does. Other damage only makes FASTER run more: a hash that
 * matches no source, or a model that cannot be decoded, counts as a change.
 */
function decodeState(stored: StoredSourceState): FasterSourceState {
  if (stored?.version !== STATE_VERSION) {
    return emptyState()
  }
  const models = stored.models.map(([environment, shape, ids, hashes]): StoredFunctionModel => ({ environment, shape, ids, hashes }))
  const snapshots = stored.snapshots.map(([model, called]): FunctionSnapshot => ({ model: models[model], called }))
  const state = emptyState()
  for (const [project, files] of Object.entries(stored.tests)) {
    const tests = new Map<string, TestSources>()
    for (const [file, [fileIndexes, snapshotIndexes]] of Object.entries(files)) {
      const test: TestSources = { sources: Object.create(null), functions: Object.create(null) }
      fileIndexes.forEach((fileIndex, position) => {
        const [path, sourceHash] = stored.files[fileIndex]
        test.sources[path] = sourceHash
        const snapshot = snapshots[snapshotIndexes[position]]
        if (snapshot) {
          test.functions[path] = snapshot
        }
      })
      if (fileIndexes.length) {
        tests.set(file, test)
      }
    }
    state.tests.set(project, tests)
  }
  return state
}

function encodeState(state: FasterSourceState): StoredSourceState {
  const stored: StoredSourceState = { version: STATE_VERSION, files: [], models: [], snapshots: [], tests: {} }
  const files = new Map<string, Map<string, number>>()
  // Models and snapshots are shared objects, so each is looked up by identity before its content.
  const models = new Map<StoredFunctionModel, number>()
  const modelsByContent = new Map<string, number>()
  const snapshots = new Map<FunctionSnapshot, number>()
  const snapshotsByContent = new Map<string, number>()
  const modelIndex = ({ environment, shape, ids, hashes }: StoredFunctionModel) =>
    getOrCreate(modelsByContent, `${environment}\n${shape}\n${ids}\n${hashes}`, () => stored.models.push([environment, shape, ids, hashes]) - 1)
  const snapshotIndex = (snapshot: FunctionSnapshot) => getOrCreate(snapshots, snapshot, () => {
    const model = getOrCreate(models, snapshot.model, () => modelIndex(snapshot.model))
    return getOrCreate(snapshotsByContent, `${model}:${snapshot.called}`, () => stored.snapshots.push([model, snapshot.called]) - 1)
  })
  for (const [project, tests] of state.tests) {
    if (!tests.size) {
      continue
    }
    const entries: Record<string, [number[], number[]]> = stored.tests[project] = {}
    for (const [file, test] of tests) {
      const fileIndexes: number[] = []
      const snapshotIndexes: number[] = []
      for (const [path, sourceHash] of Object.entries(test.sources)) {
        fileIndexes.push(getOrCreate(getOrCreate(files, path, () => new Map()), sourceHash, () => stored.files.push([path, sourceHash]) - 1))
        const snapshot = test.functions[path]
        snapshotIndexes.push(snapshot ? snapshotIndex(snapshot) : -1)
      }
      entries[file] = [fileIndexes, snapshotIndexes]
    }
  }
  return stored
}

async function writeState(filepath: string, state: FasterSourceState): Promise<void> {
  sharedStates.delete(filepath)
  const contents = Buffer.from(JSON.stringify(encodeState(state)))
  await writeFasterStateFile(filepath, await compress(contents, {
    params: { [zlib.BROTLI_PARAM_QUALITY]: 3, [zlib.BROTLI_PARAM_SIZE_HINT]: contents.length },
  }))
}
