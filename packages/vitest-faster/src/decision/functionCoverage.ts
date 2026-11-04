import type { Profiler } from 'node:inspector'
import type { AfterSuiteRunMeta } from '../shims/vitest'
import type { Vitest } from '../shims/vitest'
import type { TestProject } from '../shims/vitest'
import { fileURLToPath } from 'node:url'
import { relative, resolve } from 'pathe'
import { parseAstAsync } from 'vite'
import { getOrCreate } from './getOrCreate'
import { hash } from './hash'

interface Node {
  type: string
  start: number
  end: number
  body?: Node
  [key: string]: unknown
}

interface FunctionNode {
  id: string
  node: Node
  parent?: FunctionNode
  index: number
  children: FunctionNode[]
}

interface ScriptCoverage extends Profiler.ScriptCoverage {
  startOffset: number
}

/**
 * A module's functions as one environment transformed it, in the form it is
 * stored: the hash of its code outside function bodies (`shape`) and, for
 * each function in source order, its position in the syntax tree (`ids`,
 * front-coded, see `encodeIds`) and the hash of its body outside nested
 * functions (`hashes`, concatenated).
 */
export interface StoredFunctionModel {
  environment: string
  shape: string
  ids: string
  hashes: string
}

/** What one test file's last run observed of a module it loaded. */
export interface FunctionSnapshot {
  model: StoredFunctionModel
  /** One character per function of the model: `1` called, `0` not called, `-` unknown. */
  called: string
}

/** Characters of a function or shape hash: a 96-bit SHA-1 prefix in base64url. */
export const FUNCTION_HASH_LENGTH = 16

const CALLED = '1'
const NOT_CALLED = '0'
const CALL_UNKNOWN = '-'

/**
 * The first range of every function V8 reported for one script, as
 * `[start, end, called]` triples relative to the module code. FASTER reads
 * nothing else of the coverage, so the rest is dropped as it arrives.
 */
interface ScriptRanges {
  path: string
  ranges: Int32Array
}

interface TestCoverage {
  environment: string
  scripts: ScriptRanges[]
}

interface FunctionModel {
  shape: string
  functions: { id: string; end: number; bodyStart: number; parent: number; hash: string }[]
}

const coverageByRun = new WeakMap<Vitest, Map<string, TestCoverage[]>>()
const modelCache = new WeakMap<TestProject, Map<string, Promise<FunctionModel>>>()
const storedModels = new WeakMap<FunctionModel, StoredFunctionModel>()
const codeHashes = new WeakMap<object, { code: string; hash: string }>()
const modelIndexes = new WeakMap<StoredFunctionModel, Map<string, number>>()
/** Per project root, the path of each script URL V8 reports, relative to the root. */
const scriptPaths = new Map<string, Map<string, string>>()

export function resetFasterFunctionCoverage(vitest: Vitest): void {
  coverageByRun.set(vitest, new Map())
}

export function recordFasterFunctionCoverage(project: TestProject, meta: AfterSuiteRunMeta): void {
  if (!project.config.faster.enabled || project.isBrowserEnabled()) {
    return
  }
  const raw = meta.coverage as { result?: ScriptCoverage[] } | undefined
  const pending = coverageByRun.get(project.vitest)
  if (!pending || !Array.isArray(raw?.result) || project.vitest._coverageOptions.provider !== 'v8') {
    return
  }
  const coverage: TestCoverage = { environment: meta.environment, scripts: reduceScripts(project.config.root, raw.result) }
  for (const filename of meta.testFiles) {
    const key = `${project.name}:${resolve(project.config.root, filename)}`
    const entries = pending.get(key) || []
    entries.push(coverage)
    pending.set(key, entries)
  }
}

function reduceScripts(root: string, scripts: ScriptCoverage[]): ScriptRanges[] {
  const paths = getOrCreate(scriptPaths, root, () => new Map())
  const reduced: ScriptRanges[] = []
  for (const script of scripts) {
    if (!script.url.startsWith('file:')) {
      continue
    }
    const ranges = new Int32Array(script.functions.length * 3)
    let length = 0
    for (const value of script.functions) {
      const range = value.ranges[0]
      const start = range.startOffset - script.startOffset
      const end = range.endOffset - script.startOffset
      // Without a start offset no range matches a function, as before.
      if (Number.isInteger(start) && Number.isInteger(end)) {
        ranges[length++] = start
        ranges[length++] = end
        ranges[length++] = range.count > 0 ? 1 : 0
      }
    }
    reduced.push({
      path: getOrCreate(paths, script.url, () => relative(root, fileURLToPath(script.url))),
      ranges: length === ranges.length ? ranges : ranges.slice(0, length),
    })
  }
  return reduced
}

