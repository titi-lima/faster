import type { RunnerTestFile } from 'vitest/node'
import type { FasterStateFile } from '../../vitest/src/node/faster/stateFile'
import { relative } from 'pathe'
import { clearFasterStateFile, readFasterStateFile, resolveFasterStateFile, writeFasterStateFile } from '../../vitest/src/node/faster/stateFile'

export interface FileResult {
  failed: boolean
  duration: number
}

const VERSION = 'vitest-faster-1'

/**
 * The per-file history the fork reads from Vitest 4.1's results cache.
 * Vitest 5 records history with different rules (partial runs, cancelled
 * runs), so FASTER keeps its own copy with the 4.1 rules on every host.
 */
export class FasterResults {
  private results = new Map<string, FileResult>()
  private file: FasterStateFile | undefined
  private root = '/'

  configure(root: string, cacheDir: string | undefined): void {
    this.root = root
    this.file = cacheDir ? resolveFasterStateFile(root, cacheDir, 'faster-results.json') : undefined
  }

  get(key: string): FileResult | undefined {
    return this.results.get(key)
  }

  async read(): Promise<void> {
    const contents = this.file && await readFasterStateFile(this.file)
    if (!contents) {
      return
    }
    try {
      const { version, results } = JSON.parse(contents)
      if (version === VERSION && Array.isArray(results)) {
        this.results = new Map(results)
      }
    }
    catch {}
  }

  update(files: RunnerTestFile[]): void {
    for (const file of files) {
      const result = file.result
      if (!result) {
        continue
      }
      const duration = result.duration || 0
      this.results.set(`${file.projectName || ''}:${relative(this.root, file.filepath)}`, {
        duration: duration >= 0 ? duration : 0,
        failed: result.state === 'fail',
      })
    }
  }

  remove(filepath: string): void {
    for (const key of this.results.keys()) {
      if (key.endsWith(filepath)) {
        this.results.delete(key)
      }
    }
  }

  async write(): Promise<void> {
    if (this.file) {
      await writeFasterStateFile(this.file.path, JSON.stringify({ version: VERSION, results: [...this.results] }))
    }
  }

  async clear(): Promise<void> {
    this.results.clear()
    if (this.file) {
      await clearFasterStateFile(this.file, JSON.stringify({ version: VERSION, results: [] }))
    }
  }
}
