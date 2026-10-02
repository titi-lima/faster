import { basename } from 'node:path'
import { expect, test } from 'vitest'
import { getTestSourceChanges } from '../../../packages/vitest/src/node/faster/sourceChanges'
import { runInlineTests, runVitest } from '../../test-utils'

test('distinguishes dependency edits, direct edits, new files and reverts using real snapshots', async () => {
  const files = {
    'src/value.ts': 'export const value = 1',
    'a.test.ts': `import { test } from 'vitest'; test('unchanged', () => {})`,
    'b.test.ts': `import { test } from 'vitest'; import { value } from './src/value'; test('tracked', () => value)`,
  }
  const options = { cache: { dir: 'node_modules/.vite' }, faster: { changed: true }, fileParallelism: false, maxWorkers: 1 }
  const first = await runInlineTests(files, options)
  const specifications = await first.ctx!.globTestSpecifications()
  await first.ctx!.close()
  const changes = async () => Object.fromEntries([...await getTestSourceChanges(first.ctx!, specifications)]
    .map(([file, change]) => [basename(file.moduleId), change]))
  expect(await changes()).toEqual({
    'a.test.ts': { known: true, changed: false, testChanged: false, changedDependencies: 0 },
    'b.test.ts': { known: true, changed: false, testChanged: false, changedDependencies: 0 },
  })
  first.fs.editFile('src/value.ts', () => 'export const value = 2')
  expect((await changes())['b.test.ts']).toEqual({ known: true, changed: true, testChanged: false, changedDependencies: 1 })
  first.fs.editFile('b.test.ts', source => `${source}\n// direct edit\n`)
  expect((await changes())['b.test.ts']).toEqual({ known: true, changed: true, testChanged: true, changedDependencies: 1 })
  first.fs.createFile('c.test.ts', `import { test } from 'vitest'; test('new', () => {})`)
  specifications.push(first.ctx!.projects[0].createSpecification(first.fs.resolveFile('c.test.ts'), undefined, specifications[0].pool))
  expect((await changes())['c.test.ts']).toEqual({ known: false, changed: false, testChanged: false, changedDependencies: 0 })
  const second = await runVitest({ ...options, root: first.root })
  await second.ctx!.close()
  first.fs.editFile('src/value.ts', () => files['src/value.ts'])
  first.fs.editFile('b.test.ts', () => files['b.test.ts'])
  expect((await changes())['b.test.ts']).toEqual({ known: true, changed: true, testChanged: true, changedDependencies: 1 })
})
