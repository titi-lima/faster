import type { RunnerTestSuite } from 'vitest'
import * as vitest from 'vitest'
import { prioritizeTasks } from '../../runner/src/utils/priority'

// Vitest 4.0 exports the default runner only from `vitest/runners`; the class must exist when the module loads.
// eslint-disable-next-line antfu/no-top-level-await
const legacy = (vitest as any).TestRunner ? undefined : await import(/* @vite-ignore */ 'vitest/runners' as string)
const TestRunner: typeof vitest.TestRunner = (vitest as any).TestRunner ?? legacy.VitestTestRunner

const PRIORITIES_KEY = '__vitestFasterPriorities'

/**
 * Applies producer scores to the tests inside a file. The fork prioritizes
 * each group of consecutive (non-)concurrent children right before running
 * it; reordering every such group before the suite starts runs the same
 * groups in the same order.
 */
export default class FasterTestRunner extends TestRunner {
  private priorities: Record<string, number> | undefined

  constructor(config: ConstructorParameters<typeof TestRunner>[0]) {
    super(config)
  }

  override async onBeforeRunSuite(suite: RunnerTestSuite): Promise<void> {
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
    await (TestRunner.prototype as any).onBeforeRunSuite?.call(this, suite)
  }
}
