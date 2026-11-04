import { linkSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { FasterResults } from '../../../packages/vitest-faster/src/results'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createResults(files: number) {
  const root = mkdtempSync(join(tmpdir(), 'vitest-faster-results-'))
  roots.push(root)
  const cacheDir = join(root, 'cache')
  const results = new FasterResults()
  results.configure(root, cacheDir)
  results.update(Array.from({ length: files }, (_, index) => ({
    projectName: 'project',
    filepath: join(root, `src/file-${index}.test.ts`),
    result: { state: 'pass', duration: index },
  }) as any))
  return { results, path: join(cacheDir, 'faster-results.json') }
}

test('replaces faster-results.json instead of rewriting the file other processes may be reading', async () => {
  const { results, path } = createResults(10)
  await results.write()
  const before = readFileSync(path, 'utf8')
  const openedByAnotherProcess = `${path}.reader`
  linkSync(path, openedByAnotherProcess)

  results.update([{ projectName: 'project', filepath: '/new.test.ts', result: { state: 'fail', duration: 1 } } as any])
  await results.write()

  expect(readFileSync(openedByAnotherProcess, 'utf8')).toBe(before)
  expect(readFileSync(path, 'utf8')).not.toBe(before)
})

test('readers never see a partially written faster-results.json', async () => {
  const { results, path } = createResults(6000)
  await results.write()
  let unreadable = 0
  for (let round = 0; round < 200; round++) {
    const [, contents] = await Promise.all([results.write(), readFile(path, 'utf8')])
    try {
      JSON.parse(contents)
    }
    catch {
      unreadable++
    }
  }
  expect(unreadable).toBe(0)
})

test('forgets a deleted test file, which Vitest reports by absolute path', () => {
  const { results } = createResults(3)
  const root = roots.at(-1)!
  results.remove(join(root, 'src/file-1.test.ts'))
  expect(['src/file-0.test.ts', 'src/file-1.test.ts', 'src/file-2.test.ts'].map(file => results.get(`project:${file}`)?.duration)).toEqual([0, undefined, 2])
})
