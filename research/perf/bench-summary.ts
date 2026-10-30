import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

// Summarizes interleaved replay benchmarks. The unit is one (revision, pair) in which the old build, the new build
// and stock Vitest ran back to back in a seeded random order on the same restored checkout and cache.
// Usage: node --import tsx research/perf/bench-summary.ts SUBJECT=ROWS.json [SUBJECT=ROWS.json ...]

interface Timing { pair: number; arm: string; processMs: number; windows?: Record<string, number>; load1Before: number }
interface Unit { revision: string; pair: number; arms: Record<string, Timing> }

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function bootstrap(values: number[], seed: string, statistic = median, iterations = 10_000) {
  let state = Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16)
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  const estimates = Array.from({ length: iterations }, () => statistic(values.map(() => values[Math.floor(random() * values.length)]))).sort((a, b) => a - b)
  return [estimates[Math.floor(0.025 * iterations)], estimates[Math.floor(0.975 * iterations)]] as const
}

export function summarizeBench(subject: string, rows: { revision: string; bench?: Timing[] }[]) {
  const units: Unit[] = []
  for (const row of rows) {
    const byPair = new Map<number, Record<string, Timing>>()
    for (const timing of row.bench ?? []) {
      byPair.set(timing.pair, { ...byPair.get(timing.pair), [timing.arm]: timing })
    }
    for (const [pair, arms] of byPair) {
      if (arms.old && arms.new && arms.stock) {
        units.push({ revision: row.revision, pair, arms })
      }
    }
  }
  const arm = (name: string) => units.map(unit => unit.arms[name].processMs)
  const difference = units.map(unit => unit.arms.new.processMs - unit.arms.old.processMs)
  const overhead = (name: string) => units.map(unit => unit.arms[name].processMs / unit.arms.stock.processMs - 1)
  const windows = (name: string) => Object.fromEntries(['beforeFirstModuleMs', 'modulesMs', 'afterLastModuleMs'].map(key => [key, median(units.map(unit => unit.arms[name].windows?.[key] ?? Number.NaN))]))
  return {
    subject,
    units: units.length,
    revisions: new Set(units.map(unit => unit.revision)).size,
    medianMs: { stock: median(arm('stock')), old: median(arm('old')), new: median(arm('new')) },
    newMinusOldMs: { median: median(difference), interval95: bootstrap(difference, `${subject}:difference`), newFasterInUnits: difference.filter(value => value < 0).length },
    overheadVsStock: {
      old: { median: median(overhead('old')), interval95: bootstrap(overhead('old'), `${subject}:old`) },
      new: { median: median(overhead('new')), interval95: bootstrap(overhead('new'), `${subject}:new`) },
    },
    windowsMedianMs: { stock: windows('stock'), old: windows('old'), new: windows('new') },
    load1: { median: median(units.flatMap(unit => Object.values(unit.arms).map(timing => timing.load1Before))), max: Math.max(...units.flatMap(unit => Object.values(unit.arms).map(timing => timing.load1Before))) },
  }
}

if (process.argv[2]) {
  for (const argument of process.argv.slice(2)) {
    const [subject, path] = argument.split('=')
    process.stdout.write(`${JSON.stringify(summarizeBench(subject, JSON.parse(readFileSync(path, 'utf8'))), null, 2)}\n`)
  }
}
