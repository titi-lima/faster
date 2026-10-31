import type { Scenario } from './harness'
import { testFile } from './harness'

const base = {
  include: ['test/**/*.test.js'],
  pool: 'forks',
  fileParallelism: false,
  maxWorkers: 1,
  watch: false,
}

const math = [
  'export function add(a, b) { return a + b }',
  'export function mul(a, b) { return a * b }',
  'export function unused(a) { return a - 1 }',
  '',
].join('\n')

/** Durations are 80 ms apart so their ranks do not depend on machine noise. */
const files = {
  'src/math.js': math,
  'test/add.test.js': testFile('test/add.test.js', {
    imports: `import { add } from '../src/math.js'`,
    sleep: 40,
    tests: { adds: 'expect(add(1, 2)).toBe(3)' },
  }),
  'test/mul.test.js': testFile('test/mul.test.js', {
    imports: `import { mul } from '../src/math.js'`,
    sleep: 120,
    tests: { multiplies: 'expect(mul(2, 3)).toBe(6)' },
  }),
  'test/both.test.js': testFile('test/both.test.js', {
    imports: `import { add, mul } from '../src/math.js'`,
    sleep: 200,
    tests: { 'adds too': 'expect(add(2, 2)).toBe(4)', 'multiplies too': 'expect(mul(2, 2)).toBe(4)' },
  }),
  'test/plain.test.js': testFile('test/plain.test.js', {
    sleep: 280,
    tests: { 'is independent': 'expect(1).toBe(1)' },
  }),
}

const functionSteps: Scenario['steps'] = [
  { name: 'cold run' },
  { name: 'no change' },
  { name: 'edit a function no test calls', change: f => f.edit('src/math.js', 'a - 1', 'a - 2') },
  { name: 'edit mul', change: f => f.edit('src/math.js', 'a * b', 'b * a') },
  { name: 'edit a test file', change: f => f.edit('test/add.test.js', 'toBe(3)', 'toEqual(3)') },
  { name: 'add a function', change: f => f.edit('src/math.js', 'export function unused', 'export function extra() { return 0 }\nexport function unused') },
  { name: 'break mul.test', change: f => f.edit('test/mul.test.js', 'toBe(6)', 'toBe(7)') },
  { name: 'keep the failure' },
  {
    name: 'fix mul.test and add a test file',
    change: (f) => {
      f.edit('test/mul.test.js', 'toBe(7)', 'toBe(6)')
      f.write('test/new.test.js', testFile('test/new.test.js', {
        imports: `import { add } from '../src/math.js'`,
        sleep: 360,
        tests: { 'is new': 'expect(add(0, 0)).toBe(0)' },
      }))
    },
  },
  { name: 'edit the new test without running others', change: f => f.edit('test/new.test.js', 'toBe(0)', 'toEqual(0)') },
]

const priorityTests = [
  `import { appendFileSync } from 'node:fs'`,
  `import { describe, expect, test } from 'vitest'`,
  `import { add } from '../src/math.js'`,
  `const log = entry => appendFileSync(process.env.ORDER_LOG, (process.env.PROJECT ? process.env.PROJECT + '|' : '') + entry + '\\n')`,
  `const run = name => async () => { log('test/ranked.test.js::' + name); await new Promise(r => setTimeout(r, 20)); expect(add(1, 1)).toBe(2) }`,
  `test('first', run('first'))`,
  `test('second', run('second'))`,
  `describe('group', () => {`,
  `  test('inner low', run('group::inner low'))`,
  `  test('inner high', run('group::inner high'))`,
  `})`,
  `test.concurrent('concurrent a', run('concurrent a'))`,
  `test.concurrent('concurrent b', run('concurrent b'))`,
  `test('third', run('third'))`,
  '',
].join('\n')

export const scenarios: Scenario[] = [
  {
    name: 'select-apfd',
    config: { test: base, faster: { optimizeFor: 'apfd', selectAffected: true, immediateFailureOutput: false } },
    files,
    steps: functionSteps,
  },
  {
    name: 'order-dx',
    config: { test: base, faster: { optimizeFor: 'dx', immediateFailureOutput: false } },
    files,
    steps: functionSteps,
  },
  {
    // Function-level relevance only for the isolated project on the module runner;
    // the other projects use the fork's dependency-level fallback.
    name: 'projects',
    config: {
      test: { ...base, include: undefined },
      faster: { selectAffected: true, immediateFailureOutput: false },
      projects: [
        { test: { ...base, name: 'isolated', env: { PROJECT: 'isolated' } }, faster: { selectAffected: true } },
        { test: { ...base, name: 'shared', env: { PROJECT: 'shared' }, isolate: false }, faster: { selectAffected: true } },
        { test: { ...base, name: 'native', env: { PROJECT: 'native' }, experimental: { viteModuleRunner: false } }, faster: { selectAffected: true } },
        { test: { ...base, name: 'off', env: { PROJECT: 'off' } }, faster: false },
      ],
    },
    files,
    steps: functionSteps.slice(0, 4),
  },
  {
    name: 'priorities',
    config: { test: base, faster: { optimizeFor: 'apfd', immediateFailureOutput: false } },
    files: {
      ...files,
      'test/ranked.test.js': priorityTests,
      '.faster/priorities.json': JSON.stringify({
        schemaVersion: 1,
        tests: {
          'test/plain.test.js': 0.5,
          'test/ranked.test.js::second': 0.9,
          'test/ranked.test.js::group::inner high': 0.8,
          'test/ranked.test.js::group::inner low': 0.1,
          'test/ranked.test.js::concurrent b': 0.7,
          'test/ranked.test.js::third': { score: 0.3 },
        },
      }),
    },
    steps: functionSteps.slice(0, 4),
  },
  {
    name: 'revision',
    config: { test: base, faster: { changed: 'HEAD~1', immediateFailureOutput: false } },
    files,
    async setup(f) {
      await f.git('init', '-q')
      await f.git('-c', 'user.email=f@example.com', '-c', 'user.name=f', 'add', '.')
      await f.git('-c', 'user.email=f@example.com', '-c', 'user.name=f', 'commit', '-qm', 'one')
      await f.git('-c', 'user.email=f@example.com', '-c', 'user.name=f', 'commit', '-qm', 'two', '--allow-empty')
    },
    steps: [
      { name: 'cold run' },
      {
        name: 'commit an edit of mul',
        async change(f) {
          f.edit('src/math.js', 'a * b', 'b * a')
          await f.git('-c', 'user.email=f@example.com', '-c', 'user.name=f', 'commit', '-qam', 'three')
        },
      },
      { name: 'no change since the previous run' },
    ],
  },
  {
    name: 'user-coverage',
    config: {
      test: { ...base, coverage: { enabled: true, reporter: ['json-summary'], include: ['src/**'] } },
      faster: { selectAffected: true, immediateFailureOutput: false },
    },
    files,
    steps: functionSteps.slice(0, 4),
  },
  {
    name: 'shard',
    config: { test: base, faster: { selectAffected: true, immediateFailureOutput: false } },
    files,
    steps: functionSteps.slice(0, 4).map(step => ({ ...step, args: ['--shard=1/2'] })),
  },
  {
    name: 'cli-flags',
    fasterCli: true,
    config: { test: base, faster: { immediateFailureOutput: false } },
    files,
    steps: functionSteps.slice(0, 4).map(step => ({ ...step, args: ['--faster.selectAffected', '--faster.optimizeFor=apfd'] })),
  },
]
