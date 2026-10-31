import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Summarizes the Vitest main-process .cpuprofile of a replayed run: busy (non-idle) CPU time split into categories.
// A sample belongs to the first category whose frames appear on its synchronous stack, checked in the order below;
// async continuations lose their callers, so Vite work started by FASTER's capture counts as "vite transform".
// Usage: profile-summary.ts RUN_DIRECTORY [...] (each holding profile/*.cpuprofile and process.json)

interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
interface Profile { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number }

const categories: [string, (name: string, url: string) => boolean][] = [
  ['faster save', name => ['saveTestRunSourceSnapshots', 'collectFasterFunctionSnapshots', 'createFunctionModel', 'transformFunctionModel', 'indexFunctionRanges', 'recordFasterFunctionCoverage'].includes(name)],
  ['faster capture', name => ['captureTestRunSourceSnapshots', 'createTestRunSourceSnapshots', 'createSnapshot', 'getTestDependencies', 'addImports', 'resolveTrackedImports', 'readSnapshot'].includes(name)],
  ['faster state io', name => ['readState', 'writeState'].includes(name)],
  ['coverage report pipeline', (name, url) => /coverage-v8\/dist\/provider|istanbul|ast-v8-to-istanbul|magicast|test-exclude|picomatch/.test(url) || ['generateCoverage', 'readCoverageFiles', 'mergeProcessCovs', 'convertCoverage', 'onAfterSuiteRun', 'cleanAfterRun', 'reportCoverage'].includes(name)],
  ['vite transform', name => ['transformRequest', 'loadAndTransform', 'ssrTransformScript', 'ssrTransform', 'resolveId', 'transformWithEsbuild', 'combineSourcemaps'].includes(name)],
  ['module loading', name => ['makeSyncRequest', 'compileSourceTextModule', 'wrapSafe'].includes(name)],
  ['garbage collection', name => name === '(garbage collector)'],
]

export function summarize(directory: string) {
  const file = readdirSync(join(directory, 'profile')).filter(name => name.endsWith('.cpuprofile')).sort()[0]
  const profile = JSON.parse(readFileSync(join(directory, 'profile', file), 'utf8')) as Profile
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const parents = new Map<number, number>()
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) {
      parents.set(child, node.id)
    }
  }
  const busy: Record<string, number> = Object.fromEntries([...categories.map(([name]) => [name, 0]), ['other', 0]])
  let idle = 0
  profile.samples.forEach((id, index) => {
    const delta = (profile.timeDeltas[index] ?? 0) / 1000
    if (nodes.get(id)!.callFrame.functionName === '(idle)') {
      idle += delta
      return
    }
    const stack: ProfileNode['callFrame'][] = []
    for (let current: number | undefined = id; current != null; current = parents.get(current)) {
      stack.push(nodes.get(current)!.callFrame)
    }
    const category = categories.find(([, matches]) => stack.some(frame => matches(frame.functionName, frame.url)))?.[0] ?? 'other'
    busy[category] += delta
  })
  const timing = JSON.parse(readFileSync(join(directory, 'process.json'), 'utf8'))
  return {
    run: directory.split('/').slice(-1)[0],
    processMs: Math.round(timing.processMs),
    windows: Object.fromEntries(Object.entries(timing.windows ?? {}).map(([key, value]) => [key, Math.round(value as number)])),
    idleMs: Math.round(idle),
    busyMs: Math.round(Object.values(busy).reduce((sum, value) => sum + value, 0)),
    busyByCategoryMs: Object.fromEntries(Object.entries(busy).map(([key, value]) => [key, Math.round(value)])),
  }
}

if (process.argv[2]) {
  for (const directory of process.argv.slice(2)) {
    process.stdout.write(`${JSON.stringify(summarize(directory))}\n`)
  }
}
