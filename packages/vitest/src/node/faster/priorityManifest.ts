import type { TestPriorityMap } from '@vitest/runner/utils'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'pathe'

export const FASTER_PRIORITY_SCHEMA_VERSION = 1

export interface FasterPriorityRecord {
  score: number
  signals?: Record<string, number>
}

export interface FasterPriorityManifest {
  schemaVersion: typeof FASTER_PRIORITY_SCHEMA_VERSION
  tests: Record<string, number | FasterPriorityRecord>
}

export interface FasterOptions {
  enabled?: boolean
  /**
   * In APFD mode, prioritize cached failures, edited/new tests, then affected
   * tests, using prior duration and source breadth before FAST tie-breaking.
   * This is a heuristic, not a guarantee of optimal APFD.
   *
   * @default 'dx'
   */
  optimizeFor?: 'dx' | 'apfd'
  /**
   * Put tests affected by source changes since the previous completed test run
   * ahead of the remaining suite. A string also includes changes since that
   * Git revision.
   *
   * @default true
   */
  changed?: boolean | string
  /** Use per-test V8 function coverage to refine affected dependencies. */
  granularity?: 'file' | 'function'
  /** Run only changed, unknown, affected or previously failing test files. */
  selectAffected?: boolean
  /**
   * Optional producer scores within each scheduling bucket. Equal scores and
   * unscored files use the selected objective, with FAST breaking remaining ties.
   */
  priorityFile?: string
  immediateFailureOutput?: boolean
}

export interface ResolvedFasterOptions {
  enabled: boolean
  optimizeFor: 'dx' | 'apfd'
  changed: boolean | string
  granularity: 'file' | 'function'
  selectAffected: boolean
  priorityFile: string
  immediateFailureOutput: boolean
  priorities: TestPriorityMap
}

export function resolveFasterOptions(
  root: string,
  options: boolean | FasterOptions | undefined,
): ResolvedFasterOptions {
  const normalized = typeof options === 'object' ? options : {}
  const optimizeFor = normalized.optimizeFor ?? 'dx'
  const granularity = normalized.granularity ?? 'file'
  if (granularity !== 'file' && granularity !== 'function') {
    throw new TypeError(`Invalid faster.granularity: expected "file" or "function", received "${granularity}".`)
  }
  if (normalized.selectAffected && normalized.changed === false) {
    throw new TypeError('faster.selectAffected requires faster.changed to be enabled.')
  }
  if (optimizeFor !== 'dx' && optimizeFor !== 'apfd') {
    throw new TypeError(`Invalid faster.optimizeFor: expected "dx" or "apfd", received "${optimizeFor}".`)
  }
  const enabled = typeof options === 'boolean'
    ? options
    : normalized.enabled ?? true
  const priorityFile = resolve(
    root,
    normalized.priorityFile ?? '.faster/priorities.json',
  )

  return {
    enabled,
    optimizeFor,
    changed: normalized.changed ?? true,
    granularity,
    selectAffected: normalized.selectAffected ?? false,
    priorityFile,
    immediateFailureOutput: normalized.immediateFailureOutput ?? true,
    priorities: enabled ? loadPriorityManifest(priorityFile) : {},
  }
}

export function loadPriorityManifest(filepath: string): TestPriorityMap {
  if (!existsSync(filepath)) {
    return {}
  }

  let manifest: FasterPriorityManifest
  try {
    manifest = JSON.parse(readFileSync(filepath, 'utf8'))
  }
  catch (error) {
    throw new Error(`Cannot read Faster priority manifest at ${filepath}.`, {
      cause: error,
    })
  }

  if (manifest.schemaVersion !== FASTER_PRIORITY_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Faster priority manifest schema at ${filepath}: expected ${FASTER_PRIORITY_SCHEMA_VERSION}.`,
    )
  }
  if (!manifest.tests || typeof manifest.tests !== 'object' || Array.isArray(manifest.tests)) {
    throw new TypeError(`Invalid Faster priority manifest at ${filepath}: "tests" must be an object.`)
  }

  return Object.fromEntries(
    Object.entries(manifest.tests).map(([testId, record]) => {
      const score = typeof record === 'number' ? record : record?.score
      if (!Number.isFinite(score)) {
        throw new TypeError(
          `Invalid Faster score for "${testId}" at ${filepath}: expected a finite number.`,
        )
      }
      return [testId, score]
    }),
  )
}
