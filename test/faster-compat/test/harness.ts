import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'
import { x } from 'tinyexec'

const compatRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export type HostName = 'fork' | 'vitest-4.0' | 'vitest-4.1' | 'vitest-5'

/**
 * `fork` runs the FASTER fork, built from a commit of this repository that
 * still holds it (`scripts/pack-fork.mjs`), packed as the `faster` package
 * and installed under the name `vitest`. The other hosts are
 * standalone installs of upstream Vitest releases with the packed
 * `vitest-faster` plugin (see `scripts/install-hosts.mjs`).
 */
export const hosts: Record<HostName, { dir: string; plugin: boolean }> = {
  'fork': { dir: join(compatRoot, 'hosts/fork'), plugin: false },
  'vitest-4.0': { dir: join(compatRoot, 'hosts/vitest-4.0'), plugin: true },
  'vitest-4.1': { dir: join(compatRoot, 'hosts/vitest-4.1'), plugin: true },
  'vitest-5': { dir: join(compatRoot, 'hosts/vitest-5'), plugin: true },
}

export const hostNames = Object.keys(hosts) as HostName[]

export function missingHosts(): HostName[] {
  return hostNames.filter(name => !existsSync(join(hosts[name].dir, 'node_modules/vitest/package.json')))
}

function vitestBin(host: HostName): string {
  const directory = join(hosts[host].dir, 'node_modules/vitest')
  const { bin } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  return join(directory, typeof bin === 'string' ? bin : bin.vitest)
}

export function hostVersion(name: HostName): string {
  return JSON.parse(readFileSync(join(hosts[name].dir, 'node_modules/vitest/package.json'), 'utf8')).version
}

export interface ProjectConfig {
  test: Record<string, unknown>
  faster?: boolean | Record<string, unknown>
}

export interface ScenarioConfig extends ProjectConfig {
  projects?: ProjectConfig[]
}

export interface Fixture {
  root: string
  write: (file: string, content: string) => void
  edit: (file: string, from: string | RegExp, to: string) => void
  remove: (file: string) => void
  git: (...args: string[]) => Promise<void>
}

export interface Step {
  name: string
  change?: (fixture: Fixture) => void | Promise<void>
  args?: string[]
}

export interface Scenario {
  name: string
  config: ScenarioConfig
  files: Record<string, string>
  steps: Step[]
  /** Use the `vitest-faster` binary on plugin hosts so `--faster.*` flags work. */
  fasterCli?: boolean
  setup?: (fixture: Fixture) => Promise<void>
}

export interface Observation {
  step: string
  exitCode: number | undefined
  /** Test files in the order they started. */
  files: string[]
  /** Every executed test, in execution order. */
  tests: string[]
}

export interface ScenarioResult {
  observations: Observation[]
  /** FASTER's persisted per-test source and function state after each step. */
  states: unknown[]
  output: string[]
  root: string
}

export function renderConfig(host: HostName, config: ScenarioConfig): string {
  const project = (entry: ProjectConfig) => hosts[host].plugin
    ? `{ plugins: [faster(${JSON.stringify(entry.faster ?? {})})], test: ${JSON.stringify(entry.test)} }`
    : `{ test: ${JSON.stringify({ ...entry.test, faster: entry.faster ?? {} })} }`
  const root = hosts[host].plugin
    ? { plugins: `[faster(${JSON.stringify(config.faster ?? {})})]`, test: config.test }
    : { test: { ...config.test, faster: config.faster ?? {} } }
  const projects = config.projects ? `, projects: [${config.projects.map(project).join(', ')}]` : ''
  const test = JSON.stringify(root.test).replace(/\}$/, `${projects}}`)
  return [
    hosts[host].plugin ? `import { faster } from 'vitest-faster'` : '',
    `export default { ${'plugins' in root ? `plugins: ${root.plugins}, ` : ''}test: ${test} }`,
    '',
  ].join('\n')
}

export async function runScenario(host: HostName, scenario: Scenario): Promise<ScenarioResult> {
  const root = join(hosts[host].dir, 'fixtures', scenario.name)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const fixture: Fixture = {
    root,
    write(file, content) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), content)
    },
    edit(file, from, to) {
      const before = readFileSync(join(root, file), 'utf8')
      const after = before.replace(from, to)
      if (before === after) {
        throw new Error(`Edit of ${file} changed nothing`)
      }
      writeFileSync(join(root, file), after)
    },
    remove(file) {
      rmSync(join(root, file), { force: true })
    },
    async git(...args) {
      await x('git', args, { nodeOptions: { cwd: root }, throwOnError: true })
    },
  }
  for (const [file, content] of Object.entries(scenario.files)) {
    fixture.write(file, content)
  }
  fixture.write('vitest.config.mjs', renderConfig(host, scenario.config))
  await scenario.setup?.(fixture)

  const log = join(root, 'order.log')
  const bin = scenario.fasterCli && hosts[host].plugin
    ? join(hosts[host].dir, 'node_modules/vitest-faster/dist/cli.js')
    : vitestBin(host)
  const result: ScenarioResult = { observations: [], states: [], output: [], root }
  for (const step of scenario.steps) {
    await step.change?.(fixture)
    rmSync(log, { force: true })
    const run = await x('node', [bin, 'run', ...(step.args ?? [])], {
      nodeOptions: {
        cwd: root,
        env: { ...process.env, ORDER_LOG: log, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0', VITEST_FASTER_OPTIONS: '' },
      },
      throwOnError: false,
    })
    const tests = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
    result.observations.push({
      step: step.name,
      exitCode: run.exitCode,
      files: [...new Set(tests.map(test => test.split('::')[0]))],
      tests,
    })
    result.states.push(readState(root))
    result.output.push(`${run.stdout}\n${run.stderr}`)
  }
  return result
}

