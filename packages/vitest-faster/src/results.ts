import type { RunnerTestFile } from 'vitest/node'
import { FasterStateStore, fileKey } from './stateFile'

export interface FileResult {
  failed: boolean
  duration: number
}

/**
 * The per-file history the fork reads from Vitest 4.1's results cache.
 * Vitest 5 records history with different rules (partial runs, cancelled
 * runs), so FASTER keeps its own copy with the 4.1 rules on every host.
 */
export class FasterResults extends FasterStateStore<FileResult> {
  constructor() {
    super('faster-results.json', 'vitest-faster-1', 'results')
  }

  update(files: RunnerTestFile[]): void {
    for (const file of files) {
      const result = file.result
      if (!result) {
        continue
      }
      const duration = result.duration || 0
      this.records.set(fileKey(this.root, file.projectName, file.filepath), {
        duration: duration >= 0 ? duration : 0,
        failed: result.state === 'fail',
      })
    }
  }
}
