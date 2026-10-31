import { resolve } from 'node:path'
import { createVitest } from 'vitest/node'
import { getTestDependencies } from '../../packages/vitest/src/node/faster/affectedTests'
import { captureTestRunSourceSnapshots } from '../../packages/vitest/src/node/faster/sourceChanges'

// Diagnostic: times FASTER's pre-run capture in a prepared replay checkout, split into dependency discovery
// (Vite SSR transforms) and hashing, and attributes transform time to each module.

async function main() {
  const root = resolve(process.argv[2])
  const config = process.argv[3] || undefined
  const ctx = await createVitest('test', {
    root,
    config: config === 'false' ? false : config,
    watch: false,
    cache: { dir: resolve(root, '.study-cache') },
    fileParallelism: false,
    maxWorkers: 1,
    pool: 'forks',
    typecheck: { enabled: false },
    faster: { changed: true, optimizeFor: 'apfd', selectAffected: false, immediateFailureOutput: false },
    ...(process.env.FASTER_STUDY_ISOLATE === 'true' ? { isolate: true } : {}),
    ...(process.env.FASTER_STUDY_TEST_PROJECTS ? { project: JSON.parse(process.env.FASTER_STUDY_TEST_PROJECTS) } : {}),
  })
  try {
    const specs = await ctx.globTestSpecifications()
    const perModule = new Map<string, number>()
    for (const project of ctx.projects) {
      const environment = project.vite.environments.ssr
      const original = environment.transformRequest.bind(environment)
      environment.transformRequest = async (url: string) => {
        const started = performance.now()
        try {
          return await original(url)
        }
        finally {
          perModule.set(url, (perModule.get(url) ?? 0) + performance.now() - started)
        }
      }
    }
    let started = performance.now()
    await Promise.all(specs.map(spec => getTestDependencies(spec)))
    const graphMs = performance.now() - started
    started = performance.now()
    await Promise.all(specs.map(spec => getTestDependencies(spec)))
    const warmGraphMs = performance.now() - started
    started = performance.now()
    const snapshots = await captureTestRunSourceSnapshots(ctx, specs)
    const warmCaptureMs = performance.now() - started
    const sequential = async (filter: (url: string) => boolean) => {
      let total = 0
      for (const project of ctx.projects) {
        const environment = project.vite.environments.ssr
        for (const module of [...environment.moduleGraph.idToModuleMap.values()].filter(m => m.file && filter(m.file))) {
          environment.moduleGraph.invalidateModule(module)
          const begin = performance.now()
          await environment.transformRequest(module.url)
          total += performance.now() - begin
        }
      }
      return total
    }
    const forkSequentialMs = await sequential(file => /\/packages\/[a-z-]+\/dist\//.test(file))
    const subjectSequentialMs = await sequential(file => !/\/packages\/[a-z-]+\/dist\//.test(file) && !file.includes('node_modules'))
    const fork = [...perModule].filter(([url]) => /\/packages\/[a-z-]+\/dist\//.test(url))
    process.stdout.write(`${JSON.stringify({
      specs: specs.length,
      snapshots: snapshots.size,
      graphMs,
      warmGraphMs,
      warmCaptureMs,
      transformedModules: perModule.size,
      forkDistModules: fork.length,
      forkSequentialMs,
      subjectSequentialMs,
    }, null, 2)}\n`)
  }
  finally {
    await ctx.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
