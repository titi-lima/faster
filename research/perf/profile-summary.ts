import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Summarizes V8 .cpuprofile files: wall-clock span, idle share, top self-time functions and the time whose
// synchronous stack passes through each FASTER entry point (async continuations are attributed to their own frames).

interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
interface Profile { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number }

const markers = [
  'captureTestRunSourceSnapshots',
  'saveTestRunSourceSnapshots',
  'getTestDependencies',
  'readSnapshot',
  'collectFasterFunctionSnapshots',
  'createFunctionModel',
  'transformFunctionModel',
  'recordFasterFunctionCoverage',
  'isFunctionDependencyAffected',
  'getTestSourceChanges',
  'onAfterSuiteRun',
  'generateCoverage',
  'reportCoverage',
  'transformRequest',
  'parseAstAsync',
  'hash',
]

export function summarize(file: string, top = 25) {
  const profile = JSON.parse(readFileSync(file, 'utf8')) as Profile
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const parents = new Map<number, number>()
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) {
      parents.set(child, node.id)
    }
  }
  const self = new Map<string, number>()
  const through = new Map<string, number>()
  let idle = 0
  let total = 0
  profile.samples.forEach((id, index) => {
    const delta = (profile.timeDeltas[index] ?? 0) / 1000
    total += delta
    const node = nodes.get(id)!
    const name = node.callFrame.functionName || '(anonymous)'
    if (['(idle)', '(program)', '(garbage collector)'].includes(name)) {
      if (name === '(idle)') {
        idle += delta
      }
    }
    const key = `${name} ${node.callFrame.url.replace(/^.*\/(node_modules|packages)\//, '$1/')}:${node.callFrame.lineNumber}`
    self.set(key, (self.get(key) ?? 0) + delta)
    const seen = new Set<string>()
    for (let current: number | undefined = id; current != null; current = parents.get(current)) {
      const frame = nodes.get(current)!.callFrame.functionName
      if (markers.includes(frame) && !seen.has(frame)) {
        seen.add(frame)
        through.set(frame, (through.get(frame) ?? 0) + delta)
      }
    }
  })
  return {
    file,
    wallMs: (profile.endTime - profile.startTime) / 1000,
    sampledMs: total,
    idleMs: idle,
    through: Object.fromEntries([...through].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v)])),
    self: [...self].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => `${Math.round(v)}ms ${k}`),
  }
}

if (process.argv[2]) {
  for (const directory of process.argv.slice(2)) {
    for (const file of readdirSync(directory).filter(name => name.endsWith('.cpuprofile'))) {
      process.stdout.write(`${JSON.stringify(summarize(join(directory, file)), null, 2)}\n`)
    }
  }
}
