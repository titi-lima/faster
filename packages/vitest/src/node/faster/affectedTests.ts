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

  const testGraphs = await Promise.all(
    specifications.map(async (specification: TestSpecification): Promise<readonly [TestSpecification, Set<string>]> => [
      specification,
      await getTestDependencies(specification),
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

export async function getTestDependencies(
  specification: TestSpecification,
  dependencies: Set<string> = new Set(),
): Promise<Set<string>> {
  const addImports = async (project: TestProject, filepath: string): Promise<void> => {
    if (dependencies.has(filepath)) {
      return
    }
    dependencies.add(filepath)

    const environment = project.vite.environments.ssr
    const module = environment.moduleGraph.getModuleById(filepath)
    const transformed = module?.transformResult || await environment.transformRequest(filepath)
    if (!transformed) {
      return
    }

    const imports = [...transformed.deps || [], ...transformed.dynamicDeps || []]
    await Promise.all(imports.map(async (dependency: string): Promise<void> => {
      const filepath = dependency.startsWith('/@fs/')
        ? dependency.slice(isWindows ? 5 : 4)
        : join(project.config.root, dependency)
      if (!filepath.includes('node_modules') && !dependencies.has(filepath) && existsSync(filepath)) {
        await addImports(project, filepath)
      }
    }))
  }

  await addImports(specification.project, specification.moduleId)
  dependencies.delete(specification.moduleId)

  return dependencies
}
