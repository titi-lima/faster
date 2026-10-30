import type { Profiler } from 'node:inspector'
import type { AfterSuiteRunMeta } from '../../types/general'
import type { Vitest } from '../core'
import type { TestProject } from '../project'
import { fileURLToPath } from 'node:url'
import { relative, resolve } from 'pathe'
import { parseAstAsync } from 'vite'
import { hash } from '../hash'

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
  children: FunctionNode[]
}

interface ScriptCoverage extends Profiler.ScriptCoverage {
  startOffset: number
}

export interface FunctionSnapshot {
  sourceHash: string
  environment: string
  shape: string
  functions: Record<string, { hash: string; called: boolean | null }>
}

interface TestCoverage {
  environment: string
  scripts: ScriptCoverage[]
}

interface FunctionModel {
  shape: string
  functions: { id: string; start: number; end: number; bodyStart: number; parent?: string; hash: string }[]
}

const coverageByRun = new WeakMap<Vitest, Map<string, TestCoverage[]>>()
const modelCache = new WeakMap<TestProject, Map<string, Promise<FunctionModel>>>()
const codeHashes = new WeakMap<object, { code: string; hash: string }>()

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
  for (const filename of meta.testFiles) {
    const key = `${project.name}:${resolve(project.config.root, filename)}`
    const entries = pending.get(key) || []
    entries.push({ environment: meta.environment, scripts: raw.result })
    pending.set(key, entries)
  }
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
      const entry = { id: path, node, parent, children: [] } as FunctionNode
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
    return hash('sha1', parts.join(''), 'hex')
  }
  return {
    shape: digest(0, code.length, roots),
    functions: functions.map(entry => ({
      id: entry.id,
      start: entry.node.start,
      end: entry.node.end,
      bodyStart: entry.node.body!.start,
      parent: entry.parent?.id,
      hash: digest(entry.node.body!.start, entry.node.body!.end, entry.children),
    })),
  }
}

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
  const scripts = new Map<string, { environment: string; values: ScriptCoverage[] }>()
  for (const capture of captures) {
    for (const script of capture.scripts) {
      if (!script.url.startsWith('file:')) {
        continue
      }
      const path = relative(project.config.root, fileURLToPath(script.url))
      if (!Object.hasOwn(sources, path) || sources[path] === '<missing>') {
        continue
      }
      const entry = scripts.get(path) || { environment: capture.environment, values: [] }
      entry.values.push(script)
      scripts.set(path, entry)
    }
  }
  await Promise.all([...scripts].map(async ([path, capture]) => {
    try {
      const model = await transformFunctionModel(project, path, capture.environment)
      if (!model) {
        return
      }
      const called: Record<string, boolean | null> = Object.create(null)
      const ranges = model.functions.length ? indexFunctionRanges(capture.values) : undefined
      for (const fn of model.functions) {
        const matches = (ranges!.get(fn.end) || []).filter(range => range.start <= fn.bodyStart)
        called[fn.id] = matches.length ? matches.some(range => range.called) : fn.parent && called[fn.parent] === false ? false : null
      }
      snapshots[path] = {
        sourceHash: sources[path],
        environment: capture.environment,
        shape: model.shape,
        functions: Object.fromEntries(model.functions.map(fn => [fn.id, { hash: fn.hash, called: called[fn.id] }])),
      }
    }
    catch {}
  }))
  return snapshots
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
    const current = await transformFunctionModel(project, path, previous.environment)
    if (!current || current.shape !== previous.shape || current.functions.length !== Object.keys(previous.functions).length) {
      return true
    }
    let changed = false
    for (const fn of current.functions) {
      const old = previous.functions[fn.id]
      if (!old) {
        return true
      }
      if (fn.hash !== old.hash) {
        changed = true
        if (old.called !== false) {
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

/**
 * Groups the V8 function ranges of every captured script by their end offset
 * relative to the script start, the key the function model is matched on.
 */
function indexFunctionRanges(scripts: ScriptCoverage[]) {
  const ranges = new Map<number, { start: number; called: boolean }[]>()
  for (const script of scripts) {
    for (const value of script.functions) {
      const end = value.ranges[0].endOffset - script.startOffset
      const entries = ranges.get(end) || []
      entries.push({ start: value.ranges[0].startOffset - script.startOffset, called: value.ranges[0].count > 0 })
      ranges.set(end, entries)
    }
  }
  return ranges
}

async function transformFunctionModel(project: TestProject, path: string, environment: string) {
  const result = await project.vite.environments[environment]?.transformRequest(resolve(project.config.root, path))
  if (!result) {
    return undefined
  }
  let cache = modelCache.get(project)
  if (!cache) {
    cache = new Map()
    modelCache.set(project, cache)
  }
  // Fetching a module rewrites its transform result code in place, so the code is part of the memo.
  let digest = codeHashes.get(result)
  if (digest?.code !== result.code) {
    digest = { code: result.code, hash: hash('sha1', result.code, 'hex') }
    codeHashes.set(result, digest)
  }
  const key = `${environment}:${path}:${digest.hash}`
  if (!cache.has(key)) {
    cache.set(key, createFunctionModel(result.code))
  }
  return cache.get(key)
}

export function isFunctionSnapshot(value: unknown): value is FunctionSnapshot {
  if (!value || typeof value !== 'object') {
    return false
  }
  const snapshot = value as FunctionSnapshot
  return typeof snapshot.environment === 'string'
    && typeof snapshot.shape === 'string' && /^[a-f\d]{40}$/.test(snapshot.shape)
    && typeof snapshot.sourceHash === 'string' && /^[a-f\d]{40}$/.test(snapshot.sourceHash)
    && Boolean(snapshot.functions) && typeof snapshot.functions === 'object' && !Array.isArray(snapshot.functions)
    && Object.values(snapshot.functions).every(fn => fn && /^[a-f\d]{40}$/.test(fn.hash) && [true, false, null].includes(fn.called))
}
