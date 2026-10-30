import type { File } from '@vitest/runner'
import type { Vitest } from '../core'
import type { TestSpecification } from '../test-specification'
import type { TestImportCache } from './affectedTests'
import type { FunctionSnapshot } from './functionCoverage'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { slash } from '@vitest/utils/helpers'
import { dirname, relative, resolve } from 'pathe'
import { hash } from '../hash'
import { getTestDependencies } from './affectedTests'
import { collectFasterFunctionSnapshots, isFunctionDependencyAffected, isFunctionSnapshot, resetFasterFunctionCoverage } from './functionCoverage'

const STATE_VERSION = 1
const MISSING_SOURCE = '<missing>'

interface FasterSourceState {
  version: typeof STATE_VERSION
  tests: Record<string, Record<string, string>>
  functionTests?: Record<string, Record<string, FunctionSnapshot>>
}

type SourceSnapshot = Record<string, string>
export type FasterSourceSnapshots = Map<TestSpecification, SourceSnapshot>

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
    const previous = state.tests[key]
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
    const changedDependencies = (await Promise.all(changedPaths.filter(path => path !== ownPath).map(async (path) => {
      const snapshot = state.functionTests?.[getTestKey(specification)]?.[path]
      return snapshot?.sourceHash !== previous?.[path]
        || await isFunctionDependencyAffected(specification.project, path, snapshot)
    }))).filter(Boolean).length
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
    await createSnapshot(specification, state.tests[getTestKey(specification)], sources),
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
    state.tests[getTestKey(specification)] = snapshot
    state.functionTests ??= Object.create(null)
    const current = await readSnapshot(specification, Object.keys(snapshot), sources)
    state.functionTests![getTestKey(specification)] = sameSnapshot(snapshot, current)
      ? await collectFasterFunctionSnapshots(specification.project, specification.moduleId, snapshot)
      : {}
    updated = true
  }
  if (updated) {
    await writeState(statePath, state)
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
  hashes: Map<string, Promise<string>>
  relativePaths: Map<string, string>
  absolutePaths: Map<string, string>
  imports: TestImportCache
}

function createSourceCache(): SourceCache {
  return { hashes: new Map(), relativePaths: new Map(), absolutePaths: new Map(), imports: new WeakMap() }
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
  const paths = Array.from(dependencies, filepath => memoize(sources.relativePaths, `${root}\0${filepath}`, () => slash(relative(root, filepath))))
  return readSnapshot(specification, paths, sources)
}

function memoize(cache: Map<string, string>, key: string, compute: () => string): string {
  let value = cache.get(key)
  if (value === undefined) {
    value = compute()
    cache.set(key, value)
  }
  return value
}

async function readSnapshot(
  specification: TestSpecification,
  paths: string[],
  { hashes, absolutePaths }: SourceCache,
): Promise<SourceSnapshot> {
  const root = specification.project.config.root
  const snapshot: SourceSnapshot = Object.create(null)
  await Promise.all(paths.map(async (relativePath) => {
    const filepath = memoize(absolutePaths, `${root}\0${relativePath}`, () => resolve(root, relativePath))
    if (!hashes.has(filepath)) {
      hashes.set(filepath, readFile(filepath)
        .then(contents => hash('sha1', contents, 'hex'))
        .catch(() => MISSING_SOURCE))
    }
    snapshot[relativePath] = await hashes.get(filepath)!
  }))
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
  return vitest.config.cache === false ? undefined : resolve(vitest.config.cache.dir, 'faster-sources.json')
}

async function readState(filepath?: string): Promise<FasterSourceState> {
  const state: FasterSourceState = { version: STATE_VERSION, tests: Object.create(null) }
  if (!filepath) {
    return state
  }
  try {
    const parsed = JSON.parse(await readFile(filepath, 'utf8'))
    if (parsed?.version !== STATE_VERSION || !isRecord(parsed.tests)) {
      return state
    }
    for (const [key, snapshot] of Object.entries(parsed.tests)) {
      if (isRecord(snapshot) && Object.keys(snapshot).length && Object.values(snapshot).every(value => typeof value === 'string' && (value === MISSING_SOURCE || /^[a-f\d]{40}$/.test(value)))) {
        state.tests[key] = snapshot as SourceSnapshot
      }
    }
    if (isRecord(parsed.functionTests)) {
      state.functionTests = Object.create(null)
      for (const [key, snapshots] of Object.entries(parsed.functionTests)) {
        if (isRecord(snapshots)) {
          state.functionTests![key] = Object.fromEntries(Object.entries(snapshots).filter(([, value]) => isFunctionSnapshot(value))) as Record<string, FunctionSnapshot>
        }
      }
    }
  }
  catch {}
  return state
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

async function writeState(filepath: string, state: FasterSourceState): Promise<void> {
  await mkdir(dirname(filepath), { recursive: true })
  const temporaryPath = `${filepath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, JSON.stringify(state))
    await rename(temporaryPath, filepath)
  }
  finally {
    await rm(temporaryPath, { force: true })
  }
}
