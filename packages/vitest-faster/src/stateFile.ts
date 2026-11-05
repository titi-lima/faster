import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'pathe'

/** Each test file's sources and the functions it called, written by `decision/sourceChanges.ts`. */
export const FASTER_SOURCES_FILE = 'faster-sources.json.br'
export const FASTER_STATE_FILES = [FASTER_SOURCES_FILE, 'faster-results.json', 'faster-escapes.json']

export interface FasterStateDir {
  dir: string
  seedDirs: string[]
}

export function resolveFasterStateDir(root: string, cacheDir: string): FasterStateDir {
  const cacheInRoot = relative(root, cacheDir)
  const outsideRoot = cacheInRoot === '..' || cacheInRoot.startsWith('../') || isAbsolute(cacheInRoot)
  const gitDir = outsideRoot ? undefined : resolveGitDir(root)
  if (!gitDir) {
    return { dir: cacheDir, seedDirs: [] }
  }
  const dir = join(gitDir, 'faster', cacheInRoot)
  const shared = join(readCommonDir(gitDir), 'faster', cacheInRoot)
  return { dir, seedDirs: shared === dir ? [cacheDir] : [cacheDir, shared] }
}

function resolveGitDir(root: string): string | undefined {
  const dotGit = join(root, '.git')
  try {
    if (statSync(dotGit).isDirectory()) {
      return dotGit
    }
    const gitFile = readFileSync(dotGit, 'utf8').trim()
    const gitDir = gitFile.startsWith('gitdir:') ? resolve(root, gitFile.slice('gitdir:'.length).trim()) : undefined
    return gitDir && statSync(gitDir, { throwIfNoEntry: false })?.isDirectory() ? gitDir : undefined
  }
  catch {
    return undefined
  }
}

function readCommonDir(gitDir: string): string {
  try {
    return resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim())
  }
  catch {
    return gitDir
  }
}

export async function seedFasterStateDir({ dir, seedDirs }: FasterStateDir): Promise<void> {
  await Promise.all(FASTER_STATE_FILES.map(async (name) => {
    if (existsSync(join(dir, name))) {
      return
    }
    for (const seedDir of seedDirs) {
      const contents = await readFile(join(seedDir, name)).catch(() => undefined)
      if (contents?.length) {
        await writeFasterStateFile(join(dir, name), contents).catch(() => {})
        return
      }
    }
  }))
}

/** Deletes the uncompressed source history of earlier versions, up to 90 MB, which nothing reads any more. */
export async function removeLegacyFasterState(directories: string[]): Promise<void> {
  await Promise.all(directories.map(directory => rm(join(directory, 'faster-sources.json'), { force: true })))
}

export async function markFasterStateDirCleared({ dir, seedDirs }: FasterStateDir): Promise<void> {
  if (seedDirs.length) {
    await Promise.all(FASTER_STATE_FILES.map(name => writeFasterStateFile(join(dir, name), '')))
  }
}

export async function writeFasterStateFile(path: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, contents)
    await rename(temporaryPath, path)
  }
  finally {
    await rm(temporaryPath, { force: true })
  }
}

/** Key of a test file in FASTER's per-file state: its project and its path from the root. */
export function fileKey(root: string, projectName: string | undefined, filepath: string): string {
  return `${projectName || ''}:${relative(root, filepath)}`
}

/** Per-test-file records kept in one versioned JSON state file. */
export class FasterStateStore<T> {
  protected records = new Map<string, T>()
  protected root = '/'
  private path: string | undefined

  constructor(private readonly name: string, private readonly version: string, private readonly field: string) {}

  configure(root: string, stateDir: string | undefined): void {
    this.root = root
    this.path = stateDir ? resolve(stateDir, this.name) : undefined
  }

  get(key: string): T | undefined {
    return this.records.get(key)
  }

  async read(): Promise<void> {
    if (!this.path) {
      return
    }
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8'))
      if (state.version === this.version && Array.isArray(state[this.field])) {
        this.records = new Map(state[this.field])
      }
    }
    catch {}
  }

  /** Forgets a deleted test file in every project; Vitest reports it by absolute path. */
  remove(filepath: string): void {
    const suffix = `:${relative(this.root, filepath)}`
    for (const key of this.records.keys()) {
      if (key.endsWith(suffix)) {
        this.records.delete(key)
      }
    }
  }

  async write(): Promise<void> {
    if (!this.path) {
      return
    }
    await writeFasterStateFile(this.path, JSON.stringify({ version: this.version, [this.field]: [...this.records] }))
  }

  async clear(): Promise<void> {
    this.records.clear()
    if (this.path) {
      await rm(this.path, { force: true })
    }
  }
}