export async function createFunctionModel(code: string): Promise<FunctionModel> {
  code = code.replace(/(?:\r?\n\/\/[#@] ?sourceMapping(?:URL|Source)=[^\r\n]*)+(?:\r?\n)*$/, '').trimEnd()
  const ast = await parseAstAsync(code) as unknown as Node
  const roots: FunctionNode[] = []
  const functions: FunctionNode[] = []
  function visit(node: Node, path: string, parent?: FunctionNode) {
    if (!node || typeof node.type !== 'string') {
      return
    }
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type) && node.body) {
      const entry = { id: path, node, parent, index: functions.length, children: [] } as FunctionNode
      ;(parent ? parent.children : roots).push(entry)
      functions.push(entry)
      parent = entry
    }
    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value)) {
        value.forEach((child, index) => {
          if (child && typeof child === 'object' && 'type' in child) {
            visit(child as Node, `${path}.${key}[${index}]`, parent)
          }
        })
      }
      else if (value && typeof value === 'object' && 'type' in value) {
        visit(value as Node, `${path}.${key}`, parent)
      }
    }
  }
  visit(ast, 'module')
  const digest = (start: number, end: number, children: FunctionNode[]) => {
    let cursor = start
    const parts: string[] = []
    for (const child of children) {
      const body = child.node.body!
      parts.push(code.slice(cursor, body.start), '<function-body>')
      cursor = body.end
    }
    parts.push(code.slice(cursor, end))
    return hash('sha1', parts.join(''), 'base64url').slice(0, FUNCTION_HASH_LENGTH)
  }
  return {
    shape: digest(0, code.length, roots),
    functions: functions.map(entry => ({
      id: entry.id,
      end: entry.node.end,
      bodyStart: entry.node.body!.start,
      parent: entry.parent ? entry.parent.index : -1,
      hash: digest(entry.node.body!.start, entry.node.body!.end, entry.children),
    })),
  }
}

/**
 * Function snapshots of the modules one test file loaded in this run, for the
 * modules in its source snapshot. Models are shared by every test file that
 * loaded the same transform of a module.
 */
export async function collectFasterFunctionSnapshots(
  project: TestProject,
  moduleId: string,
  sources: Record<string, string>,
): Promise<Record<string, FunctionSnapshot>> {
  const captures = coverageByRun.get(project.vitest)?.get(`${project.name}:${resolve(moduleId)}`)
  const snapshots: Record<string, FunctionSnapshot> = Object.create(null)
  if (!captures?.length || !project.config.isolate || project.config.experimental.viteModuleRunner === false) {
    return snapshots
  }
  const scripts = new Map<string, { environment: string; values: Int32Array[] }>()
  for (const capture of captures) {
    for (const script of capture.scripts) {
      if (!Object.hasOwn(sources, script.path) || sources[script.path] === '<missing>') {
        continue
      }
      const entry = scripts.get(script.path) || { environment: capture.environment, values: [] }
      entry.values.push(script.ranges)
      scripts.set(script.path, entry)
    }
  }
  await Promise.all([...scripts].map(async ([path, capture]) => {
    try {
      const model = await transformFunctionModel(project, path, capture.environment)
      if (!model) {
        return
      }
      snapshots[path] = {
        model: getOrCreate(storedModels, model, () => ({
          environment: capture.environment,
          shape: model.shape,
          ids: encodeIds(model.functions.map(fn => fn.id)),
          hashes: model.functions.map(fn => fn.hash).join(''),
        })),
        called: observeCalls(model, capture.values),
      }
    }
    catch {}
  }))
  return snapshots
}

/**
 * A function counts as called when one of the ranges V8 reported for it was
 * executed. V8 omits functions it never compiled, which are uncalled when
 * their enclosing function was not called and unknown otherwise.
 */
