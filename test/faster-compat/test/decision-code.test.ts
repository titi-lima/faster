import { expect, test } from 'vitest'
import { checkDecisionCode } from '../scripts/check-decision-code.mjs'

test('the plugin\'s decision code is the fork\'s, except for module specifiers', () => {
  const report = checkDecisionCode()
  expect(report.unchecked).toEqual([])
  expect(report.files.filter(entry => entry.difference)).toEqual([])
  expect(report.files.flatMap(entry => entry.specifiers.length
    ? entry.specifiers.map(change => `${entry.file}:${change.line} '${change.before}' -> '${change.after}'`)
    : [`${entry.file}: identical`])).toMatchInlineSnapshot(`
    [
      "affectedTests.ts:1 '../project' -> '../shims/vitest'",
      "affectedTests.ts:2 '../test-specification' -> '../shims/vitest'",
      "affectedTests.ts:5 '../../utils/env' -> '../shims/env'",
      "apfdPriority.ts: identical",
      "functionCoverage.ts:2 '../../types/general' -> '../shims/vitest'",
      "functionCoverage.ts:3 '../core' -> '../shims/vitest'",
      "functionCoverage.ts:4 '../project' -> '../shims/vitest'",
      "functionCoverage.ts:8 '../hash' -> './hash'",
      "priorityManifest.ts:1 '@vitest/runner/utils' -> './priority'",
      "sourceChanges.ts:1 '@vitest/runner' -> '../shims/vitest'",
      "sourceChanges.ts:2 '../core' -> '../shims/vitest'",
      "sourceChanges.ts:3 '../test-specification' -> '../shims/vitest'",
      "sourceChanges.ts:8 '@vitest/utils/helpers' -> '../shims/helpers'",
      "sourceChanges.ts:10 '../hash' -> './hash'",
      "FasterSequencer.ts:1 '../faster/sourceChanges' -> './sourceChanges'",
      "FasterSequencer.ts:2 '../test-specification' -> '../shims/vitest'",
      "FasterSequencer.ts:5 '../errors' -> './errors'",
      "FasterSequencer.ts:6 '../faster/affectedTests' -> './affectedTests'",
      "FasterSequencer.ts:7 '../faster/apfdPriority' -> './apfdPriority'",
      "FasterSequencer.ts:8 '../faster/sourceChanges' -> './sourceChanges'",
      "BaseSequencer.ts:1 '../core' -> '../shims/vitest'",
      "BaseSequencer.ts:2 '../test-specification' -> '../shims/vitest'",
      "BaseSequencer.ts:3 './types' -> '../shims/vitest'",
      "BaseSequencer.ts:4 '@vitest/utils/helpers' -> '../shims/helpers'",
      "BaseSequencer.ts:6 '../hash' -> './hash'",
      "priority.ts:1 '../types/tasks' -> '../shims/vitest'",
      "git.ts:5 '../errors' -> './errors'",
      "vcs.ts: identical",
      "errors.ts: identical",
      "hash.ts: identical",
    ]
  `)
})
