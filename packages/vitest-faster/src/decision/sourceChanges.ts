import type { File } from '../shims/vitest'
import type { Vitest } from '../shims/vitest'
import type { TestSpecification } from '../shims/vitest'
import type { TestImportCache } from './affectedTests'
import type { FunctionSnapshot, StoredFunctionModel } from './functionCoverage'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { slash } from '../shims/helpers'
import { promisify } from 'node:util'
import { brotliCompress, brotliDecompress, constants as zlib } from 'node:zlib'
import { dirname, relative, resolve } from 'pathe'
import { hash } from './hash'
import { getTestDependencies } from './affectedTests'
import { collectFasterFunctionSnapshots, FUNCTION_HASH_LENGTH, isFunctionDependencyAffected, resetFasterFunctionCoverage } from './functionCoverage'

const STATE_VERSION = 2
const STATE_FILE = 'faster-sources.json.br'
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

interface FasterSourceState {
  tests: Record<string, TestSources>
}

/**
 * The state on disk. Test files load mostly the same modules, so every source
 * version, function model and snapshot is stored once and referenced by
 * index:
 *
 * - `files`: `[path, hash]` per source version.
 * - `models`: `[environment, shape, ids, hashes]` per function model, with
 *   the ids front-coded (see `encodeIds`) and the hashes concatenated.
 * - `snapshots`: `[model, called]` per function snapshot.
 * - `tests`: per test file, the indexes of its source versions and, when it
 *   recorded functions, the index of the snapshot of each source (-1 for none).
 */
