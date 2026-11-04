import type { RunnerTask } from 'vitest'
import type { RunnerTestFile } from 'vitest/node'
import type { ObservedEscape } from './escapeRecord'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'pathe'
import { GitVCSProvider } from './decision/git'
import { hash } from './decision/hash'
import { ESCAPES_META_KEY, TRUNCATED } from './escapeRecord'
import { FasterStateStore, fileKey } from './stateFile'

/**
 * `strict` runs every test file whose last run left its worker; `fast` trusts
 * the import graph for those files; `off` neither records nor selects by
 * escapes. The `auto` option resolves to `strict` on CI and `fast` elsewhere.
 */
export type FasterSafety = 'strict' | 'fast' | 'off'

export interface EscapeRecord {
  /** Escapes whose target FASTER cannot hash: processes, network, threads, native addons, reads past the recording limit. */
  opaque: ObservedEscape[]
  /** Repository files the test read or checked through `fs`, by path relative to the root, with their SHA-1. */
  reads: Record<string, string>
}

const MISSING = 'missing'
/** Recorded for a file whose content changed while the run read it, so the next run selects the test. */
const CHANGED_DURING_RUN = 'changed during run'

/**
 * What each test file depended on outside its worker in the run that last
 * executed it. Reads are hashed, so a test that reads a changed file is
 * selected like an affected one; opaque escapes select the file only in
 * strict mode.
 */
export class FasterEscapes extends FasterStateStore<EscapeRecord> {
  /** Reads outside the Git repository (or the root, without one) are not tracked. */
  private boundary: Promise<string> | undefined
  /** Hashes of the recorded reads of the files about to run, taken before any of them starts. */
  private before: Map<string, Promise<string>> | undefined

  constructor() {
    super('faster-escapes.json', 'vitest-faster-escapes-1', 'tests')
  }

  /** Hashes what the given files read in their last run, before this run can change it. */
  async capture(keys: string[]): Promise<void> {
    const before = new Map<string, Promise<string>>()
    this.before = before
    await Promise.all(keys.flatMap(key => Object.keys(this.records.get(key)?.reads ?? {})
      .map(path => hashFile(before, resolve(this.root, path)))))
  }

  /**
   * Records the escapes of every file of the run that sent them; other files
   * keep their last record. A file that did not run all its tests (a name
   * filter, `.only`, skipped tests) adds to its record instead of replacing it.
   */
  async update(files: RunnerTestFile[]): Promise<void> {
    this.boundary ??= new GitVCSProvider().getRoot(this.root).then(root => root ?? this.root)
    const boundary = await this.boundary
    const before = this.before ?? new Map<string, Promise<string>>()
    this.before = undefined
    const hashes = new Map<string, Promise<string>>()
    await Promise.all(files.map(async (file) => {
      const observed: ObservedEscape[] | undefined = (file.meta as any)?.[ESCAPES_META_KEY]
      if (!observed || !file.result || !['pass', 'fail', 'skip'].includes(file.result.state)) {
        return
      }
      const opaque = observed.filter(escape => escape.kind !== 'file' || escape.target === TRUNCATED)
      const paths = observed
        .filter(escape => escape.kind === 'file' && escape.target !== TRUNCATED && escape.target !== file.filepath && isInside(boundary, escape.target))
        .map(escape => escape.target)
      const reads: Record<string, string> = {}
      await Promise.all(paths.map(async (path) => {
        const after = await hashFile(hashes, path)
        const previous = await before.get(path)
        reads[relative(this.root, path)] = previous === undefined || previous === after ? after : CHANGED_DURING_RUN
      }))
      const key = fileKey(this.root, file.projectName, file.filepath)
      const last = this.records.get(key)
      this.records.set(key, last && !ranEveryTest(file)
        ? { opaque: unique([...last.opaque, ...opaque]), reads: { ...last.reads, ...reads } }
        : { opaque, reads })
    }))
  }

  /** Keys of the recorded files that read a file whose content changed since. */
  async changedReads(keys: string[]): Promise<Set<string>> {
    const hashes = new Map<string, Promise<string>>()
    const changed = new Set<string>()
    await Promise.all(keys.map(async (key) => {
      const reads = Object.entries(this.records.get(key)?.reads ?? {})
      const current = await Promise.all(reads.map(([path]) => hashFile(hashes, resolve(this.root, path))))
      if (reads.some(([, hash], index) => current[index] !== hash)) {
        changed.add(key)
      }
    }))
    return changed
  }
}

export function resolveSafety(value: unknown, ci: boolean): FasterSafety {
  if (value === 'strict' || value === 'fast' || value === 'off') {
    return value
  }
  if (value == null || value === 'auto') {
    return ci ? 'strict' : 'fast'
  }
  throw new TypeError(`Invalid faster.safety: expected "auto", "strict", "fast" or "off", received "${String(value)}".`)
}

/** Hashes a file's contents, or a directory's sorted entry names for reads through `readdir`. */
function hashFile(hashes: Map<string, Promise<string>>, path: string): Promise<string> {
  let digest = hashes.get(path)
  if (!digest) {
    digest = readFile(path)
      .catch(async (error) => {
        if (error?.code !== 'EISDIR') {
          throw error
        }
        return (await readdir(path)).sort().join('\n')
      })
      .then(contents => hash('sha1', contents, 'hex'), () => MISSING)
    hashes.set(path, digest)
  }
  return digest
}

function ranEveryTest(task: RunnerTask): boolean {
  return 'tasks' in task
    ? task.tasks.every(ranEveryTest)
    : task.result?.state === 'pass' || task.result?.state === 'fail'
}

function unique(escapes: ObservedEscape[]): ObservedEscape[] {
  return [...new Map(escapes.map(escape => [`${escape.kind}\t${escape.target}`, escape])).values()]
}

function isInside(directory: string, path: string): boolean {
  const inside = relative(directory, path)
  return Boolean(inside) && inside !== '..' && !inside.startsWith('../') && !isAbsolute(inside)
}
