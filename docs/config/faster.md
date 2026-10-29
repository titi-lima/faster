---
title: faster | Config
outline: deep
---

# faster

FASTER prioritizes tests using source changes, previous failures and history/size
scores. Function coverage identifies affected tests automatically. The full
suite runs unless selection is enabled.

```ts
import { defineConfig } from 'faster/config'

export default defineConfig({
  test: {
    faster: { optimizeFor: 'apfd', selectAffected: true },
  },
})
```

Install matching `@vitest/coverage-v8`. Change tracking collects V8 coverage;
coverage reports are generated only when ordinary reporting is enabled. Isolated
Node execution supports caller attribution. Missing observations or structural
changes keep tests eligible.

## faster.enabled

- **Type:** `boolean`
- **Default:** `true`
- **CLI:** `--faster.enabled`, `--no-faster`

Enable FASTER. `faster: false` disables its behavior.

## faster.optimizeFor

- **Type:** `'dx' | 'apfd'`
- **Default:** `'dx'`
- **CLI:** `--faster.optimizeFor=apfd`

Both modes order previous failures first, grouping edited/unknown tests before
other affected tests, then remaining tests. Higher
`durationRank + 0.1 * sizeRank` scores lead inside each group; equal priorities
keep path order. Producer scores take precedence inside a group.

The only difference: `dx` sends unchanged, unaffected known failures to the end.
`apfd` retains their failure priority. Scores target fault detection, not runtime.

## faster.changed

- **Type:** `boolean | string`
- **Default:** `true`
- **CLI:** `--faster.changed[=<revision>]`, `--faster.changed=false`

Compare against each test's previous completed run. A revision additionally
includes changes since that Git revision. `false` disables change tracking.
History is stored in the results cache and cleared by `--clearCache`.

## faster.selectAffected

- **Type:** `boolean`
- **Default:** `false`
- **CLI:** `--faster.selectAffected`

Run affected, edited, unknown or previously failing tests. Requires
`faster.changed`. Cold runs execute everything; skipped tests keep their prior
observations. Revision-based selection and explicit full-rerun triggers preserve
the relevant suite. An unchanged suite can succeed with no selected tests.

## faster.priorityFile

- **Type:** `string`
- **Default:** `'.faster/priorities.json'`
- **CLI:** `--faster.priorityFile=<path>`

Optional JSON producer scores: `{"schemaVersion":1,"tests":{"path.test.ts":0.9}}`.
Higher scores take precedence inside a bucket. Identifiers can include
`::suite::test`; missing manifests are accepted and invalid scores fail fast.
Within a file, unscored tests and equal scores keep declaration order.

## faster.immediateFailureOutput

- **Type:** `boolean`
- **Default:** `true`
- **CLI:** `--faster.immediateFailureOutput=false`

Print each failure and captured output when it completes. Explicit custom
sequencers continue to control ordering. For position-based research metrics,
use serial execution with `--no-file-parallelism --maxWorkers=1`.