function observeCalls(model: FunctionModel, values: Int32Array[]): string {
  if (!model.functions.length) {
    return ''
  }
  const ranges = indexFunctionRanges(values)
  const called: string[] = []
  for (const fn of model.functions) {
    let found = false
    let wasCalled = false
    for (const range of ranges.get(fn.end) || []) {
      if (range.start <= fn.bodyStart) {
        found = true
        wasCalled ||= range.called
      }
    }
    called.push(found
      ? wasCalled ? CALLED : NOT_CALLED
      : fn.parent >= 0 && called[fn.parent] === NOT_CALLED ? NOT_CALLED : CALL_UNKNOWN)
  }
  return called.join('')
}

export async function isFunctionDependencyAffected(
  project: TestProject,
  path: string,
  previous: FunctionSnapshot | undefined,
): Promise<boolean> {
  if (!previous || !project.config.isolate || project.isBrowserEnabled() || project.config.experimental.viteModuleRunner === false) {
    return true
  }
  try {
    const stored = previous.model
    const current = await transformFunctionModel(project, path, stored.environment)
    const count = stored.hashes.length / FUNCTION_HASH_LENGTH
    if (!current || current.shape !== stored.shape || current.functions.length !== count) {
      return true
    }
    const index = indexModel(stored, count)
    let changed = false
    for (const fn of current.functions) {
      const position = index.get(fn.id)
      if (position === undefined) {
        return true
      }
      if (!stored.hashes.startsWith(fn.hash, position * FUNCTION_HASH_LENGTH)) {
        changed = true
        if (previous.called[position] !== NOT_CALLED) {
          return true
        }
      }
    }
    return !changed
  }
  catch {
    return true
  }
}

/** Position of each function id in a stored model; empty when the ids are malformed, which makes every source affected. */
function indexModel(model: StoredFunctionModel, count: number): Map<string, number> {
  return getOrCreate(modelIndexes, model, () => {
    const ids = decodeIds(model.ids)
    return new Map(ids?.length === count ? ids.map((id, position) => [id, position]) : [])
  })
}

/**
 * Function ids are paths in the syntax tree listed in visiting order, so each
 * shares a long prefix with the one before. Each id is stored as the length
 * of that prefix in base 36, a colon and the rest, separated by spaces; ids
 * hold neither character.
 */
function encodeIds(ids: string[]): string {
  let previous = ''
  return ids.map((id) => {
    let shared = 0
    const limit = Math.min(id.length, previous.length)
    while (shared < limit && id.charCodeAt(shared) === previous.charCodeAt(shared)) {
      shared++
    }
    previous = id
    return `${shared.toString(36)}:${id.slice(shared)}`
  }).join(' ')
}

function decodeIds(encoded: string): string[] | undefined {
  if (!encoded) {
    return []
  }
  let previous = ''
  const ids: string[] = []
  for (const entry of encoded.split(' ')) {
    const separator = entry.indexOf(':')
    const shared = Number.parseInt(entry.slice(0, separator), 36)
    if (separator < 1 || !(shared <= previous.length)) {
      return undefined
    }
    previous = previous.slice(0, shared) + entry.slice(separator + 1)
    ids.push(previous)
  }
  return ids
}

/**
 * Groups the V8 function ranges of every captured script by their end offset
 * relative to the script start, the key the function model is matched on.
 */
function indexFunctionRanges(values: Int32Array[]) {
  const ranges = new Map<number, { start: number; called: boolean }[]>()
  for (const value of values) {
    for (let offset = 0; offset < value.length; offset += 3) {
      const end = value[offset + 1]
      const entries = ranges.get(end) || []
      entries.push({ start: value[offset], called: value[offset + 2] === 1 })
      ranges.set(end, entries)
    }
  }
  return ranges
}

async function transformFunctionModel(project: TestProject, path: string, environment: string): Promise<FunctionModel | undefined> {
  const result = await project.vite.environments[environment]?.transformRequest(resolve(project.config.root, path))
  if (!result) {
    return undefined
  }
  const cache = getOrCreate(modelCache, project, () => new Map<string, Promise<FunctionModel>>())
  // Fetching a module rewrites its transform result code in place, so the code is part of the memo.
  let digest = codeHashes.get(result)
  if (digest?.code !== result.code) {
    digest = { code: result.code, hash: hash('sha1', result.code, 'hex') }
    codeHashes.set(result, digest)
  }
  return getOrCreate(cache, `${environment}:${path}:${digest.hash}`, () => createFunctionModel(result.code))
}
