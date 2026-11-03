import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'pathe'

export interface FasterStateFile {
  path: string
  seeds: string[]
}

const pendingSeeds = new Map<string, Promise<string | undefined>>()

export function resolveFasterStateFile(root: string, cacheDir: string, name: string): FasterStateFile {
  const cacheInRoot = relative(root, cacheDir)
  const outsideRoot = cacheInRoot === '..' || cacheInRoot.startsWith('../') || isAbsolute(cacheInRoot)
  const gitDir = outsideRoot ? undefined : resolveGitDir(root)
  const cachePath = join(cacheDir, name)
  if (!gitDir) {
    return { path: cachePath, seeds: [] }
  }
  const path = join(gitDir, 'faster', cacheInRoot, name)
  const shared = join(readCommonDir(gitDir), 'faster', cacheInRoot, name)
  return { path, seeds: shared === path ? [cachePath] : [cachePath, shared] }
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

export async function readFasterStateFile(file: FasterStateFile): Promise<string | undefined> {
  try {
    return await readFile(file.path, 'utf8')
  }
  catch (error: any) {
    if (error?.code !== 'ENOENT' || !file.seeds.length) {
      return undefined
    }
  }
  let seeding = pendingSeeds.get(file.path)
  if (!seeding) {
    seeding = seedFasterStateFile(file).finally(() => pendingSeeds.delete(file.path))
    pendingSeeds.set(file.path, seeding)
  }
  return seeding
}

async function seedFasterStateFile(file: FasterStateFile): Promise<string | undefined> {
  for (const seed of file.seeds) {
    const contents = await readFile(seed, 'utf8').catch(() => undefined)
    if (contents) {
      await writeFasterStateFile(file.path, contents).catch(() => {})
      return contents
    }
  }
  return undefined
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

export async function clearFasterStateFile(file: FasterStateFile): Promise<void> {
  if (file.seeds.length) {
    await writeFasterStateFile(file.path, '')
  }
  else {
    await rm(file.path, { force: true })
  }
}
