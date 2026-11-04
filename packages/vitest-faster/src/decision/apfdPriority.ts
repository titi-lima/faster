export interface ApfdFileFeatures {
  duration?: number
  bytes: number
}

const BREADTH_WEIGHT = 0.1

export function getFasterPriorityBucket(
  signals: { failed: boolean; direct: boolean; affected: boolean },
  objective: 'dx' | 'apfd',
): number {
  const category = signals.direct ? 0 : signals.affected ? 1 : 2
  if (objective === 'dx' && signals.failed && category === 2) {
    return 6
  }
  return Number(!signals.failed) * 3 + category
}

export function getApfdPriorityScores(files: ApfdFileFeatures[]): number[] {
  const durations = ranks(files.map(file => Number.isFinite(file.duration) ? Math.max(0, file.duration!) : 0))
  const breadth = ranks(files.map(file => file.bytes))
  return durations.map((duration, index) => duration + BREADTH_WEIGHT * breadth[index])
}

function ranks(values: number[]): number[] {
  const distinct = [...new Set(values)].sort((left, right) => left - right)
  const positions = new Map(distinct.map((value, index) => [value, index / Math.max(1, distinct.length - 1)]))
  return values.map(value => positions.get(value)!)
}
