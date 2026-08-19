import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function getExports(filepath) {
  const url = pathToFileURL(resolve(import.meta.dirname, filepath)).href
  const output = execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `console.log(JSON.stringify(Object.keys(await import(${JSON.stringify(url)})).sort()))`,
  ], { encoding: 'utf8' })
  return JSON.parse(output)
}

const fasterExports = getExports('../dist/index.js')
const vitestExports = getExports('../../vitest/dist/index.js')
const distRoot = resolve(import.meta.dirname, '../dist')

assert.deepEqual(
  fasterExports,
  vitestExports,
  'Faster must expose every Vitest root API export',
)

for (const filepath of findRuntimeFiles(distRoot)) {
  assert.doesNotMatch(
    readFileSync(filepath, 'utf8'),
    /(['"])@vitest\/runner(?:\/[^'"]+)?\1/,
    `Faster runtime must use its bundled runner: ${filepath}`,
  )
}

const runnerUtils = await import('../dist/_runner/utils.js')
assert.equal(typeof runnerUtils.getSimilarityOrder, 'function')

for (const entry of [
  'config',
  'coverage',
  'environments',
  'internal/browser',
  'node',
  'reporters',
  'runners',
  'runtime',
  'snapshot',
  'suite',
  'worker',
]) {
  await import(`faster/${entry}`)
}

console.log(`Faster API parity smoke passed (${fasterExports.length} root exports)`)

function findRuntimeFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filepath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...findRuntimeFiles(filepath))
    }
    else if (/\.(?:c|m)?js$/.test(entry.name)) {
      files.push(filepath)
    }
  }
  return files
}
