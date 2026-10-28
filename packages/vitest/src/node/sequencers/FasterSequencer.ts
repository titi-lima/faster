import type { FasterSourceChange } from '../faster/sourceChanges'
import type { TestSpecification } from '../test-specification'
import { stat } from 'node:fs/promises'
import { relative, resolve } from 'pathe'
import { GitNotFoundError } from '../errors'
import { findAffectedTestSpecifications } from '../faster/affectedTests'
import { getApfdPriorityScores, getFasterPriorityBucket } from '../faster/apfdPriority'
import { getTestSourceChanges } from '../faster/sourceChanges'
import { BaseSequencer } from './BaseSequencer'

interface SchedulingGroup {
  enabled: boolean
  files: TestSpecification[]
  buckets: TestSpecification[][]
}

export class FasterSequencer extends BaseSequencer {
  public async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    if (files.length < 2) {
      return [...files]
    }
    const specifications = [...files].sort(compareSpecifications)
    const enabled = specifications.filter(specification => specification.project.config.faster.enabled)
    if (!enabled.length) {
      return super.sort(specifications)
    }
    const [sizes, buckets] = await Promise.all([
      getFileSizes(enabled),
      this.getSchedulingBuckets(specifications),
    ])
    for (const specification of enabled) {
      buckets.bySpecification.get(specification)!.push(specification)
    }
    const producerPriorities = getFilePriorities(enabled)
    for (const group of buckets.groups) {
      if (!group.enabled) {
        group.buckets = [await super.sort(group.files)]
        continue
      }
      const scores = getApfdPriorityScores(group.files.map(specification => ({
        bytes: sizes.get(specification)!,
        duration: this.ctx.cache.getFileTestResults(getResultKey(this.ctx.config.root, specification))?.duration,
      })))
      const priorities = new Map(group.files.map((specification, index) => [specification, scores[index]]))
      for (const bucket of group.buckets) {
        bucket.sort((left, right) => comparePriorities(producerPriorities, left, right)
          || priorities.get(right)! - priorities.get(left)!)
      }
    }
    return buckets.groups.flatMap(group => group.buckets.flat())
  }

  private async getSchedulingBuckets(files: TestSpecification[]) {
    const tracked = files.filter(specification => specification.project.config.faster.enabled && specification.project.config.faster.changed)
    const changes = tracked.length
      ? await getTestSourceChanges(this.ctx, tracked)
      : new Map<TestSpecification, FasterSourceChange>()
    await this.includeRevisionChanges(tracked, changes)
    const groups: SchedulingGroup[] = []
    const bySpecification = new Map<TestSpecification, TestSpecification[]>()
    let previousProject: TestSpecification['project'] | undefined
    let group: SchedulingGroup
    for (const specification of files) {
      if (specification.project !== previousProject) {
        group = { enabled: specification.project.config.faster.enabled, files: [], buckets: Array.from({ length: 7 }, () => []) }
        groups.push(group)
        previousProject = specification.project
      }
      group!.files.push(specification)
      const key = getResultKey(this.ctx.config.root, specification)
      const failed = Boolean(this.ctx.cache.getFileTestResults(key)?.failed)
      const change = changes.get(specification)
      const changed = Boolean(change?.changed)
      const direct = Boolean(change && (!change.known || change.testChanged))
      const bucket = getFasterPriorityBucket({ failed, direct, affected: changed }, specification.project.config.faster.optimizeFor)
      bySpecification.set(specification, group!.buckets[bucket])
    }
    return { groups, bySpecification }
  }

  private async includeRevisionChanges(files: TestSpecification[], changes: Map<TestSpecification, FasterSourceChange>) {
    const revisions = new Map<string, TestSpecification[]>()
    for (const specification of files) {
      const revision = specification.project.config.faster.changed
      if (typeof revision === 'string') {
        const group = revisions.get(revision) || []
        group.push(specification)
        revisions.set(revision, group)
      }
    }
    for (const [revision, specifications] of revisions) {
      try {
        const paths = await this.ctx.vcs.findChangedFiles({ root: this.ctx.config.root, changedSince: revision })
        const changed = new Set(paths.map(path => resolve(path)))
        const affected = await findAffectedTestSpecifications(specifications, changed)
        for (const specification of specifications) {
          const change = changes.get(specification)!
          change.changed ||= affected.has(specification)
          change.testChanged ||= changed.has(resolve(specification.moduleId))
        }
      }
      catch (error) {
        if (!(error instanceof GitNotFoundError)) {
          throw error
        }
      }
    }
  }
}

function compareSpecifications(left: TestSpecification, right: TestSpecification): number {
  const groupOrder = left.project.config.sequence.groupOrder - right.project.config.sequence.groupOrder
  if (groupOrder !== 0) {
    return groupOrder
  }
  if (left.project.name !== right.project.name) {
    return left.project.name < right.project.name ? -1 : 1
  }
  const isolation = Number(right.project.config.isolate) - Number(left.project.config.isolate)
  return isolation || (left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : 0)
}

function getResultKey(root: string, specification: TestSpecification): string {
  return `${specification.project.name}:${relative(root, specification.moduleId)}`
}

async function getFileSizes(specifications: TestSpecification[]) {
  return new Map(await Promise.all(specifications.map(async specification => [
    specification,
    await stat(specification.moduleId).then(result => result.size, () => 0),
  ] as const)))
}

function comparePriorities(priorities: Map<TestSpecification, number | undefined>, left: TestSpecification, right: TestSpecification): number {
  const a = priorities.get(left)
  const b = priorities.get(right)
  if (a == null) {
    return b == null ? 0 : 1
  }
  return b == null ? -1 : b - a
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
