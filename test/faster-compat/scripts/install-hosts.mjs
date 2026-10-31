import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Each host is a standalone install of an upstream Vitest release. The
// workspace forces `vitest` to the fork, so hosts ignore the workspace and
// install the plugin from its packed tarball, as a user would from npm.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pack = join(root, '.pack')
rmSync(pack, { recursive: true, force: true })
mkdirSync(pack, { recursive: true })
// The fork is installed from its publishable package, `faster`, so that like
// upstream Vitest it lives under node_modules. Both packages must be built.
for (const [name, directory] of [['vitest-faster', 'vitest-faster'], ['faster', 'faster']]) {
  const destination = join(pack, name)
  mkdirSync(destination)
  execFileSync('pnpm', ['pack', '--pack-destination', destination], {
    cwd: join(root, '../../packages', directory),
    stdio: 'inherit',
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  })
  const [tarball] = readdirSync(destination)
  renameSync(join(destination, tarball), join(pack, `${name}.tgz`))
  rmSync(destination, { recursive: true })
}

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
