import type { Reporter, RunnerTestFile, TestProject, TestSpecification, Vitest } from 'vitest/node'
import type { FasterOptions, ResolvedFasterOptions } from './decision/priorityManifest'
import type { FasterSourceSnapshots } from './decision/sourceChanges'
import type { FasterSafety } from './escapes'
import type { HostSequencerOptions } from './sequencer'
import type { FasterStateDir } from './stateFile'
import { readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { relative, resolve } from 'pathe'
import pm from 'picomatch'
import { BaseSequencer } from 'vitest/node'
import { GitNotFoundError } from './decision/errors'
import { recordFasterFunctionCoverage } from './decision/functionCoverage'
import { GitVCSProvider } from './decision/git'
import { resolveFasterOptions } from './decision/priorityManifest'
import {
  captureTestRunSourceSnapshots,
  clearFasterSourceSnapshots,
  getTestSourceChanges,
  saveTestRunSourceSnapshots,
} from './decision/sourceChanges'
import { FasterEscapes, resolveSafety } from './escapes'
import { FasterResults } from './results'
import { createHostSequencer } from './sequencer'
import { fileKey, markFasterStateDirCleared, resolveFasterStateDir, seedFasterStateDir } from './stateFile'

export const PLUGIN_NAME = 'vitest-faster'
export const PRIORITIES_KEY = '__vitestFasterPriorities'
const REGISTRY = Symbol.for('vitest-faster.hosts')
const MODULE_CACHE_COMMENT = '\n//# vitestCache='

type FasterLayerOptions = FasterOptions & { safety?: unknown }
export type FasterLayer = boolean | FasterLayerOptions | undefined
/** The fork's options for a project, plus the plugin's own `safety`. */
type ResolvedOptions = ResolvedFasterOptions & { safety: FasterSafety }

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
  readonly escapes: FasterEscapes = new FasterEscapes()
  readonly options: WeakMap<TestProject, FasterLayer[]> = new WeakMap()
  rootOptions: FasterLayer[] | undefined
  root!: ResolvedFasterOptions
  coverage: CoverageRole | undefined
  capture: Promise<FasterSourceSnapshots> | undefined
  private previousFiles: Set<RunnerTestFile> | undefined
  private resolved = new WeakMap<TestProject, ResolvedOptions>()
  private projectFacades = new WeakMap<TestProject, any>()
  private specificationFacades = new WeakMap<TestSpecification, any>()
  private stats = new Map<string, { size: number }>()
  private setUp = false
  private git: GitVCSProvider | undefined
  private stateDir: FasterStateDir | undefined
  private stateConfigBase: unknown
  private stateConfig: unknown
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
      config: { get: () => this.contextConfig() },
      _coverageOptions: { get: () => ({ provider: this.coverage?.provider ?? vitest.config.coverage.provider }) },
    })
  }

  private contextConfig(): any {
    const config = this.vitest.config as any
    if (!this.stateDir || config.cache === false) {
      return config
    }
    if (this.stateConfigBase !== config) {
      this.stateConfigBase = config
      this.stateConfig = Object.create(config, { cache: { value: { ...config.cache, dir: this.stateDir.dir } } })
    }
    return this.stateConfig
  }

  faster(project: TestProject): ResolvedOptions {
    let resolved = this.resolved.get(project)
    if (!resolved) {
      const layers = mergeLayers(this.options.get(project))
      resolved = {
        ...resolveFasterOptions(project.config.root, layers),
        safety: resolveSafety(typeof layers === 'object' ? layers.safety : undefined, isCI()),
      }
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
      const key = fileKey(this.vitest.config.root, specification.project.name, specification.moduleId)
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

    const cacheDir = vitest.config.cache === false ? undefined : (vitest.config.cache as any).dir
    this.stateDir = cacheDir ? resolveFasterStateDir(vitest.config.root, cacheDir) : undefined
    if (this.stateDir) {
      await seedFasterStateDir(this.stateDir)
    }
    this.results.configure(vitest.config.root, this.stateDir?.dir)
    this.escapes.configure(vitest.config.root, this.stateDir?.dir)
    await Promise.all([this.results.read(), this.escapes.read()])

    this.configureCoverage()
    this.configureEscapes()
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
    const customProviderModule = fileURLToPath(new URL('./coverage.js', import.meta.url))
    // Workers run the user's V8 provider. Without user coverage, nothing reports
    // it, so they start it through FASTER's module, which skips block coverage.
    for (const [project, coverage] of projectCoverage) {
      if (project.config !== root) {
        ;(project.config as any).coverage = !userCoverage.enabled && coverage.enabled && !project.isBrowserEnabled()
          ? { ...coverage, provider: 'custom', customProviderModule }
          : coverage
      }
    }
    // The root provider is the only node-side hook that receives worker coverage.
    root.coverage = {
      ...rootCoverage,
      enabled: true,
      provider: 'custom',
      customProviderModule,
    }
  }

  /** Workers record escapes through a setup file that runs before the project's own. */
  private configureEscapes(): void {
    const recorder = fileURLToPath(new URL('./recorder.js', import.meta.url))
    for (const project of this.vitest.projects) {
      if (!this.faster(project).enabled || project.isBrowserEnabled() || this.faster(project).safety === 'off') {
        continue
      }
      const config = project.config as any
      config.setupFiles = [recorder, ...(config.setupFiles ?? [])]
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
      const key = (spec: TestSpecification) => fileKey(vitest.config.root, spec.project.name, spec.moduleId)
      const [changes, changedReads] = await Promise.all([
        getTestSourceChanges(this.context, tracked.map(spec => this.specification(spec))),
        this.escapes.changedReads(tracked.filter(spec => this.faster(spec.project).safety !== 'off').map(key)),
      ])
      const escaping: Record<'strict' | 'fast', string[]> = { strict: [], fast: [] }
      const selected = relevant.filter((spec) => {
        const id = key(spec)
        const change = changes.get(this.specification(spec))
        if (!change || !change.known || change.testChanged || change.changed || this.results.get(id)?.failed || changedReads.has(id)) {
          return true
        }
        const safety = this.faster(spec.project).safety
        const opaque = this.escapes.get(id)?.opaque
        if (safety === 'off' || !opaque?.length) {
          return false
        }
        escaping[safety].push(`${relative(vitest.config.root, spec.moduleId)} (${opaque.slice(0, 2).map(escape => `${escape.kind}: ${escape.target}`).join(', ')}${opaque.length > 2 ? ', …' : ''})`)
        return safety === 'strict'
      })
      this.reportEscaping(escaping)
      return selected
    }
  }

  private reportEscaping(escaping: Record<'strict' | 'fast', string[]>): void {
    for (const [safety, verb] of [['strict', 'running'], ['fast', 'skipped']] as const) {
      const files = escaping[safety]
      if (files.length) {
        this.vitest.logger.log(`[${PLUGIN_NAME}] ${safety}: ${verb} ${files.length} unaffected test file(s) that left their worker in their last run: ${files.slice(0, 5).join(', ')}${files.length > 5 ? `, and ${files.length - 5} more` : ''}`)
      }
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
        await this.escapes.clear()
        await clearFasterSourceSnapshots(this.context)
        if (this.stateDir) {
          await markFasterStateDirCleared(this.stateDir)
        }
      }
    }
  }

  /**
   * Starts the pre-run source snapshot, which the fork starts next to the pool,
   * and hashes the files the recorded tests read before any of them runs.
   */
  startCapture(specifications: TestSpecification[]): Promise<FasterSourceSnapshots> {
    this.capture = captureTestRunSourceSnapshots(this.context, specifications.map(spec => this.specification(spec)))
      .catch(() => new Map())
    const reads = this.escapes.capture(specifications
      .filter(spec => this.faster(spec.project).safety !== 'off')
      .map(spec => fileKey(this.vitest.config.root, spec.project.name, spec.moduleId)))
      .catch(() => {})
    return Promise.all([this.capture, reads]).then(([capture]) => capture)
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
        const executed = files.filter(file => !previousFiles.has(file))
        this.results.update(files)
        const escapes = this.escapes.update(executed).then(() => this.escapes.write()).catch(() => {})
        try {
          if (reason !== 'interrupted' && capture) {
            await saveTestRunSourceSnapshots(this.context, await capture, executed)
          }
        }
        catch {}
        try {
          await this.results.write()
        }
        catch {}
        await escapes
      },
      onTestRemoved: (id) => {
        if (id) {
          this.results.remove(id)
          this.escapes.remove(id)
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

export function mergeLayers(layers: FasterLayer[] | undefined): boolean | FasterLayerOptions {
  if (!layers) {
    return false
  }
  let merged: FasterLayerOptions = {}
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

function isCI(): boolean {
  return Boolean(process.env.CI) && !['0', 'false'].includes(process.env.CI!.toLowerCase())
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
