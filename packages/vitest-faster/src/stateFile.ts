import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'pathe'

export const FASTER_STATE_FILES = ['faster-sources.json', 'faster-results.json']

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
      const contents = await readFile(join(seedDir, name), 'utf8').catch(() => undefined)
      if (contents) {
        await writeFasterStateFile(join(dir, name), contents).catch(() => {})
        return
      }
    }
  }))
}

export async function markFasterStateDirCleared({ dir, seedDirs }: FasterStateDir): Promise<void> {
  if (seedDirs.length) {
    await Promise.all(FASTER_STATE_FILES.map(name => writeFasterStateFile(join(dir, name), '')))
  }
}

export async function writeFasterStateFile(path: string, contents: string): Promise<void> {
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
