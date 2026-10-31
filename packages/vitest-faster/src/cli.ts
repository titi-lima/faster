#!/usr/bin/env node
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'pathe'
import { extractFasterArguments } from './args'

async function main(): Promise<void> {
  const { options, rest } = extractFasterArguments(process.argv.slice(2))
  if (options) {
    process.env.VITEST_FASTER_OPTIONS = JSON.stringify(options)
  }
  const require = createRequire(join(process.cwd(), 'package.json'))
  const vitestPackage = require.resolve('vitest/package.json')
  const bin = join(dirname(vitestPackage), 'vitest.mjs')
  process.argv = [process.argv[0], bin, ...rest]
  await import(pathToFileURL(bin).href)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
