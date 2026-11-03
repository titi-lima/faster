import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'pathe'

export interface FasterStateFile {
  path: string
  seeds: string[]
}

interface GitDirs {
  gitDir: string
  commonDir: string
}

interface FasterStateLocation {
  dir: string
  seedDirs: string[]
}

export function resolveFasterStateFile(root: string, cacheDir: string, name: string): FasterStateFile {
  const location = resolveFasterStateLocation(root, cacheDir)
  return {
    path: join(location.dir, name),
    seeds: location.seedDirs.map(dir => join(dir, name)),
  }
}

function resolveFasterStateLocation(root: string, cacheDir: string): FasterStateLocation {
  const cacheInRoot = relative(root, cacheDir)
  const outsideRoot = cacheInRoot === '..' || cacheInRoot.startsWith('../') || isAbsolute(cacheInRoot)
  const gitDirs = outsideRoot ? undefined : resolveGitDirs(root)
  if (!gitDirs) {
    return { dir: cacheDir, seedDirs: [] }
  }
  const dir = join(gitDirs.gitDir, 'faster', cacheInRoot)
  const shared = join(gitDirs.commonDir, 'faster', cacheInRoot)
  return { dir, seedDirs: shared === dir ? [cacheDir] : [cacheDir, shared] }
}

function resolveGitDirs(root: string): GitDirs | undefined {
  const dotGit = join(root, '.git')
  try {
    if (statSync(dotGit).isDirectory()) {
      return { gitDir: dotGit, commonDir: dotGit }
    }
    const gitFile = readFileSync(dotGit, 'utf8').trim()
    const gitDir = gitFile.startsWith('gitdir:') ? gitFile.slice('gitdir:'.length).trim() : ''
    if (!gitDir) {
      return undefined
    }
    const absoluteGitDir = resolve(root, gitDir)
    if (!statSync(absoluteGitDir, { throwIfNoEntry: false })?.isDirectory()) {
      return undefined
    }
    return { gitDir: absoluteGitDir, commonDir: readCommonDir(absoluteGitDir) }
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
    if (error?.code !== 'ENOENT') {
      return undefined
    }
  }
  for (const seed of file.seeds) {
    if (await copyFasterStateFile(seed, file.path)) {
      return readFile(file.path, 'utf8').catch(() => undefined)
    }
  }
  return undefined
}

async function copyFasterStateFile(source: string, target: string): Promise<boolean> {
  const temporaryPath = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, temporaryPath)
    await rename(temporaryPath, target)
    return true
  }
  catch {
    return false
  }
  finally {
    await rm(temporaryPath, { force: true })
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

export async function clearFasterStateFile(file: FasterStateFile, emptyContents: string): Promise<void> {
  if (file.seeds.length) {
    await writeFasterStateFile(file.path, emptyContents)
  }
  else {
    await rm(file.path, { force: true })
  }
}
