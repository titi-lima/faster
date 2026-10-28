/** Replay recorded orders with/without FAST; timing covers ordering kernels only. */
import type { ApfdFileFeatures } from '../packages/vitest/src/node/faster/apfdPriority'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform } from 'node:os'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { gunzipSync } from 'node:zlib'
import { getSimilarityOrder } from '../packages/runner/src/utils/priority'
import { getApfdPriorityScores } from '../packages/vitest/src/node/faster/apfdPriority'

interface Feature extends ApfdFileFeatures {
  id: string
  path?: string
  source: string
  known: boolean
  failed: boolean
  testChanged: boolean
  affected: boolean
}
interface Case {
  cohort: string
  project: string
  case: string
  tests: string[]
  revealing: number[]
  policies: Record<string, number[][]>
  provenance: { result: string }
}
const [evidenceRoot, output] = process.argv.slice(2)
assert(evidenceRoot && output, 'Usage: node --import tsx research/fast-ablation.ts EVIDENCE_ROOT OUTPUT.json')
const sources: Record<string, string> = {}
function read(relative: string) {
  const raw = readFileSync(resolve(evidenceRoot, relative))
  sources[relative] = createHash('sha256').update(raw).digest('hex')
  return JSON.parse(raw.toString())
}
const cases: Case[] = gunzipSync(readFileSync(new URL('./data/cases.jsonl.gz', import.meta.url))).toString().trim().split('\n').map(s => JSON.parse(s))
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
function kernel(files: Feature[], objective: 'apfd' | 'dx', fast: boolean) {
  const order = fast ? getSimilarityOrder(files.map(f => f.source)) : files.map((_, i) => i)
  const scores = objective === 'apfd' ? getApfdPriorityScores(files) : files.map(() => 0)
  const buckets = files.map(f => objective === 'apfd'
    ? Number(!f.failed) * 3 + (!f.known || f.testChanged ? 0 : f.affected ? 1 : 2)
    : Number(!f.affected) * 2 + Number(!f.failed))
  order.sort((a, b) => buckets[a] - buckets[b] || scores[b] - scores[a])
  return { order, scores, buckets }
}
function timing(files: Feature[], objective: 'apfd' | 'dx') {
  for (let i = 0; i < 3; i++) {
    kernel(files, objective, true)
    kernel(files, objective, false)
  }
  const samples = { fast: [] as number[], fallback: [] as number[] }
  const cpu = { fast: [] as number[], fallback: [] as number[] }
  for (let i = 0; i < 15; i++) {
    for (const useFast of i % 2 ? [false, true] : [true, false]) {
      const name = useFast ? 'fast' : 'fallback'
      const start = performance.now()
      const before = process.cpuUsage()
      kernel(files, objective, useFast)
      const elapsed = process.cpuUsage(before)
      cpu[name].push((elapsed.user + elapsed.system) / 1000)
      samples[name].push(performance.now() - start)
    }
  }
  return { wallMedianMs: { fast: median(samples.fast), fallback: median(samples.fallback) }, cpuMedianMs: { fast: median(cpu.fast), fallback: median(cpu.fallback) }, repetitions: 15 }
}
function evaluate(order: number[], faults: Set<number>, fullN: number) {
  const position = order.findIndex(i => faults.has(i))
  const rank = position < 0 ? null : position + 1
  return { rank, APFDf: rank == null ? 0 : 1 - (rank - 0.5) / fullN }
}
const rows = []
function measure(c: Case, files: Feature[], selected: Set<number>, scope: 'selected' | 'full', objective: 'apfd' | 'dx', history: 'recorded' | 'cold') {
  const faults = new Set(c.revealing)
  const indices = files.flatMap((_, i) => scope === 'full' || c.cohort === 'java' || selected.has(i) ? [i] : [])
  const candidates = indices.map(i => files[i])
  const withFast = kernel(candidates, objective, true)
  const withoutFast = kernel(candidates, objective, false)
  const map = (order: number[]) => order.map(i => indices[i]).filter(i => scope === 'full' || selected.has(i))
  const fastOrder = map(withFast.order)
  const fallbackOrder = map(withoutFast.order)
  const recorded = scope === 'selected' ? c.policies.FASTER?.[0] : c.policies['FASTER full']?.[0]
  if (history === 'recorded' && objective === 'apfd' && recorded) {
    assert.deepEqual(fastOrder, recorded, `Recorded order differs: ${c.project}/${c.case}/${scope}`)
  }
  const groups = new Map<string, number[]>()
  candidates.forEach((_, i) => {
    if (scope === 'selected' && !selected.has(indices[i])) {
      return
    }
    const key = `${withFast.buckets[i]}:${withFast.scores[i]}`
    groups.set(key, [...(groups.get(key) || []), indices[i]])
  })
  const ties = [...groups.values()].filter(g => g.length > 1)
  if (!ties.length) {
    assert.deepEqual(fastOrder, fallbackOrder, 'FAST changed an order without an exact priority tie')
  }
  return { cohort: c.cohort, project: c.project, case: c.case, scope, objective, history, fullN: files.length, candidates: candidates.length, retained: fastOrder.length, recordedOrderVerified: history === 'recorded' && objective === 'apfd' && Boolean(recorded), tieGroups: ties.length, tiedCandidates: ties.reduce((n, g) => n + g.length, 0), revealingInTie: ties.some(g => g.some(i => faults.has(i))), changedOrder: JSON.stringify(fastOrder) !== JSON.stringify(fallbackOrder), fast: evaluate(fastOrder, faults, files.length), fallback: evaluate(fallbackOrder, faults, files.length), timing: timing(candidates, objective), fastOrder, fallbackOrder }
}
for (const c of cases) {
  let files: Feature[]
  if (c.cohort === 'java') {
    files = read(`${dirname(c.provenance.result)}/features.json`).files
  }
  else {
    const result = read(c.provenance.result)
    const current = read(`faster-function-selection-20261021/runs/${c.project}/${c.case}/features/features.json`)
    const source = read(`faster-external-validation-20261009/runs/${c.project}/${c.case}/apfd/features.json`)
    const byId = new Map<string, Feature>(source.files.map((f: Feature) => [f.id, f]))
    const cache = `faster-function-selection-20261021/controls/${c.project}/${result.mutation.revision.slice(0, 12)}/cache`
    const paths = readdirSync(resolve(evidenceRoot, cache), { recursive: true }).filter(p => String(p).endsWith('results.json'))
    assert.equal(paths.length, 1)
    const results = new Map<string, { duration: number; failed: boolean }>(read(`${cache}/${paths[0]}`).results)
    files = current.files.map((f: Feature) => {
      const previous = results.get(`${c.project}:${f.id}`)
      assert(previous, `Missing recorded duration for ${f.id}`)
      return { ...byId.get(f.id)!, ...f, duration: previous.duration, failed: previous.failed }
    })
  }
  assert.deepEqual(files.map(f => f.id), c.tests)
  const selected = new Set(files.flatMap((f, i) => f.failed || !f.known || f.testChanged || f.affected ? [i] : []))
  // Java filters a full-universe ranking. Vitest ranks the selected candidates.
  for (const scope of ['selected', 'full'] as const) {
    for (const objective of ['apfd', 'dx'] as const) {
      rows.push(measure(c, files, selected, scope, objective, 'recorded'))
    }
  }
  const cold = files.map(f => ({ ...f, known: false, failed: false, duration: undefined, testChanged: false, affected: false }))
  rows.push(measure(c, cold, new Set(cold.map((_, i) => i)), 'full', 'apfd', 'cold'))
}
mkdirSync(dirname(resolve(output)), { recursive: true })
writeFileSync(output, `${JSON.stringify({ node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, benchmarkSHA256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'), implementation: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), scope: 'Offline ordering ablation, not new native outcomes. Input decoding, source IO, coverage, dependency maintenance and test execution excluded from timings. JS full-suite, all DX and synthetic cold-start outcomes are counterfactual.', fallback: 'Recorded canonical input order; buckets, scores, selection and fault identities unchanged.', sources, rows }, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ cases: cases.length, rows: rows.length, recordedOrdersVerified: rows.filter(r => r.recordedOrderVerified).length, output })}\n`)
