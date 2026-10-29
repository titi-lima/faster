/** Single-project research adapter. Native Vitest uses FasterSequencer directly. */
import { readFile, writeFile } from 'node:fs/promises'
import { getApfdPriorityScores, getFasterPriorityBucket } from '../../packages/vitest/src/node/faster/apfdPriority'

interface Features {
  id: string
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
    if (!Number.isFinite(file.bytes) || file.bytes < 0
      || ['failed', 'known', 'testChanged', 'affected'].some(key => typeof file[key as keyof Features] !== 'boolean')) {
      throw new Error(`Invalid features for ${file.id}`)
    }
    if (file.duration != null && !Number.isFinite(file.duration)) {
      throw new Error(`Invalid prior duration for ${file.id}`)
    }
  }
  const indices = files.map((_, i) => i)
  const scores = getApfdPriorityScores(files)
  const bucket = (i: number) => getFasterPriorityBucket({
    failed: files[i].failed,
    direct: !files[i].known || files[i].testChanged,
    affected: files[i].affected,
  }, 'apfd')
  const order = [...indices].sort((a, b) => bucket(a) - bucket(b) || scores[b] - scores[a])
  const selected = new Set(indices.filter(i => files[i].failed || !files[i].known || files[i].testChanged || files[i].affected))
  await writeFile(output, `${JSON.stringify({
    order,
    selectedOrder: order.filter(i => selected.has(i)),
    buckets: indices.map(bucket),
    scores,
    frozenUTC: new Date().toISOString(),
  }, null, 2)}\n`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