interface StoredSourceState {
  version: typeof STATE_VERSION
  files: [string, string][]
  models: [string, string, string, string][]
  snapshots: [number, string][]
  tests: Record<string, [number[]] | [number[], number[]]>
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
  const state = await readState(getStatePath(vitest))
  const sources = createSourceCache()
  const comparisons = await Promise.all(specifications.map(async (specification) => {
    const key = getTestKey(specification)
    const previous = state.tests[key]?.sources
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
    const functions = state.tests[getTestKey(specification)]?.functions
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
  const state = await readState(getStatePath(vitest))
  const sources = createSourceCache()
  return new Map(await Promise.all(eligible.map(async specification => [
    specification,
    await createSnapshot(specification, state.tests[getTestKey(specification)]?.sources, sources),
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
    state.tests[getTestKey(specification)] = {
      sources: snapshot,
      functions: sameSnapshot(snapshot, current)
        ? await collectFasterFunctionSnapshots(specification.project, specification.moduleId, snapshot)
        : Object.create(null),
    }
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
  const projects = new Map<string, string>()
  for (const specification of specifications) {
    projects.set(`${specification.project.name}:`, specification.project.config.root)
  }
  // A project named `a` must not claim the keys of a project named `a:b`.
  const roots = [...projects].sort(([left], [right]) => right.length - left.length)
  for (const key of Object.keys(state.tests)) {
    for (const [prefix, root] of roots) {
      // Keys are `<project>:<pool>:<path>`; pool names hold no colon.
      const rest = key.startsWith(prefix) ? key.slice(prefix.length) : ''
      const separator = rest.indexOf(':')
      if (separator > 0 && !existsSync(resolve(root, rest.slice(separator + 1)))) {
        delete state.tests[key]
        break
      }
    }
  }
}

export async function clearFasterSourceSnapshots(vitest: Vitest): Promise<void> {
  const statePath = getStatePath(vitest)
  if (statePath) {
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
  const relativePaths = memoizeByRoot(sources.relativePaths, root)
  const paths = Array.from(dependencies, filepath => memoize(relativePaths, filepath, () => slash(relative(root, filepath))))
  return readSnapshot(specification, paths, sources)
}

function memoizeByRoot(cache: Map<string, Map<string, string>>, root: string): Map<string, string> {
  let paths = cache.get(root)
  if (!paths) {
    paths = new Map()
    cache.set(root, paths)
  }
  return paths
}

function memoize(cache: Map<string, string>, key: string, compute: () => string): string {
  let value = cache.get(key)
  if (value === undefined) {
    value = compute()
    cache.set(key, value)
  }
  return value
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
  const absolutePaths = memoizeByRoot(sources.absolutePaths, root)
  const filepaths = paths.map(relativePath => memoize(absolutePaths, relativePath, () => resolve(root, relativePath)))
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

function getTestKey(specification: TestSpecification): string {
  const filepath = slash(relative(specification.project.config.root, specification.moduleId))
  return `${specification.project.name}:${specification.pool}:${filepath}`
}

function getStatePath(vitest: Vitest): string | undefined {
  return vitest.config.cache === false ? undefined : resolve(vitest.config.cache.dir, STATE_FILE)
}

async function readState(filepath?: string): Promise<FasterSourceState> {
  const empty: FasterSourceState = { tests: Object.create(null) }
  if (!filepath) {
    return empty
  }
  try {
    return decodeState(JSON.parse((await decompress(await readFile(filepath))).toString('utf8'))) ?? empty
  }
  catch {
    return empty
  }
}

const HASH = /^[a-f\d]{40}$/
const FUNCTION_HASH = new RegExp(`^[\\w-]{${FUNCTION_HASH_LENGTH}}$`)
const FUNCTION_HASHES = /^[\w-]*$/
const CALLS = /^[01-]*$/

/** The stored `[ids, hashes]` of each model read from disk, written back as they are. */
const encodedModels = new WeakMap<StoredFunctionModel, [string, string]>()

/** Reads the stored state; anything malformed discards the whole history, as a version change does. */
function decodeState(stored: any): FasterSourceState | undefined {
  if (stored?.version !== STATE_VERSION || ![stored.files, stored.models, stored.snapshots].every(Array.isArray) || !isRecord(stored.tests)) {
    return undefined
  }
  const files: [string, string][] = stored.files
  if (!files.every(file => Array.isArray(file) && typeof file[0] === 'string' && typeof file[1] === 'string' && (file[1] === MISSING_SOURCE || HASH.test(file[1])))) {
    return undefined
  }
  const models: StoredFunctionModel[] = []
  for (const entry of stored.models) {
    const model = Array.isArray(entry) && entry.every(value => typeof value === 'string') ? decodeModel(entry as [string, string, string, string]) : undefined
    if (!model) {
      return undefined
    }
    models.push(model)
  }
  const snapshots: FunctionSnapshot[] = []
  for (const entry of stored.snapshots) {
    const model = Array.isArray(entry) ? models[entry[0]] : undefined
    if (!model || typeof entry[1] !== 'string' || entry[1].length * FUNCTION_HASH_LENGTH !== encodedModels.get(model)![1].length || !CALLS.test(entry[1])) {
      return undefined
    }
    snapshots.push({ model, called: entry[1] })
  }
  const state: FasterSourceState = { tests: Object.create(null) }
  for (const [key, entry] of Object.entries(stored.tests)) {
    const [fileIndexes, snapshotIndexes] = Array.isArray(entry) ? entry : []
    if (!Array.isArray(fileIndexes) || !fileIndexes.length || (snapshotIndexes !== undefined && (!Array.isArray(snapshotIndexes) || snapshotIndexes.length !== fileIndexes.length))) {
      return undefined
    }
    const test: TestSources = { sources: Object.create(null), functions: Object.create(null) }
    for (let position = 0; position < fileIndexes.length; position++) {
      const file = files[fileIndexes[position]]
      if (!file) {
        return undefined
      }
      test.sources[file[0]] = file[1]
      const snapshotIndex = snapshotIndexes?.[position] ?? -1
      if (snapshotIndex !== -1) {
        const snapshot = snapshots[snapshotIndex]
        if (!snapshot) {
          return undefined
        }
        test.functions[file[0]] = snapshot
      }
    }
    state.tests[key] = test
  }
  return state
}

/**
 * Most models are never compared, since few sources change between runs, so
 * their ids and hashes are decoded on first use. A model whose ids do not
 * decode throws there, which counts its source as affected.
 */
function decodeModel([environment, shape, ids, hashes]: [string, string, string, string]): StoredFunctionModel | undefined {
  if (!FUNCTION_HASH.test(shape) || hashes.length % FUNCTION_HASH_LENGTH || !FUNCTION_HASHES.test(hashes)) {
    return undefined
  }
  let decoded: { ids: string[]; hashes: string[] } | undefined
  const decode = () => {
    if (!decoded) {
      const count = hashes.length / FUNCTION_HASH_LENGTH
      const decodedIds = decodeIds(ids)
      if (decodedIds?.length !== count) {
        throw new Error('Malformed function model')
      }
      decoded = { ids: decodedIds, hashes: Array.from({ length: count }, (_, index) => hashes.slice(index * FUNCTION_HASH_LENGTH, (index + 1) * FUNCTION_HASH_LENGTH)) }
    }
    return decoded
  }
  const model: StoredFunctionModel = {
    environment,
    shape,
    get ids() {
      return decode().ids
    },
    get hashes() {
      return decode().hashes
    },
  }
  encodedModels.set(model, [ids, hashes])
  return model
}

function encodeState(state: FasterSourceState): StoredSourceState {
  const stored: StoredSourceState = { version: STATE_VERSION, files: [], models: [], snapshots: [], tests: Object.create(null) }
  const files = new Map<string, number>()
  const models = new Map<StoredFunctionModel, number>()
  const modelsByContent = new Map<string, number>()
  const snapshots = new Map<FunctionSnapshot, number>()
  const snapshotsByContent = new Map<string, number>()
  const intern = <T>(map: Map<T, number>, key: T, add: () => number): number => {
    let index = map.get(key)
    if (index === undefined) {
      index = add()
      map.set(key, index)
    }
    return index
  }
  const modelIndex = (model: StoredFunctionModel) => intern(models, model, () => {
    const [ids, hashes] = encodedModels.get(model) ?? [encodeIds(model.ids), model.hashes.join('')]
    return intern(modelsByContent, `${model.environment}\n${model.shape}\n${ids}\n${hashes}`, () => stored.models.push([model.environment, model.shape, ids, hashes]) - 1)
  })
  const snapshotIndex = (snapshot: FunctionSnapshot) => intern(snapshots, snapshot, () => {
    const model = modelIndex(snapshot.model)
    return intern(snapshotsByContent, `${model}:${snapshot.called}`, () => stored.snapshots.push([model, snapshot.called]) - 1)
  })
  for (const [key, test] of Object.entries(state.tests)) {
    const fileIndexes: number[] = []
    const snapshotIndexes: number[] = []
    let functions = false
    for (const [path, sourceHash] of Object.entries(test.sources)) {
      fileIndexes.push(intern(files, `${sourceHash}\n${path}`, () => stored.files.push([path, sourceHash]) - 1))
      const snapshot = test.functions[path]
      snapshotIndexes.push(snapshot ? snapshotIndex(snapshot) : -1)
      functions ||= Boolean(snapshot)
    }
    stored.tests[key] = functions ? [fileIndexes, snapshotIndexes] : [fileIndexes]
  }
  return stored
}

/**
 * Function ids are paths in the syntax tree listed in visiting order, so each
 * shares a long prefix with the one before. Each id is stored as the length
 * of that prefix in base 36, a colon and the rest, separated by spaces; ids
 * hold neither character.
 */
function encodeIds(ids: readonly string[]): string {
  let previous = ''
  return ids.map((id) => {
    let shared = 0
    const limit = Math.min(id.length, previous.length)
    while (shared < limit && id.charCodeAt(shared) === previous.charCodeAt(shared)) {
      shared++
    }
    previous = id
    return `${shared.toString(36)}:${id.slice(shared)}`
  }).join(' ')
}

function decodeIds(encoded: string): string[] | undefined {
  if (!encoded) {
    return []
  }
  let previous = ''
  const ids: string[] = []
  for (const entry of encoded.split(' ')) {
    const separator = entry.indexOf(':')
    const shared = Number.parseInt(entry.slice(0, separator), 36)
    if (separator < 1 || !(shared <= previous.length)) {
      return undefined
    }
    previous = previous.slice(0, shared) + entry.slice(separator + 1)
    ids.push(previous)
  }
  return ids
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

async function writeState(filepath: string, state: FasterSourceState): Promise<void> {
  await mkdir(dirname(filepath), { recursive: true })
  const temporaryPath = `${filepath}.${process.pid}.${randomUUID()}.tmp`
  try {
    const contents = Buffer.from(JSON.stringify(encodeState(state)))
    await writeFile(temporaryPath, await compress(contents, {
      params: { [zlib.BROTLI_PARAM_QUALITY]: 3, [zlib.BROTLI_PARAM_SIZE_HINT]: contents.length },
    }))
    await rename(temporaryPath, filepath)
  }
  finally {
    await rm(temporaryPath, { force: true })
  }
}
