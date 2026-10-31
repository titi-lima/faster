import type { RunnerTestFile } from 'vitest/node'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'pathe'

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
  private path: string | undefined
  private root = '/'

  configure(root: string, cacheDir: string | undefined): void {
    this.root = root
    this.path = cacheDir ? resolve(cacheDir, 'faster-results.json') : undefined
  }

  get(key: string): FileResult | undefined {
    return this.results.get(key)
  }

  async read(): Promise<void> {
    if (!this.path || !existsSync(this.path)) {
      return
    }
    try {
      const { version, results } = JSON.parse(await readFile(this.path, 'utf8'))
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
    if (!this.path) {
      return
    }
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, JSON.stringify({ version: VERSION, results: [...this.results] }))
  }

  async clear(): Promise<void> {
    this.results.clear()
    if (this.path) {
      await rm(this.path, { force: true })
    }
  }
}
