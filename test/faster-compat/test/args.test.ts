import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { extractFasterArguments } from '../../../packages/vitest-faster/src/args'

test('extracts the fork\'s --faster flags and keeps the other arguments for Vitest', () => {
  expect(extractFasterArguments([
    'run',
    '--faster.selectAffected',
    '--faster.optimizeFor=apfd',
    '--faster.changed',
    'HEAD~1',
    '--reporter=dot',
    'src/math',
    '--faster.immediateFailureOutput=false',
  ])).toMatchInlineSnapshot(`
    {
      "options": {
        "changed": "HEAD~1",
        "immediateFailureOutput": false,
        "optimizeFor": "apfd",
        "selectAffected": true,
      },
      "rest": [
        "run",
        "--reporter=dot",
        "src/math",
      ],
    }
  `)
})

test('reads booleans, negations and a bare --faster', () => {
  expect([
    extractFasterArguments(['--no-faster']).options,
    extractFasterArguments(['--faster']).options,
    extractFasterArguments(['--faster=false']).options,
    extractFasterArguments(['--faster.changed=false']).options,
    extractFasterArguments(['--no-faster.selectAffected']).options,
    extractFasterArguments(['--faster.optimizeFor', 'dx']).options,
    extractFasterArguments(['run']).options,
  ]).toMatchInlineSnapshot(`
    [
      {
        "enabled": false,
      },
      {
        "enabled": true,
      },
      {
        "enabled": false,
      },
      {
        "changed": false,
      },
      {
        "selectAffected": false,
      },
      {
        "optimizeFor": "dx",
      },
      undefined,
    ]
  `)
})

test('resolves the priority file against the working directory', () => {
  expect(extractFasterArguments(['--faster.priorityFile=scores.json']).options).toEqual({ priorityFile: resolve('scores.json') })
})

test('rejects unknown and malformed --faster flags', () => {
  expect(() => extractFasterArguments(['--faster.unknown'])).toThrowErrorMatchingInlineSnapshot(`[TypeError: Unknown option --faster.unknown]`)
  expect(() => extractFasterArguments(['--faster.selectAffected=maybe'])).toThrowErrorMatchingInlineSnapshot(`[TypeError: --faster.selectAffected expects true or false, received "maybe"]`)
  expect(() => extractFasterArguments(['--faster.optimizeFor'])).toThrowErrorMatchingInlineSnapshot(`[TypeError: --faster.optimizeFor requires a value]`)
})
