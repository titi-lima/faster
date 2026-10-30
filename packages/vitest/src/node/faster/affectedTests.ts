import type { TestProject } from '../project'
import type { TestSpecification } from '../test-specification'
import { existsSync } from 'node:fs'
import { join } from 'pathe'
import { isWindows } from '../../utils/env'

export async function findAffectedTestSpecifications(
  specifications: TestSpecification[],
  changedFiles: Iterable<string>,
): Promise<Set<TestSpecification>> {
  const changed = new Set(changedFiles)
  if (changed.size === 0) {
    return new Set()
  }

  const importCache: TestImportCache = new WeakMap()
  const testGraphs = await Promise.all(
    specifications.map(async (specification: TestSpecification): Promise<readonly [TestSpecification, Set<string>]> => [
      specification,
      await getTestDependencies(specification, new Set(), importCache),
    ] as const),
  )

  const affected = new Set<TestSpecification>()
  for (const [specification, dependencies] of testGraphs) {
    if (
      changed.has(specification.moduleId)
      || hasChangedDependency(dependencies, changed)
    ) {
      affected.add(specification)
    }
  }
  return affected
}

function hasChangedDependency(dependencies: Set<string>, changed: Set<string>): boolean {
  for (const dependency of dependencies) {
    if (changed.has(dependency)) {
      return true
    }
  }
  return false
}

/**
 * Tracked imports of each module, shared by the dependency walks of one run
 * so that every module is resolved once instead of once per test file.
 */
export type TestImportCache = WeakMap<TestProject, Map<string, Promise<string[]>>>

export async function getTestDependencies(
  specification: TestSpecification,
  dependencies: Set<string> = new Set(),
  importCache: TestImportCache = new WeakMap(),
): Promise<Set<string>> {
  const project = specification.project
  const imports = importCache.get(project) ?? new Map<string, Promise<string[]>>()
  importCache.set(project, imports)
  const addImports = async (filepath: string): Promise<void> => {
    if (dependencies.has(filepath)) {
      return
    }
    dependencies.add(filepath)
    let pending = imports.get(filepath)
    if (!pending) {
      pending = resolveTrackedImports(project, filepath)
      imports.set(filepath, pending)
    }
    const children = await pending
    await Promise.all(children.map(async (child) => {
      if (!dependencies.has(child)) {
        await addImports(child)
      }
    }))
  }

  await addImports(specification.moduleId)
  dependencies.delete(specification.moduleId)

  return dependencies
}

async function resolveTrackedImports(project: TestProject, filepath: string): Promise<string[]> {
  const environment = project.vite.environments.ssr
  const module = environment.moduleGraph.getModuleById(filepath)
  const transformed = module?.transformResult || await environment.transformRequest(filepath)
  if (!transformed) {
    return []
  }

  const imports = [...transformed.deps || [], ...transformed.dynamicDeps || []]
  return imports
    .map(dependency => dependency.startsWith('/@fs/')
      ? dependency.slice(isWindows ? 5 : 4)
      : join(project.config.root, dependency))
    .filter(filepath => !filepath.includes('node_modules') && existsSync(filepath))
}
