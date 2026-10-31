import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'pathe'

/**
 * Loads `@vitest/coverage-v8` from the Vitest installation that runs the
 * tests, the same module Vitest itself imports for the built-in provider.
 */
export async function importV8Provider(root: string): Promise<any> {
  const fromRoot = createRequire(join(root, 'package.json'))
  let provider: string
  try {
    provider = createRequire(fromRoot.resolve('vitest/package.json')).resolve('@vitest/coverage-v8')
  }
  catch {
    provider = fromRoot.resolve('@vitest/coverage-v8')
  }
  return (await import(pathToFileURL(provider).href)).default
}
