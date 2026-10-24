/** Single-project research adapter. Native Vitest uses FasterSequencer directly. */
import { readFile, writeFile } from 'node:fs/promises'
import { getSimilarityOrder } from '../../packages/runner/src/utils/priority'
import { getApfdPriorityScores } from '../../packages/vitest/src/node/faster/apfdPriority'

interface Features {
  id: string
  source: string
  bytes: number
  duration?: number
  failed: boolean
  known: boolean
  testChanged: boolean
  affected: boolean
}

async function main() {
  const [input, output] = process.argv.slice(2)
  if (!input || !output) {
    throw new Error('Usage: pnpm exec tsx research/adapters/order.ts FEATURES.json ORDERS.json')
  }
  const { files } = JSON.parse(await readFile(input, 'utf8')) as { files: Features[] }
  if (!files.length || new Set(files.map(f => f.id)).size !== files.length) {
    throw new Error('Expected a nonempty, unique test universe')
  }
  for (const file of files) {
    if (typeof file.source !== 'string' || !Number.isFinite(file.bytes) || file.bytes < 0
      || ['failed', 'known', 'testChanged', 'affected'].some(key => typeof file[key as keyof Features] !== 'boolean')) {
      throw new Error(`Invalid features for ${file.id}`)
    }
    if (file.duration != null && !Number.isFinite(file.duration)) {
      throw new Error(`Invalid prior duration for ${file.id}`)
    }
  }
  const indices = files.map((_, i) => i)
  const fastOrder = getSimilarityOrder(files.map(f => f.source))
  const scores = getApfdPriorityScores(files)
  const bucket = (i: number) => Number(!files[i].failed) * 3
    + (!files[i].known || files[i].testChanged ? 0 : files[i].affected ? 1 : 2)
  const order = [...fastOrder].sort((a, b) => bucket(a) - bucket(b) || scores[b] - scores[a])
  const selected = new Set(indices.filter(i => files[i].failed || !files[i].known || files[i].testChanged || files[i].affected))
  // Historical single-project comparator, retained to reproduce earlier studies.
  const baseline = [...indices].sort((a, b) => {
    const left = files[a]
    const right = files[b]
    if (!left.known || !right.known) {
      return right.bytes - left.bytes
    }
    return Number(right.failed) - Number(left.failed) || right.duration! - left.duration!
  })
  const oldOrder = files.some(f => f.known)
    ? [...baseline].sort((a, b) => Number(files[b].affected) - Number(files[a].affected))
    : getSimilarityOrder(baseline.map(i => files[i].source)).map(i => baseline[i])
  await writeFile(output, `${JSON.stringify({
    order,
    selectedOrder: order.filter(i => selected.has(i)),
    fastOrder,
    oldOrder,
    baseline,
    buckets: indices.map(bucket),
    scores,
    frozenUTC: new Date().toISOString(),
  }, null, 2)}\n`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
