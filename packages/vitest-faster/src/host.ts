import type { Reporter, RunnerTestFile, TestProject, TestSpecification, Vitest } from 'vitest/node'
import type { FasterOptions, ResolvedFasterOptions } from '../../vitest/src/node/faster/priorityManifest'
import type { FasterSourceSnapshots } from '../../vitest/src/node/faster/sourceChanges'
import type { HostSequencerOptions } from './sequencer'
import { readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { relative, resolve } from 'pathe'
import pm from 'picomatch'
import { BaseSequencer } from 'vitest/node'
import { GitNotFoundError } from '../../vitest/src/node/errors'
import { recordFasterFunctionCoverage } from '../../vitest/src/node/faster/functionCoverage'
import { resolveFasterOptions } from '../../vitest/src/node/faster/priorityManifest'
import {
  captureTestRunSourceSnapshots,
  clearFasterSourceSnapshots,
  getTestSourceChanges,
  saveTestRunSourceSnapshots,
} from '../../vitest/src/node/faster/sourceChanges'
import { GitVCSProvider } from '../../vitest/src/node/vcs/git'
import { FasterResults } from './results'
import { createHostSequencer } from './sequencer'

export const PLUGIN_NAME = 'vitest-faster'
export const PRIORITIES_KEY = '__vitestFasterPriorities'
const REGISTRY = Symbol.for('vitest-faster.hosts')
const MODULE_CACHE_COMMENT = '\n//# vitestCache='

export type FasterLayer = boolean | FasterOptions | undefined

interface CoverageRole {
  /** Provider name the fork reads from `vitest._coverageOptions.provider`. */
  provider: string | undefined
  /** The fork's root coverage is enabled, so the fork creates a provider. */
  rootEnabled: boolean
  /** The fork skips creating the provider (optimization C1). */
  ownsCoverage: boolean
  /** Projects whose workers send coverage in the fork. */
  collecting: WeakSet<TestProject>
  /** Restores the configuration the plugin replaced. */
  userCoverage: Record<string, any>
}

/**
 * Adapts one upstream Vitest instance to the shape the fork's FASTER modules
 * read. Those modules are bundled unchanged; they receive these facades in
 * place of the fork's `Vitest`, `TestProject` and `TestSpecification`.
 */
export class FasterHost {
  readonly results: FasterResults = new FasterResults()
  readonly options: WeakMap<TestProject, FasterLayer[]> = new WeakMap()
  rootOptions: FasterLayer[] | undefined
  root!: ResolvedFasterOptions
  coverage: CoverageRole | undefined
  capture: Promise<FasterSourceSnapshots> | undefined
  private previousFiles: Set<RunnerTestFile> | undefined
  private resolved = new WeakMap<TestProject, ResolvedFasterOptions>()
  private projectFacades = new WeakMap<TestProject, any>()
  private specificationFacades = new WeakMap<TestSpecification, any>()
  private stats = new Map<string, { size: number }>()
  private setUp = false
  private git: GitVCSProvider | undefined
  private servers = new WeakMap<object, any>()
  private transformResults = new WeakMap<object, { code: string; result: any }>()
  /**
   * Vitest 5 appends its module cache metadata (`//# vitestCache=`) after the
   * source map of fetched modules. The fork strips trailing source map
   * comments before modelling functions; without removing this comment too,
   * a module fetched by a test would never match its fresh transform.
   */
  readonly normalizeTransforms: boolean

  /** Fork-shaped `Vitest` passed to the bundled FASTER modules. */
  readonly context: any

  constructor(readonly vitest: Vitest) {
    this.normalizeTransforms = Number.parseInt((vitest as any).version ?? '0') >= 5
    this.context = Object.defineProperties({
      cache: {
        getFileTestResults: (key: string) => this.results.get(key),
        getFileStats: (key: string) => this.stats.get(key),
      },
      vcs: {
        findChangedFiles: async (options: { root: string; changedSince?: string | boolean }): Promise<string[]> => {
          // Vitest 4.0 has no VCS provider API; the fork's default is this Git provider.
          const vcs = (vitest as any).vcs ?? (this.git ??= new GitVCSProvider())
          try {
            return await vcs.findChangedFiles(options)
          }
          catch (error: any) {
            throw error?.code === 'VITEST_GIT_NOT_FOUND' ? new GitNotFoundError() : error
          }
        },
      },
    }, {
      config: { get: () => vitest.config },
      _coverageOptions: { get: () => ({ provider: this.coverage?.provider ?? vitest.config.coverage.provider }) },
    })
  }

  faster(project: TestProject): ResolvedFasterOptions {
    let resolved = this.resolved.get(project)
    if (!resolved) {
      resolved = resolveFasterOptions(project.config.root, mergeLayers(this.options.get(project)))
      this.resolved.set(project, resolved)
    }
    return resolved
  }

  project(project: TestProject): any {
    let facade = this.projectFacades.get(project)
    if (!facade) {
      let base: object | undefined
      let config: any
      facade = Object.defineProperties({
        isBrowserEnabled: () => project.isBrowserEnabled(),
        vitest: this.context,
      }, {
        name: { get: () => project.name },
        config: {
          get: () => {
            if (project.config !== base) {
              base = project.config
              config = Object.create(project.config, {
                faster: { get: () => this.faster(project) },
                experimental: { value: (project.config as any).experimental ?? {} },
              })
            }
            return config
          },
        },
        vite: { get: () => this.normalizeTransforms ? this.normalizedServer(project.vite) : project.vite },
      })
      this.projectFacades.set(project, facade)
    }
    return facade
  }

  normalizedServer(server: any): any {
    let normalized = this.servers.get(server)
    if (!normalized) {
      const environments = new Proxy(server.environments, {
        get: (target, name) => {
          const environment = target[name]
          return environment && typeof environment === 'object' ? this.normalizedEnvironment(environment) : environment
        },
      })
      normalized = new Proxy(server, {
        get: (target, name) => name === 'environments' ? environments : target[name],
      })
      this.servers.set(server, normalized)
    }
    return normalized
  }

  private normalizedEnvironment(environment: any): any {
    let normalized = this.servers.get(environment)
    if (!normalized) {
      normalized = new Proxy(environment, {
        get: (target, name) => name === 'transformRequest'
          ? async (...args: unknown[]) => this.normalizedResult(await target.transformRequest(...args))
          : target[name],
      })
      this.servers.set(environment, normalized)
    }
    return normalized
  }

  private normalizedResult(result: any): any {
    if (!result?.code?.includes(MODULE_CACHE_COMMENT)) {
      return result
    }
    const cached = this.transformResults.get(result)
    if (cached && cached.code === result.code) {
      return cached.result
    }
    const normalized = { ...result, code: result.code.slice(0, result.code.lastIndexOf(MODULE_CACHE_COMMENT)) }
    this.transformResults.set(result, { code: result.code, result: normalized })
    return normalized
  }

  specification(specification: TestSpecification): any {
    let facade = this.specificationFacades.get(specification)
    if (!facade) {
      facade = {
        project: this.project(specification.project),
        moduleId: specification.moduleId,
        pool: specification.pool,
        original: specification,
      }
      this.specificationFacades.set(specification, facade)
    }
    return facade
  }

  async populateStats(specifications: TestSpecification[]): Promise<void> {
    await Promise.all(specifications.map(async (specification) => {
      const key = `${specification.project.name}:${relative(this.vitest.config.root, specification.moduleId)}`
      const size = await stat(specification.moduleId).then(result => result.size, () => undefined)
      if (size != null) {
        this.stats.set(key, { size })
      }
    }))
  }

  /** Called once every `configureVitest` hook has registered its project. */
  async setup(): Promise<void> {
    const vitest = this.vitest
    if (this.setUp) {
      return
    }
    this.setUp = true
    const cli = readCliOptions()
    this.root = resolveFasterOptions(vitest.config.root, this.rootOptions
      ? mergeLayers([...this.rootOptions, (vitest.config as any).faster, cli])
      : false)
    for (const project of vitest.projects) {
      const layers = this.options.get(project)
      this.options.set(project, layers ? [...layers, (project.config as any).faster, cli] : [false])
    }
    const projects = vitest.projects.filter(project => this.faster(project).enabled)
    if (!projects.length && !this.root.enabled) {
      return
    }

    this.results.configure(vitest.config.root, vitest.config.cache === false ? undefined : (vitest.config.cache as any).dir)
    await this.results.read()

    this.configureCoverage()
    this.configureSelection()
    this.configureSequencer()
    this.configurePriorities()
    this.configureCacheClearing()
    ;(vitest as any).reporters.push(this.createReporter())
  }

  private configureCoverage(): void {
    const vitest = this.vitest
    const root = vitest.config as any
    const userCoverage = { ...root.coverage }
    if (userCoverage.provider !== 'v8') {
      return
    }
    const forced = (config: any, faster: ResolvedFasterOptions) => faster.enabled && faster.changed
      && config.isolate && !config.browser?.enabled
      && config.experimental?.viteModuleRunner !== false
    const rootForced = forced(root, this.root)
    const rootCoverage = rootForced
      ? { ...userCoverage, enabled: true, reporter: userCoverage.enabled ? userCoverage.reporter : [] }
      : { ...userCoverage }
    const collecting = new WeakSet<TestProject>()
    const projectCoverage = new Map<TestProject, any>()
    for (const project of vitest.projects) {
      const coverage = forced(project.config, this.faster(project))
        ? { ...rootCoverage, enabled: true, reporter: rootCoverage.enabled ? rootCoverage.reporter : [] }
        : rootCoverage
      projectCoverage.set(project, coverage)
      if (coverage.enabled) {
        collecting.add(project)
      }
    }
    const recorded = vitest.projects.some(project => collecting.has(project) && this.faster(project).enabled && !project.isBrowserEnabled())
    if (!recorded) {
      return
    }
    const ownsCoverage = rootForced && !userCoverage.enabled && !userCoverage.thresholds
    this.coverage = {
      provider: 'v8',
      rootEnabled: Boolean(rootCoverage.enabled),
      ownsCoverage,
      collecting,
      userCoverage,
    }
    // No coverage report is produced, so Vitest 5 workers write their temporary
    // coverage files to the cache instead of the user's coverage directory.
    if (ownsCoverage && root.cache && vitest.projects.every(project => !project.isBrowserEnabled())) {
      const reportsDirectory = resolve(root.cache.dir, 'faster-coverage')
      for (const [project, coverage] of projectCoverage) {
        projectCoverage.set(project, { ...coverage, reportsDirectory })
      }
      rootCoverage.reportsDirectory = reportsDirectory
    }
    // Workers keep the user's V8 provider, so they send the exact payload the fork records.
    for (const [project, coverage] of projectCoverage) {
      if (project.config !== root) {
        ;(project.config as any).coverage = coverage
      }
    }
    // The root provider is the only node-side hook that receives worker coverage.
    root.coverage = {
      ...rootCoverage,
      enabled: true,
      provider: 'custom',
      customProviderModule: fileURLToPath(new URL('./coverage.js', import.meta.url)),
    }
  }

  private configureSelection(): void {
    const vitest = this.vitest
    const config = vitest.config as any
    if (this.root.enabled && this.root.selectAffected) {
      config.passWithNoTests ??= true
    }
    for (const project of vitest.projects) {
      const faster = this.faster(project)
      if (faster.enabled && faster.selectAffected) {
        ;(project.config as any).passWithNoTests ??= true
      }
    }
    const specifications = (vitest as any).specifications
    const getRelevantTestSpecifications = specifications.getRelevantTestSpecifications.bind(specifications)
    specifications.getRelevantTestSpecifications = async (filters: string[] = []): Promise<TestSpecification[]> => {
      const relevant: TestSpecification[] = await getRelevantTestSpecifications(filters)
      const related = vitest.config.related
      const triggers = vitest.config.forceRerunTriggers
      if (related && triggers.length && related.some(file => pm(triggers)(file))) {
        return relevant
      }
      const tracked = relevant.filter(spec => this.faster(spec.project).enabled && this.faster(spec.project).selectAffected)
      if (!tracked.length || tracked.some(spec => typeof this.faster(spec.project).changed === 'string')) {
        return relevant
      }
      const changes = await getTestSourceChanges(this.context, tracked.map(spec => this.specification(spec)))
      return relevant.filter((spec) => {
        const change = changes.get(this.specification(spec))
        const failed = this.results.get(`${spec.project.name}:${relative(vitest.config.root, spec.moduleId)}`)?.failed
        return !change || !change.known || change.testChanged || change.changed || failed
      })
    }
  }

  private configureSequencer(): void {
    const sequence = this.vitest.config.sequence as any
    // The fork keeps a sequencer the user configured; Vitest's defaults are replaced.
    const userSequencer = !isBuiltinSequencer(sequence.sequencer)
    const options: HostSequencerOptions = {
      host: this,
      fallback: sequence.sequencer,
      faster: this.root.enabled && !userSequencer,
    }
    sequence.sequencer = createHostSequencer(options)
  }

  private configurePriorities(): void {
    for (const project of this.vitest.projects) {
      const faster = this.faster(project)
      if (!faster.enabled || !Object.keys(faster.priorities).length || project.isBrowserEnabled()) {
        continue
      }
      if ((project.config as any).runner) {
        this.vitest.logger.warn(`[${PLUGIN_NAME}] Project "${project.name}" uses a custom runner, so test priorities inside files are not applied.`)
        continue
      }
      ;(project.config as any).runner = fileURLToPath(new URL('./runner.js', import.meta.url))
      ;(project as any).provide(PRIORITIES_KEY, faster.priorities)
    }
  }

  private configureCacheClearing(): void {
    const vitest = this.vitest as any
    for (const method of ['experimental_clearCache', 'clearCache']) {
      const clear = vitest[method]
      if (typeof clear !== 'function') {
        continue
      }
      vitest[method] = async (...args: unknown[]) => {
        await clear.apply(vitest, args)
        await this.results.clear()
        await clearFasterSourceSnapshots(this.context)
      }
    }
  }

  /** Starts the pre-run source snapshot; the fork starts it next to the pool. */
  startCapture(specifications: TestSpecification[]): Promise<FasterSourceSnapshots> {
    this.capture = captureTestRunSourceSnapshots(this.context, specifications.map(spec => this.specification(spec)))
      .catch(() => new Map())
    return this.capture
  }

  recordCoverage(meta: { coverage: unknown; testFiles: string[]; environment: string; projectName?: string }): void {
    const project = this.vitest.projects.find(project => project.name === (meta.projectName || ''))
    if (!project || !this.coverage?.collecting.has(project)) {
      return
    }
    let coverage = meta.coverage
    // Vitest 5 workers write the V8 payload to a file and send its path.
    if (typeof coverage === 'string') {
      try {
        const { result } = JSON.parse(readFileSync(coverage, 'utf8'))
        // Subprocess coverage (Vitest 5 `autoAttachSubprocess`) does not exist in the fork.
        coverage = { result: Array.isArray(result) ? result.filter((entry: any) => !entry.isExtendedContext) : result }
      }
      catch {
        return
      }
    }
    recordFasterFunctionCoverage(this.project(project), { ...meta, coverage } as any)
  }

  private createReporter(): Reporter {
    return {
      onTestRunStart: (specifications) => {
        this.previousFiles = specifications.length ? new Set(this.vitest.state.getFiles()) : undefined
      },
      onTestRunEnd: async (_modules, _errors, reason) => {
        const previousFiles = this.previousFiles
        const capture = this.capture
        this.previousFiles = undefined
        this.capture = undefined
        if (!previousFiles) {
          return
        }
        const files = this.vitest.state.getFiles()
        this.results.update(files)
        try {
          if (reason !== 'interrupted' && capture) {
            await saveTestRunSourceSnapshots(this.context, await capture, files.filter(file => !previousFiles.has(file)))
          }
        }
        catch {}
        try {
          await this.results.write()
        }
        catch {}
      },
      onTestRemoved: (id) => {
        if (id) {
          this.results.remove(id)
        }
      },
    }
  }
}

export function getHost(vitest: Vitest): FasterHost {
  const registry: WeakMap<Vitest, FasterHost> = ((globalThis as any)[REGISTRY] ??= new WeakMap())
  let host = registry.get(vitest)
  if (!host) {
    host = new FasterHost(vitest)
    registry.set(vitest, host)
    vitest.onAfterSetServer(() => host!.setup())
  }
  return host
}

export function mergeLayers(layers: FasterLayer[] | undefined): boolean | FasterOptions {
  if (!layers) {
    return false
  }
  let merged: FasterOptions = {}
  for (const layer of layers) {
    if (layer == null) {
      continue
    }
    merged = typeof layer === 'boolean'
      ? { ...merged, enabled: layer }
      : { ...merged, ...layer }
  }
  return merged
}

// Vitest 5 no longer exports `RandomSequencer`, which extends `BaseSequencer`.
function isBuiltinSequencer(sequencer: unknown): boolean {
  return sequencer === BaseSequencer
    || (typeof sequencer === 'function' && sequencer.name === 'RandomSequencer' && Object.getPrototypeOf(sequencer) === BaseSequencer)
}

function readCliOptions(): FasterLayer {
  const raw = process.env.VITEST_FASTER_OPTIONS
  if (!raw) {
    return undefined
  }
  try {
    return JSON.parse(raw)
  }
  catch {
    throw new TypeError(`Invalid VITEST_FASTER_OPTIONS: expected JSON, received "${raw}".`)
  }
}
