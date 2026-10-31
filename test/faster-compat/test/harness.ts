import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { x } from 'tinyexec'

const compatRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export type HostName = 'fork' | 'vitest-4.0' | 'vitest-4.1' | 'vitest-5'

/**
 * `fork` runs the FASTER fork from this repository, packed as the `faster`
 * package and installed under the name `vitest`. The other hosts are
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
  const cache = join(root, 'node_modules/.vite/vitest')
  if (!existsSync(cache)) {
    return undefined
  }
  const state: Record<string, unknown> = {}
  for (const dir of readdirSync(cache)) {
    const file = join(cache, dir, 'faster-sources.json')
    if (existsSync(file)) {
      state[dir] = JSON.parse(readFileSync(file, 'utf8'))
    }
  }
  return state
}

/**
 * FASTER's persisted state with every structural (`shape`) and function body
 * hash replaced by the order in which that value first appeared for the same
 * source and function across the run's steps. The raw hashes fingerprint the
 * transformed code, which embeds each installation's absolute dependency
 * paths; the decisions only compare a hash with the previous one, which the
 * ordinals preserve. Source hashes, tracked paths, function identities and
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