function readState(root: string): unknown {
  const caches = [join(root, '.git/faster/node_modules/.vite/vitest'), join(root, 'node_modules/.vite/vitest')]
    .filter(cache => existsSync(cache))
  if (!caches.length) {
    return undefined
  }
  const state: Record<string, unknown> = {}
  for (const cache of caches) {
    for (const dir of readdirSync(cache)) {
      const sources = readSourceState(join(cache, dir))
      if (!(dir in state) && sources) {
        state[dir] = sources
      }
    }
  }
  return state
}

/**
 * FASTER's per-test source and function state in a cache directory, in the
 * fork's layout: the fork's `faster-sources.json`, or the plugin's compressed
 * `faster-sources.json.br` expanded.
 */
export function readSourceState(directory: string): unknown {
  const plugin = join(directory, 'faster-sources.json.br')
  const fork = join(directory, 'faster-sources.json')
  if (existsSync(plugin)) {
    return expandState(JSON.parse(brotliDecompressSync(readFileSync(plugin)).toString('utf8')))
  }
  return existsSync(fork) ? expandState(JSON.parse(readFileSync(fork, 'utf8'))) : undefined
}

/**
 * The plugin stores each source version, function model and snapshot once and
 * refers to them by index; the fork stores them in every test file's entry.
 * This expands the plugin's state into the fork's layout, without its
 * version, so the two compare entry by entry.
 */
function expandState(state: any): unknown {
  if (state.version !== 2) {
    const { version: _, ...rest } = state
    return rest
  }
  const called: Record<string, boolean | null> = { '1': true, '0': false, '-': null }
  const models = state.models.map(([environment, shape, ids, hashes]: string[]) => {
    let previous = ''
    const decoded = ids
      ? ids.split(' ').map((entry) => {
          const separator = entry.indexOf(':')
          previous = previous.slice(0, Number.parseInt(entry.slice(0, separator), 36)) + entry.slice(separator + 1)
          return previous
        })
      : []
    const width = hashes.length / Math.max(decoded.length, 1)
    return { environment, shape, ids: decoded, hashes: decoded.map((_, index) => hashes.slice(index * width, (index + 1) * width)) }
  })
  const expanded: { tests: Record<string, unknown>; functionTests: Record<string, unknown> } = { tests: {}, functionTests: {} }
  for (const [key, [files, snapshots]] of Object.entries<[number[], number[]?]>(state.tests)) {
    const tests: Record<string, string> = {}
    const functions: Record<string, unknown> = {}
    files.forEach((fileIndex, position) => {
      const [path, sourceHash] = state.files[fileIndex]
      tests[path] = sourceHash
      const snapshotIndex = snapshots?.[position] ?? -1
      if (snapshotIndex !== -1) {
        const [modelIndex, calls] = state.snapshots[snapshotIndex]
        const model = models[modelIndex]
        functions[path] = {
          sourceHash,
          environment: model.environment,
          shape: model.shape,
          functions: Object.fromEntries(model.ids.map((id: string, index: number) => [id, { hash: model.hashes[index], called: called[calls[index]] }])),
        }
      }
    })
    expanded.tests[key] = tests
    expanded.functionTests[key] = functions
  }
  return expanded
}

/**
 * FASTER's persisted state with every structural (`shape`) and function body
 * hash replaced by the order in which that value first appeared for the same
 * source and function across the run's steps. The raw hashes fingerprint the
 * transformed code, which embeds each installation's absolute dependency
 * paths, and the plugin stores shorter ones than the fork; the decisions only
 * compare a hash with the previous one, which the ordinals preserve. Source hashes, tracked paths, function identities and
 * call observations are kept as they are.
 */
export function canonicalStates(states: any[]): unknown[] {
  const ordinals = new Map<string, string[]>()
  const ordinal = (key: string, value: string) => {
    const seen = ordinals.get(key) ?? []
    ordinals.set(key, seen)
    if (!seen.includes(value)) {
      seen.push(value)
    }
    return `#${seen.indexOf(value)}`
  }
  return states.map(state => state && Object.fromEntries(Object.entries(state).map(([dir, value]: [string, any]) => [dir, {
    ...value,
    functionTests: value.functionTests && Object.fromEntries(Object.entries(value.functionTests).map(([test, paths]: [string, any]) => [
      test,
      Object.fromEntries(Object.entries(paths).map(([path, snapshot]: [string, any]) => [path, {
        ...snapshot,
        shape: ordinal(path, snapshot.shape),
        functions: Object.fromEntries(Object.entries(snapshot.functions).map(([id, fn]: [string, any]) => [id, {
          ...fn,
          hash: ordinal(`${path}#${id}`, fn.hash),
        }])),
      }])),
    ])),
  }])))
}

export function testFile(name: string, options: { imports?: string; sleep: number; tests: Record<string, string> }): string {
  const tests = Object.entries(options.tests).map(([title, body]) => [
    `test(${JSON.stringify(title)}, async () => {`,
    `  log(${JSON.stringify(`${name}::${title}`)})`,
    `  await new Promise(resolve => setTimeout(resolve, ${options.sleep}))`,
    `  ${body}`,
    `})`,
  ].join('\n'))
  return [
    `import { appendFileSync } from 'node:fs'`,
    `import { expect, test } from 'vitest'`,
    options.imports ?? '',
    `const log = entry => appendFileSync(process.env.ORDER_LOG, (process.env.PROJECT ? process.env.PROJECT + '|' : '') + entry + '\\n')`,
    ...tests,
    '',
  ].join('\n')
}
