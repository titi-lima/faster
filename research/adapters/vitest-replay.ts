import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { createVitest } from 'vitest/node'
import { getTestSourceChanges } from '../../packages/vitest/src/node/faster/sourceChanges'
import { FasterSequencer } from '../../packages/vitest/src/node/sequencers/FasterSequencer'

async function main() {
  const root = process.env.FASTER_REPLICATION_ROOT!
  const output = process.env.FASTER_RESEARCH_OUTPUT!
  const ctx = await createVitest('test', {
    root,
    config: new URL('./vitest.config.ts', import.meta.url).pathname,
    watch: false,
  })
  try {
    const specs = (await ctx.globTestSpecifications()).sort((a, b) => a.moduleId.localeCompare(b.moduleId))
    const changes = await getTestSourceChanges(ctx, specs)
    const files = specs.map((spec) => {
      const id = relative(root, spec.moduleId)
      const change = changes.get(spec)!
      const prior = ctx.cache.getFileTestResults(`${spec.project.name}:${id}`)
      return { id, bytes: statSync(spec.moduleId).size, duration: prior?.duration, failed: Boolean(prior?.failed), known: change.known, testChanged: change.testChanged, affected: change.changed }
    })
    const selected = new Set(files.filter(f => f.failed || !f.known || f.testChanged || f.affected).map(f => f.id))
    const sequencer = new FasterSequencer(ctx)
    const fullOrder = (await sequencer.sort(specs)).map(s => relative(root, s.moduleId))
    const selectedOrder = (await sequencer.sort(specs.filter(s => selected.has(relative(root, s.moduleId)))))
      .map(s => relative(root, s.moduleId))
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(join(dirname(output), 'features.json'), `${JSON.stringify({
      files,
      selected: [...selected],
      fullOrder,
      selectedOrder,
      frozenUTC: new Date().toISOString(),
    }, null, 2)}\n`)
  }
  finally {
    await ctx.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
