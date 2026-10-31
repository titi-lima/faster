import type { FasterOptions } from '../../vitest/src/node/faster/priorityManifest'
import { resolve } from 'pathe'

const BOOLEAN_KEYS = new Set(['enabled', 'selectAffected', 'immediateFailureOutput'])
const VALUE_KEYS = new Set(['optimizeFor', 'priorityFile'])
const OPTIONAL_VALUE_KEYS = new Set(['changed'])

/**
 * Upstream Vitest rejects unknown flags, so `vitest-faster` takes the fork's
 * `--faster.*` flags, hands them to the plugin and runs the project's own
 * Vitest CLI with the remaining arguments.
 */
export function extractFasterArguments(argv: string[]): { options: FasterOptions | undefined; rest: string[] } {
  const rest: string[] = []
  let options: FasterOptions | undefined
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const match = /^--(no-)?faster(?:\.([A-Za-z]+))?(?:=(.*))?$/.exec(argument)
    if (!match) {
      rest.push(argument)
      continue
    }
    const [, negated, key, inline] = match
    options ??= {}
    if (!key) {
      options.enabled = negated ? false : inline == null ? true : parseBoolean('faster', inline)
      continue
    }
    if (!BOOLEAN_KEYS.has(key) && !VALUE_KEYS.has(key) && !OPTIONAL_VALUE_KEYS.has(key)) {
      throw new TypeError(`Unknown option --faster.${key}`)
    }
    let value: string | boolean | undefined = inline
    if (negated) {
      value = false
    }
    else if (value == null && (VALUE_KEYS.has(key) || OPTIONAL_VALUE_KEYS.has(key)) && argv[index + 1] && !argv[index + 1].startsWith('-')) {
      value = argv[++index]
    }
    if (VALUE_KEYS.has(key)) {
      if (typeof value !== 'string') {
        throw new TypeError(`--faster.${key} requires a value`)
      }
      ;(options as any)[key] = key === 'priorityFile' ? resolve(value) : value
    }
    else if (BOOLEAN_KEYS.has(key)) {
      ;(options as any)[key] = value == null ? true : typeof value === 'boolean' ? value : parseBoolean(`faster.${key}`, value)
    }
    else {
      ;(options as any)[key] = value == null || value === 'true' ? true : value === 'false' ? false : value
    }
  }
  return { options, rest }
}

function parseBoolean(name: string, value: string): boolean {
  if (value === 'true' || value === '') {
    return true
  }
  if (value === 'false') {
    return false
  }
  throw new TypeError(`--${name} expects true or false, received "${value}"`)
}
