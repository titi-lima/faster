import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prioritizationScores } from '../javascript/mutant-apfd'

// Selection safety on the seeded-fault lane: for every revision with killed mutants, the frozen policy orders that
// the replayed builds produce must equal the recorded ones, so every mutant is detected by the same selected files
// at the same rank. Usage: mutant-equivalence.ts OUT.json STUDY=MUTANTS_DIR=REPLAY_DIR[,REPLAY_DIR] [...]
// (the first replay directory holding a revision is used)

interface Policy { id: string; order: string[] }

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const [output, ...lanes] = process.argv.slice(2)
const report: Record<string, unknown> = {}
for (const lane of lanes) {
  const [study, mutantsDir, replay] = lane.split('=')
  const builds = ['old', 'new']
  const rows: Record<string, unknown>[] = []
  let mutants = 0
  for (const row of json(join(mutantsDir, 'mutants.json')) as { revision: string; status: string; mutants: { id: string; status: string; killingFiles?: string[] }[] }[]) {
    const killed = row.mutants.filter(m => m.status === 'killed' && m.killingFiles?.length)
    if (row.status !== 'completed' || !killed.length) {
      continue
    }
    mutants += killed.length
    const recorded = json(join(study, 'revisions', row.revision, 'features/result.json')).policies as Policy[]
    const oracle = json(join(study, 'revisions', row.revision, 'oracle/result.json')) as { modules: { file: string; startedMs?: number; endedMs: number }[] }
    const durations = new Map(oracle.modules.map(m => [m.file, m.startedMs === undefined ? 0 : m.endedMs - m.startedMs]))
    const startup = Math.min(...oracle.modules.flatMap(m => m.startedMs ?? []))
    const stock = recorded.find(p => p.id === 'vitest-stock')!.order
    const outcome = (policies: Policy[]) => Object.fromEntries(policies.map(policy => [policy.id, killed.map((mutant) => {
      const selected = new Set(policy.order)
      return { mutant: mutant.id, detected: mutant.killingFiles!.some(file => selected.has(file)), ...prioritizationScores(policy.order, stock, [mutant.killingFiles!], durations, startup) }
    })]))
    const expected = JSON.stringify(outcome(recorded))
    const result: Record<string, unknown> = { revision: row.revision, mutants: killed.length }
    for (const build of builds) {
      const path = replay.split(',').map(directory => join(directory, 'revisions', row.revision, `features-${build}`, 'result.json')).find(existsSync) ?? ''
      if (!existsSync(path)) {
        result[build] = 'missing'
        continue
      }
      const policies = json(path).policies as Policy[]
      result[build] = {
        ordersIdentical: JSON.stringify(policies) === JSON.stringify(recorded),
        detectionAndScoresIdentical: JSON.stringify(outcome(policies)) === expected,
        selectedFiles: policies.find(p => p.id === 'faster-selected')!.order.length,
        fasterSelectedDetects: outcome(policies)['faster-selected'].filter(m => m.detected).length,
      }
    }
    rows.push(result)
  }
  report[study] = {
    revisionsWithKilledMutants: rows.length,
    killedMutants: mutants,
    mismatches: rows.filter(row => builds.some(build => typeof row[build] !== 'object' || !(row[build] as { ordersIdentical: boolean }).ordersIdentical || !(row[build] as { detectionAndScoresIdentical: boolean }).detectionAndScoresIdentical)).length,
    rows,
  }
}
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
