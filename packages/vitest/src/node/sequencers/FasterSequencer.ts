import type { TestSpecification } from '../test-specification'
import { readFile } from 'node:fs/promises'
import { getSimilarityOrder } from '@vitest/runner/utils'
import { relative } from 'pathe'
import { GitNotFoundError } from '../errors'
import { findAffectedTestSpecifications } from '../faster/affectedTests'
import { BaseSequencer } from './BaseSequencer'

export class FasterSequencer extends BaseSequencer {
  public async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const baseline = await super.sort(files)
    const baselineIndex = new Map(baseline.map((file, index) => [file, index]))
    const affected = await this.findAffectedSpecifications(baseline)
    const priorities = getFilePriorities(baseline)
    const fallbackPriorities = await getFallbackFilePriorities(baseline, priorities)

    return baseline.sort((left, right) => {
      if (left.project !== right.project) {
        return baselineIndex.get(left)! - baselineIndex.get(right)!
      }

      const affectedDiff = Number(affected.has(right)) - Number(affected.has(left))
      if (affectedDiff !== 0) {
        return affectedDiff
      }

      const leftPriority = priorities.get(left)
      const rightPriority = priorities.get(right)

      if (leftPriority == null && rightPriority == null) {
        return fallbackPriorities.get(right)! - fallbackPriorities.get(left)!
          || baselineIndex.get(left)! - baselineIndex.get(right)!
      }
      if (leftPriority == null) {
        return 1
      }
      if (rightPriority == null) {
        return -1
      }
      return rightPriority - leftPriority
        || baselineIndex.get(left)! - baselineIndex.get(right)!
    })
  }

  private async findAffectedSpecifications(files: TestSpecification[]): Promise<Set<TestSpecification>> {
    const changed = this.ctx.config.faster.changed
    if (!changed) {
      return new Set()
    }
    if (this.ctx.config.changed || this.ctx.config.related) {
      return new Set(files)
    }

    try {
      const changedFiles = await this.ctx.vcs.findChangedFiles({
        root: this.ctx.config.root,
        changedSince: changed,
      })
      return findAffectedTestSpecifications(files, changedFiles)
    }
    catch (error) {
      if (error instanceof GitNotFoundError) {
        return new Set()
      }
      throw error
    }
  }
}

async function getFallbackFilePriorities(
  specifications: TestSpecification[],
  priorities: Map<TestSpecification, number | undefined>,
): Promise<Map<TestSpecification, number>> {
  const unscored = specifications.filter(specification => priorities.get(specification) == null)
  const sources = await Promise.all(unscored.map(async (specification) => {
    try {
      return await readFile(specification.moduleId, 'utf8')
    }
    catch {
      return specification.moduleId
    }
  }))
  const ordered = getSimilarityOrder(sources)
  return new Map(ordered.map((sourceIndex, orderIndex) => [
    unscored[sourceIndex],
    unscored.length - orderIndex,
  ]))
}

function getFilePriorities(specifications: TestSpecification[]): Map<TestSpecification, number | undefined> {
  const prioritiesByProject = new Map<TestSpecification['project'], Map<string, number>>()

  for (const specification of specifications) {
    const project = specification.project
    if (!prioritiesByProject.has(project)) {
      const filePriorities = new Map<string, number>()
      for (const [testId, priority] of Object.entries(project.config.faster.priorities)) {
        const separator = testId.indexOf('::')
        const filepath = separator === -1 ? testId : testId.slice(0, separator)
        const current = filePriorities.get(filepath)
        if (current == null || priority > current) {
          filePriorities.set(filepath, priority)
        }
      }
      prioritiesByProject.set(project, filePriorities)
    }
  }

  return new Map(specifications.map((specification: TestSpecification): [TestSpecification, number | undefined] => {
    const filepath = relative(specification.project.config.root, specification.moduleId).replaceAll('\\', '/')
    return [specification, prioritiesByProject.get(specification.project)?.get(filepath)]
  }))
}
