import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_FORK_REF } from './check-decision-code.mjs'

/**
 * Builds the FASTER fork from a commit of this repository that still holds it
 * and packs its publishable `faster` package, as the evaluation installed it.
 *
 *   node test/faster-compat/scripts/pack-fork.mjs [ref]
 *
 * `ref` defaults to `FASTER_FORK_REF`, then to the commit that merged the
 * plugin. The commit is exported with `git archive` into a temporary
 * directory, installed with its own lockfile and built there. The tarball is
 * kept in `test/faster-compat/.fork/<commit>.tgz`, so each commit is built
 * once.
 */
const compatRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(compatRoot, '../..')
const cache = join(compatRoot, '.fork')

function run(command, args, cwd, env = {}) {
  execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
}

export function packFork(ref = process.env.FASTER_FORK_REF || DEFAULT_FORK_REF) {
  const commit = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repository, encoding: 'utf8' }).trim()
  const tarball = join(cache, `${commit}.tgz`)
  if (existsSync(tarball)) {
    return { commit, tarball }
  }
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 20 || major === 21 || (major === 20 && minor < 19) || (major === 22 && minor < 12)) {
    // pnpm silently skips the oxc native bindings the fork's build needs.
    throw new Error(`Building the FASTER fork needs Node ^20.19.0 || >=22.12.0, found ${process.versions.node}`)
  }
  console.log(`Building the FASTER fork at ${commit}`)
  const work = mkdtempSync(join(tmpdir(), 'faster-fork-'))
  try {
    execFileSync('git', ['archive', '--format=tar', '-o', join(work, 'source.tar'), commit], { cwd: repository })
    run('tar', ['-xf', 'source.tar'], work)
    rmSync(join(work, 'source.tar'))
    run('pnpm', ['install', '--frozen-lockfile'], work, { CI: 'true' })
    run('pnpm', ['run', 'build'], work)
    run('pnpm', ['run', 'build'], join(work, 'packages/faster'))
    const packed = join(work, '.pack')
    mkdirSync(packed)
    run('pnpm', ['pack', '--pack-destination', packed], join(work, 'packages/faster'), { npm_config_ignore_scripts: 'true' })
    const [file] = readdirSync(packed)
    mkdirSync(cache, { recursive: true })
    copyFileSync(join(packed, file), `${tarball}.tmp`)
    renameSync(`${tarball}.tmp`, tarball)
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
  return { commit, tarball }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { commit, tarball } = packFork(process.argv[2])
  console.log(`${commit}: ${tarball}`)
}
