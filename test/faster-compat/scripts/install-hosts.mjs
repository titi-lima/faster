import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packFork } from './pack-fork.mjs'

// Each host is a standalone install outside the workspace, as a user would
// install from npm: an upstream Vitest release with the packed plugin, or the
// fork, built from a commit of this repository and installed as `vitest`.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pack = join(root, '.pack')
rmSync(pack, { recursive: true, force: true })
mkdirSync(pack, { recursive: true })

const destination = join(pack, 'vitest-faster')
mkdirSync(destination)
execFileSync('pnpm', ['pack', '--pack-destination', destination], {
  cwd: join(root, '../../packages/vitest-faster'),
  stdio: 'inherit',
  env: { ...process.env, npm_config_ignore_scripts: 'true' },
})
const [tarball] = readdirSync(destination)
renameSync(join(destination, tarball), join(pack, 'vitest-faster.tgz'))
rmSync(destination, { recursive: true })

const fork = packFork()
copyFileSync(fork.tarball, join(pack, 'faster.tgz'))
console.log(`Fork host: ${fork.commit}`)

const hosts = join(root, 'hosts')
for (const host of readdirSync(hosts)) {
  console.log(`Installing ${host}`)
  rmSync(join(hosts, host, 'node_modules'), { recursive: true, force: true })
  rmSync(join(hosts, host, 'pnpm-lock.yaml'), { force: true })
  execFileSync('pnpm', ['install', '--ignore-workspace', '--force'], {
    cwd: join(hosts, host),
    stdio: 'inherit',
  })
}
