import type { RunnerTestSuite } from 'vitest'
import type { SerializedConfig } from 'vitest/node'
import * as vitest from 'vitest'
import { prioritizeTasks } from '../../runner/src/utils/priority'

// Vitest 4.0 exports the default runner only from `vitest/runners`.
const TestRunner: typeof vitest.TestRunner = (vitest as any).TestRunner
  ?? (await import(/* @vite-ignore */ 'vitest/runners' as string)).VitestTestRunner

const PRIORITIES_KEY = '__vitestFasterPriorities'

/**
 * Applies producer scores to the tests inside a file. The fork prioritizes
 * each group of consecutive (non-)concurrent children right before running
 * it; reordering every such group before the suite starts runs the same
 * groups in the same order.
 */
export default class FasterTestRunner extends TestRunner {
  private priorities: Record<string, number> | undefined

  constructor(config: SerializedConfig) {
    super(config as any)
  }

  override onBeforeRunSuite(suite: RunnerTestSuite): unknown {
    this.priorities ??= (vitest.inject as any)(PRIORITIES_KEY) ?? {}
    if (Object.keys(this.priorities!).length) {
      let start = 0
      const tasks = suite.tasks
      while (start < tasks.length) {
        let end = start + 1
        while (end < tasks.length && tasks[end].concurrent === tasks[start].concurrent) {
          end++
        }
        const group = prioritizeTasks(tasks.slice(start, end) as any, (this as any).config.root, this.priorities)
        tasks.splice(start, group.length, ...(group as any))
        start = end
      }
    }
    return (TestRunner.prototype as any).onBeforeRunSuite?.call(this, suite)
  }
}
