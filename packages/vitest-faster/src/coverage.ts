import type { CoverageProvider, CoverageProviderModule, Vitest } from 'vitest/node'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'pathe'
import { importV8Provider } from './v8'

const REGISTRY = Symbol.for('vitest-faster.hosts')
/**
 * Set by the node-side provider in this Vitest's `env` when no coverage
 * report is written, so the coverage collected in workers only feeds FASTER.
 * Vitest passes `env` to every worker it starts.
 */
export const FUNCTION_COVERAGE_ENV = 'VITEST_FASTER_FUNCTION_COVERAGE'

let workerModule: Promise<CoverageProviderModule> | undefined

/**
 * Inside workers the user's V8 provider collects coverage, so the payload is
 * exactly what the fork records.
 */
function v8(): Promise<CoverageProviderModule> {
  workerModule ??= import('@vitest/coverage-v8').then(module => module.default as CoverageProviderModule)
  return workerModule
}

/**
 * FASTER reads only the first range V8 reports for each function: where the
 * function is and whether it ran. V8 reports that same range without block
 * coverage, which costs workers less and sends a fraction of the data. The
 * user's provider still starts V8; only its request for block coverage is
 * turned off, while it starts, and only when no report needs blocks.
 */
export async function startFunctionCoverage(start: () => unknown): Promise<unknown> {
  const sessions = await Promise.all([import('node:inspector/promises'), import('node:inspector')])
  const prototypes = sessions.map(module => (module.default ?? module).Session.prototype as { post: (...args: any[]) => unknown })
  const posts = prototypes.map(prototype => prototype.post)
  prototypes.forEach((prototype, index) => {
    const post = posts[index]
    prototype.post = function (this: unknown, method: string, params?: object, ...rest: unknown[]) {
      return post.call(this, method, method === 'Profiler.startPreciseCoverage' ? { ...params, detailed: false } : params, ...rest)
    }
  })
  try {
    return await start()
  }
  finally {
    prototypes.forEach((prototype, index) => {
      prototype.post = posts[index]
    })
  }
}

const mod: CoverageProviderModule = {
  async startCoverage(options) {
    const v8Module = await v8()
    return process.env[FUNCTION_COVERAGE_ENV] === '1'
      ? startFunctionCoverage(() => v8Module.startCoverage?.(options))
      : v8Module.startCoverage?.(options)
  },
  async takeCoverage(options) {
    return (await v8()).takeCoverage?.(options)
  },
  async stopCoverage(options) {
    return (await v8()).stopCoverage?.(options)
  },
  getProvider(): CoverageProvider {
    return new FasterCoverageProvider()
  },
}

export default mod

/**
 * The node-side hook that receives worker coverage. It records FASTER's
 * function data and delegates reporting to the V8 provider whenever the fork
 * would create one.
 */
class FasterCoverageProvider implements CoverageProvider {
  name = 'v8'
  private vitest!: Vitest
  private host: any
  private inner: CoverageProvider | undefined
  private filesDirectory: string | undefined

  async initialize(vitest: Vitest): Promise<void> {
    this.vitest = vitest
    this.host = (globalThis as any)[REGISTRY]?.get(vitest)
    const role = this.host?.coverage
    // Optimization C1: when FASTER alone enables coverage, the report pipeline is not created.
    const reportless = role?.ownsCoverage
      && !(vitest as any).configOverride?.coverage
      && vitest.projects.every(project => !project.isBrowserEnabled())
    const env: Record<string, string> = ((vitest.config as any).env ??= {})
    if (role && (!role.rootEnabled || reportless)) {
      env[FUNCTION_COVERAGE_ENV] = '1'
      // Vitest 5 workers write coverage files here; the V8 provider would create it.
      const coverage: any = vitest.config.coverage
      const shard = vitest.config.shard
      this.filesDirectory = resolve(vitest.config.root, coverage.reportsDirectory, `.tmp${shard ? `-${shard.index}-${shard.count}` : ''}`)
      return
    }
    delete env[FUNCTION_COVERAGE_ENV]
    const v8Module = await importV8Provider(vitest.config.root)
    this.inner = await v8Module.getProvider()
    await this.inner!.initialize(vitest)
  }

  resolveOptions(): any {
    return this.inner ? this.inner.resolveOptions() : this.vitest.config.coverage
  }

  async clean(clean?: boolean): Promise<void> {
    if (this.filesDirectory) {
      await rm(this.filesDirectory, { recursive: true, force: true })
      await mkdir(this.filesDirectory, { recursive: true })
    }
    await this.inner?.clean(clean)
  }

  async onAfterSuiteRun(meta: any): Promise<void> {
    this.host?.recordCoverage(meta)
    if (this.inner) {
      await this.inner.onAfterSuiteRun(meta)
    }
    else if (typeof meta.coverage === 'string') {
      await rm(meta.coverage, { force: true })
    }
  }

  async onTestRunStart(): Promise<void> {
    await this.inner?.onTestRunStart?.()
  }

  async onTestFailure(): Promise<void> {
    await this.inner?.onTestFailure?.()
  }

  async onEnabled(): Promise<void> {
    await this.inner?.onEnabled?.()
  }

  async generateCoverage(context: any): Promise<any> {
    return this.inner?.generateCoverage(context)
  }

  async reportCoverage(coverage: any, context: any): Promise<void> {
    await this.inner?.reportCoverage(coverage, context)
  }

  async mergeReports(coverages: any[]): Promise<void> {
    await this.inner?.mergeReports?.(coverages)
  }
}
