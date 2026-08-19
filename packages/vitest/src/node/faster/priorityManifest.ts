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
   * Put tests affected by local source changes ahead of the remaining suite.
   * A string is treated as a Git revision and includes committed changes since it.
   *
   * @default true
   */
  changed?: boolean | string
  priorityFile?: string
  immediateFailureOutput?: boolean
}

export interface ResolvedFasterOptions {
  enabled: boolean
  changed: boolean | string
  priorityFile: string
  immediateFailureOutput: boolean
  priorities: TestPriorityMap
}

export function resolveFasterOptions(
  root: string,
  options: boolean | FasterOptions | undefined,
): ResolvedFasterOptions {
  const normalized = typeof options === 'object' ? options : {}
  const enabled = typeof options === 'boolean'
    ? options
    : normalized.enabled ?? true
  const priorityFile = resolve(
    root,
    normalized.priorityFile ?? '.faster/priorities.json',
  )

  return {
    enabled,
    changed: normalized.changed ?? true,
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
