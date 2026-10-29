import type { Task } from '../types/tasks'
import { relative } from 'pathe'

export type TestPriorityMap = Record<string, number>

export function getTaskPriorityId(task: Task, root: string): string {
  const names: string[] = []
  let current: Task | undefined = task

  while (current && current !== current.file) {
    names.unshift(current.name)
    current = current.suite
  }

  const filepath = relative(root, task.file.filepath).replaceAll('\\', '/')
  return [filepath, ...names].join('::')
}

export function getTaskPriority(
  task: Task,
  root: string,
  priorities: TestPriorityMap,
): number | undefined {
  if (task.type === 'test') {
    return priorities[getTaskPriorityId(task, root)]
  }

  let highest: number | undefined
  for (const child of task.tasks) {
    const priority = getTaskPriority(child, root, priorities)
    if (priority != null && (highest == null || priority > highest)) {
      highest = priority
    }
  }
  return highest
}

export function prioritizeTasks(
  tasks: Task[],
  root: string,
  priorities: TestPriorityMap | undefined,
): Task[] {
  if (!priorities) {
    return tasks
  }

  return tasks
    .map((task, index) => ({
      index,
      priority: getTaskPriority(task, root, priorities),
      task,
    }))
    .sort((left, right) => {
      if (left.priority == null && right.priority == null) {
        return left.index - right.index
      }
      if (left.priority == null) {
        return 1
      }
      if (right.priority == null) {
        return -1
      }
      return right.priority - left.priority || left.index - right.index
    })
    .map(({ task }) => task)
}
