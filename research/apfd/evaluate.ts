import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { getApfdPriorityScores } from '../../packages/vitest/src/node/faster/apfdPriority'

interface Features {
  files: {
    id: string
    bytes: number
    duration: number | null
    failed: boolean
    known: boolean
    testChanged: boolean
    affected: boolean
  }[]
  fastOrder: number[]
}

interface Case {
  bug: number
  features: Features
  evaluation: {
    faults: number[]
    expectedOrder: number[]
    previousOrder: number[]
    selectedCount: number
    controls: Record<string, number[][]>
  }
}

// Accept only pre-execution features. Fault identities and historical outcome
// labels are kept in a separate object and used after this order is frozen.
function prioritize(features: Features): number[] {
  const scores = getApfdPriorityScores(features.files.map(file => ({
    bytes: file.bytes,
    duration: file.duration ?? undefined,
  })))
  const bucket = (index: number) => {
    const file = features.files[index]
    return Number(!file.failed) * 3 + (!file.known || file.testChanged ? 0 : file.affected ? 1 : 2)
  }
  return [...features.fastOrder].sort((left, right) => bucket(left) - bucket(right) || scores[right] - scores[left])
}

function verifyOrder(order: number[], size: number, full = false): void {
  assert.equal(new Set(order).size, order.length, 'Order contains duplicate files')
  assert(order.every(index => Number.isInteger(index) && index >= 0 && index < size), 'Order contains unknown files')
  if (full) {
    assert.equal(order.length, size, 'Order omits files')
  }
}

function firstFault(order: number[], faults: number[]): number | undefined {
  const index = order.findIndex(index => faults.includes(index))
  return index === -1 ? undefined : index + 1
}

function apfdf(order: number[], faults: number[], fullSize: number): number {
  const rank = firstFault(order, faults)
  return rank === undefined ? 0 : 1 - (rank - 0.5) / fullSize
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

async function main(): Promise<void> {
  const fixture = await readFile(new URL('./fixtures/jsoup-tuning.jsonl', import.meta.url))
  const provenance = JSON.parse(await readFile(new URL('./fixtures/provenance.json', import.meta.url), 'utf8'))
  assert.equal(createHash('sha256').update(fixture).digest('hex'), provenance.fixtureSHA256, 'Fixture integrity mismatch')
  const cases: Case[] = fixture.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(cases.length, provenance.cases)
  assert.equal(new Set(cases.map(row => row.bug)).size, cases.length)
  assert.equal(cases.reduce((count, row) => count + row.features.files.length, 0), provenance.testFileObservations)

  const frozen = cases.map((row) => {
    verifyOrder(row.features.fastOrder, row.features.files.length, true)
    const order = prioritize(row.features)
    verifyOrder(order, row.features.files.length, true)
    assert.deepEqual(order, row.evaluation.expectedOrder, `Jsoup-${row.bug}: policy changed the frozen order`)
    return order
  })

  const budgets = [0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1]
  const policies = ['APFD policy', 'Previous FASTER', ...Object.keys(cases[0].evaluation.controls)]
  const results = policies.map((policy) => {
    const scores: number[] = []
    const comparisons = { wins: 0, losses: 0, ties: 0 }
    const budgetDetection: number[][] = budgets.map(() => [])
    cases.forEach((row, index) => {
      const { evaluation, features } = row
      verifyOrder(evaluation.faults, features.files.length)
      assert(evaluation.faults.length > 0, 'A curated fault must have a confirmed revealing file')
      assert(Number.isInteger(evaluation.selectedCount) && evaluation.selectedCount > 0 && evaluation.selectedCount <= features.files.length)
      const orders = policy === 'APFD policy' ? [frozen[index]] : policy === 'Previous FASTER' ? [evaluation.previousOrder] : evaluation.controls[policy]
      assert(orders.length > 0, 'Missing control repetitions')
      orders.forEach(order => verifyOrder(order, features.files.length, policy === 'Previous FASTER'))
      const score = mean(orders.map(order => apfdf(order, evaluation.faults, features.files.length)))
      scores.push(score)
      const delta = apfdf(frozen[index], evaluation.faults, features.files.length) - score
      comparisons[delta > 1e-12 ? 'wins' : delta < -1e-12 ? 'losses' : 'ties']++
      budgets.forEach((budget, budgetIndex) => {
        const count = Math.floor(evaluation.selectedCount * budget)
        budgetDetection[budgetIndex].push(mean(orders.map(order => Number(firstFault(order.slice(0, count), evaluation.faults) !== undefined))))
      })
    })
    return {
      policy,
      meanAPFDf: mean(scores),
      newPolicyComparison: comparisons,
      budgets: budgets.map((budget, index) => ({ budget, meanDetectionProbability: mean(budgetDetection[index]) })),
    }
  })

  process.stdout.write(`${JSON.stringify({
    scope: '93 Jsoup tuning cases; ordering replay, not a new execution or independent holdout',
    cases: cases.length,
    allFrozenOrdersMatch: true,
    results,
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
