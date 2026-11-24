import type { TrustedBranch, TrustedBranchBase } from './decision/sourceChanges'
import { existsSync } from 'node:fs'
import { isAbsolute, relative } from 'pathe'
import { x } from 'tinyexec'

const REMOTES = 'refs/remotes/'
const ORIGIN = `${REMOTES}origin/`

export type TrustedBranchOption = string | false | undefined

export function resolveTrustedBranchOption(value: unknown, ci: boolean): TrustedBranchOption {
  if (value === undefined) {
    return ci ? false : undefined
  }
  if (value === false || (typeof value === 'string' && value.length > 0)) {
    return value
  }
  throw new TypeError(`Invalid faster.trustedBranch: expected a branch name or false, received "${String(value)}".`)
}

export interface ResolvedTrustedBranch extends TrustedBranchBase {
  ref: string
  commit: string
}

export function createTrustedBranch(root: string, branch: string | undefined): TrustedBranch & { resolved: () => Promise<ResolvedTrustedBranch | undefined> } {
  let pending: Promise<ResolvedTrustedBranch | undefined> | undefined
  const resolved = () => pending ??= resolveTrustedBranch(root, branch).catch(() => undefined)
  return { base: resolved, resolved }
}

export async function resolveTrustedBranch(root: string, branch: string | undefined): Promise<ResolvedTrustedBranch | undefined> {
  const [top, ref] = await Promise.all([
    git(root, ['rev-parse', '--show-toplevel']),
    resolveRemoteRef(root, branch),
  ])
  if (top === undefined || !ref) {
    return undefined
  }
  const commit = await git(top, ['merge-base', 'HEAD', ref])
  if (!commit) {
    return undefined
  }
  const [tree, differing] = await Promise.all([
    git(top, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', commit]),
    git(top, ['diff', '--no-renames', '--name-only', '-z', commit]),
  ])
  if (tree === undefined || differing === undefined) {
    return undefined
  }
  const committed = new Set(splitPaths(tree))
  const changed = new Set(splitPaths(differing))
  return {
    ref: ref.slice(REMOTES.length),
    commit,
    trusts(filepath: string): boolean {
      const path = relative(top, filepath)
      if (path.startsWith('../') || isAbsolute(path)) {
        return false
      }
      return committed.has(path) ? !changed.has(path) : !existsSync(filepath)
    },
  }
}

async function resolveRemoteRef(cwd: string, branch: string | undefined): Promise<string | undefined> {
  if (branch === undefined) {
    const head = await git(cwd, ['symbolic-ref', '--quiet', `${ORIGIN}HEAD`])
    return head?.startsWith(ORIGIN) ? head : resolveRemoteRef(cwd, 'main')
  }
  const [upstream, remote] = await Promise.all([
    git(cwd, ['rev-parse', '--verify', '--quiet', '--symbolic-full-name', `${branch}@{upstream}`]),
    git(cwd, ['for-each-ref', '--format=%(refname)', `${ORIGIN}${branch}`, `${REMOTES}${branch}`]),
  ])
  if (upstream?.startsWith(REMOTES)) {
    return upstream
  }
  const refs = remote?.split('\n').filter(Boolean) ?? []
  return refs.find(ref => ref === `${ORIGIN}${branch}`) ?? refs[0]
}

function splitPaths(output: string): string[] {
  return output.split('\0').filter(Boolean)
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  const result = await x('git', args, { nodeOptions: { cwd }, throwOnError: false })
  return result.exitCode === 0 ? result.stdout.trim() : undefined
}
