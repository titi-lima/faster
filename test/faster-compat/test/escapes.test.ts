import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { ESCAPES_META_KEY, TRUNCATED } from '../../../packages/vitest-faster/src/escapeRecord'
import { FasterEscapes } from '../../../packages/vitest-faster/src/escapes'
import { git, runVitest } from './repository'

const compat = resolve(import.meta.dirname, '..')
const cleanup: string[] = []

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createRepository(files: Record<string, string>) {
  const fixtures = join(compat, 'fixtures')
  mkdirSync(fixtures, { recursive: true })
  const root = mkdtempSync(join(fixtures, 'escapes-'))
  cleanup.push(root)
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  git(root, 'init', '-q')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'init')
  return root
}

async function runFaster(root: string, safety?: string, args: string[] = []): Promise<{ files: string[]; output: string }> {
  const { files, output } = await runVitest(root, { CI: '', VITEST_FASTER_OPTIONS: safety ? JSON.stringify({ safety }) : '' }, args)
  return { files, output: output.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>') }
}

function readEscapes(root: string): Record<string, unknown> {
  const cache = join(root, '.git/faster/node_modules/.vite/vitest')
  const [hash] = readdirSync(cache)
  const { tests } = JSON.parse(readFileSync(join(cache, hash, 'faster-escapes.json'), 'utf8'))
  return Object.fromEntries(tests)
}

function config(test: Record<string, unknown>) {
  return `import { faster } from 'vitest-faster'\nexport default { plugins: [faster({ selectAffected: true })], test: ${JSON.stringify({ maxWorkers: 1, globalSetup: './server.mjs', ...test })} }\n`
}

type Records = Record<string, { opaque: { kind: string; target: string }[]; reads: Record<string, string> }>

function summarize(records: Records) {
  return Object.fromEntries(Object.entries(records).map(([file, { opaque, reads }]) => [file, {
    opaque: opaque.map(escape => `${escape.kind}: ${escape.target.replace(/:\d+$/, ':<port>')}`).sort(),
    reads: Object.keys(reads).sort(),
  }]))
}

const project = {
  '.gitignore': 'node_modules\ndist\n',
  'vitest.config.mjs': config({}),
  'server.mjs': `import { createServer } from 'node:http'
export default async function ({ provide }) {
  const server = createServer((_, response) => response.end('remote'))
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  provide('port', server.address().port)
  return () => new Promise(done => server.close(done))
}
`,
  'scripts/tool.js': 'console.log("tool")\n',
  'src/value.js': 'export function value() { return 1 }\n',
  'dist/value.txt': 'built\n',
  'test/pure.test.js': `import { expect, test } from 'vitest'\nimport { value } from '../src/value.js'\ntest('pure', () => expect(value()).toBe(1))\n`,
  'test/process.test.js': `import { execFileSync, spawn } from 'node:child_process'
import { expect, test } from 'vitest'
test('sync', () => expect(execFileSync('node', ['scripts/tool.js'], { encoding: 'utf8' })).toBe('tool\\n'))
test('async', () => new Promise(done => spawn('node', ['-e', '0']).on('exit', done)))
`,
  'test/in-process.test.js': `import { createServer } from 'node:http'
import { expect, test } from 'vitest'
test('in-process server', async () => {
  const server = createServer((_, response) => response.end('local'))
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  expect(await fetch(\`http://127.0.0.1:\${server.address().port}/\`).then(response => response.text())).toBe('local')
  server.close()
})
`,
  'test/remote.test.js': `import { expect, inject, test } from 'vitest'
test('server in another process', async () => {
  expect(await fetch(\`http://127.0.0.1:\${inject('port')}/\`).then(response => response.text())).toBe('remote')
})
`,
  'test/built.test.js': `import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
test('built output', () => expect(readFileSync('dist/value.txt', 'utf8')).toMatch(/built/))
`,
  'test/opened.test.js': `import { closeSync, open } from 'node:fs'
import { test } from 'vitest'
test('opened with the default flags', () => new Promise(done => open('dist/value.txt', (_, fd) => done(closeSync(fd)))))
`,
  'test/gated.test.js': `import { existsSync } from 'node:fs'
import { test } from 'vitest'
test.skipIf(!existsSync('dist/gate.txt'))('runs once the gate exists', () => {})
`,
}

test.for([{ isolate: true }, { isolate: false }])('records what each test file did outside its worker (%o)', async (options) => {
  const root = createRepository({ ...project, 'vitest.config.mjs': config(options) })
  expect((await runFaster(root)).files).toEqual(['built.test.js', 'gated.test.js', 'in-process.test.js', 'opened.test.js', 'process.test.js', 'pure.test.js', 'remote.test.js'])
  expect(summarize(readEscapes(root) as Records)).toMatchInlineSnapshot(`
    {
      ":test/built.test.js": {
        "opaque": [],
        "reads": [
          "dist/value.txt",
          "test/__snapshots__/built.test.js.snap",
        ],
      },
      ":test/gated.test.js": {
        "opaque": [],
        "reads": [
          "dist/gate.txt",
        ],
      },
      ":test/in-process.test.js": {
        "opaque": [],
        "reads": [
          "test/__snapshots__/in-process.test.js.snap",
        ],
      },
      ":test/opened.test.js": {
        "opaque": [],
        "reads": [
          "dist/value.txt",
          "test/__snapshots__/opened.test.js.snap",
        ],
      },
      ":test/process.test.js": {
        "opaque": [
          "process: node -e 0",
          "process: node scripts/tool.js",
        ],
        "reads": [
          "test/__snapshots__/process.test.js.snap",
        ],
      },
      ":test/pure.test.js": {
        "opaque": [],
        "reads": [
          "test/__snapshots__/pure.test.js.snap",
        ],
      },
      ":test/remote.test.js": {
        "opaque": [
          "network: 127.0.0.1:<port>",
        ],
        "reads": [
          "test/__snapshots__/remote.test.js.snap",
        ],
      },
    }
  `)
})

// VM pools bind the builtins' named exports before any setup file runs, so most `fs` reads there go unseen.
test('records processes and connections under VM pools', async () => {
  const root = createRepository({ ...project, 'vitest.config.mjs': config({ pool: 'vmThreads' }) })
  await runFaster(root)
  const records = summarize(readEscapes(root) as Records)
  expect(Object.fromEntries(Object.entries(records).map(([file, { opaque }]) => [file, opaque]))).toMatchInlineSnapshot(`
    {
      ":test/built.test.js": [],
      ":test/gated.test.js": [],
      ":test/in-process.test.js": [],
      ":test/opened.test.js": [],
      ":test/process.test.js": [
        "process: node -e 0",
        "process: node scripts/tool.js",
      ],
      ":test/pure.test.js": [],
      ":test/remote.test.js": [
        "network: 127.0.0.1:<port>",
      ],
    }
  `)
})

test('strict runs files that left their worker; reads select in every mode', async () => {
  const root = createRepository(project)
  await runFaster(root)

  const fast = await runFaster(root, 'fast')
  expect(fast.files).toEqual([])
  expect(fast.output.match(/\[vitest-faster\].*/g)).toMatchInlineSnapshot(`
    [
      "[vitest-faster] fast: skipped 2 unaffected test file(s) that left their worker in their last run: test/process.test.js (process: node scripts/tool.js, process: node -e 0), test/remote.test.js (network: 127.0.0.1:<port>)",
    ]
  `)

  const strict = await runFaster(root, 'strict')
  expect(strict.files).toEqual(['process.test.js', 'remote.test.js'])
  expect(strict.output.match(/\[vitest-faster\].*/g)).toMatchInlineSnapshot(`
    [
      "[vitest-faster] strict: running 2 unaffected test file(s) that left their worker in their last run: test/process.test.js (process: node scripts/tool.js, process: node -e 0), test/remote.test.js (network: 127.0.0.1:<port>)",
    ]
  `)

  writeFileSync(join(root, 'dist/value.txt'), 'rebuilt\n')
  expect((await runFaster(root, 'fast')).files).toEqual(['built.test.js', 'opened.test.js'])
  expect((await runFaster(root, 'fast')).files).toEqual([])

  writeFileSync(join(root, 'dist/gate.txt'), '')
  expect((await runFaster(root, 'fast')).files).toEqual(['gated.test.js'])
})

test('a run of only some tests adds to a file\'s escapes instead of replacing them', async () => {
  const root = createRepository(project)
  await runFaster(root)
  await runVitest(root, { CI: '', VITEST_FASTER_OPTIONS: JSON.stringify({ selectAffected: false }) }, ['-t', 'sync'])
  expect(summarize(readEscapes(root) as Records)[':test/process.test.js']).toMatchInlineSnapshot(`
    {
      "opaque": [
        "process: node -e 0",
        "process: node scripts/tool.js",
      ],
      "reads": [
        "test/__snapshots__/process.test.js.snap",
      ],
    }
  `)
})

test('a server another test file left running is outside the current file', async () => {
  const root = createRepository({
    '.gitignore': 'node_modules\n',
    'vitest.config.mjs': `import { faster } from 'vitest-faster'
class Alphabetical {
  async shard(files) { return files }
  async sort(files) { return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId)) }
}
export default { plugins: [faster({ selectAffected: true })], test: { maxWorkers: 1, isolate: false, sequence: { sequencer: Alphabetical } } }
`,
    'test/a-server.test.js': `import { createServer } from 'node:http'
import { test } from 'vitest'
test('leaves a server running', async () => {
  const server = createServer((_, response) => response.end('left over'))
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  server.unref()
  globalThis.leftOverPort = server.address().port
})
`,
    'test/b-client.test.js': `import { expect, test } from 'vitest'
test('talks to it', async () => {
  expect(await fetch(\`http://127.0.0.1:\${globalThis.leftOverPort}/\`).then(response => response.text())).toBe('left over')
})
`,
  })
  expect((await runFaster(root)).files).toEqual(['a-server.test.js', 'b-client.test.js'])
  expect(summarize(readEscapes(root) as Records)).toMatchInlineSnapshot(`
    {
      ":test/a-server.test.js": {
        "opaque": [],
        "reads": [
          "test/__snapshots__/a-server.test.js.snap",
        ],
      },
      ":test/b-client.test.js": {
        "opaque": [
          "network: 127.0.0.1:<port>",
        ],
        "reads": [
          "test/__snapshots__/b-client.test.js.snap",
        ],
      },
    }
  `)
})

test('a file changed while the run read it selects the test next time', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vitest-faster-escapes-'))
  cleanup.push(root)
  const data = join(root, 'data.txt')
  writeFileSync(data, 'one')
  const escapes = new FasterEscapes()
  escapes.configure(root, join(root, 'state'))
  const file = {
    projectName: 'p',
    filepath: join(root, 'a.test.js'),
    result: { state: 'pass' },
    tasks: [{ type: 'test', result: { state: 'pass' } }],
    meta: { [ESCAPES_META_KEY]: [{ kind: 'file', target: data }, { kind: 'file', target: TRUNCATED }] },
  } as any
  await escapes.update([file])
  expect(escapes.get('p:a.test.js')!.opaque).toEqual([{ kind: 'file', target: TRUNCATED }])
  expect(await escapes.changedReads(['p:a.test.js'])).toEqual(new Set())

  await escapes.capture(['p:a.test.js'])
  writeFileSync(data, 'two')
  await escapes.update([file])
  expect(await escapes.changedReads(['p:a.test.js'])).toEqual(new Set(['p:a.test.js']))

  await escapes.capture(['p:a.test.js'])
  await escapes.update([file])
  expect(await escapes.changedReads(['p:a.test.js'])).toEqual(new Set())
})

test('safety off records nothing and selects by imports alone', async () => {
  const root = createRepository(project)
  await runFaster(root, 'off')
  expect(existsSync(join(root, '.git/faster/node_modules/.vite/vitest'))).toBe(true)
  expect(readEscapes(root)).toEqual({})
  expect((await runFaster(root, 'off')).files).toEqual([])
})
