---
title: faster | Config
outline: deep
---

# faster

- **Type:** `boolean | FasterOptions`
- **Default:** `true`
- **CLI:** `--faster`, `--no-faster`

Enables Faster's built-in test prioritization and immediate failure feedback. Faster keeps the Vitest API and configuration surface intact; this option is the only additional behavior.

Faster schedules tests in two buckets:

1. Test files that transitively depend on locally changed source files.
2. The remaining test files.

Within both buckets, Faster uses a deterministic FAST-pw-style MinHash order. Test files are compared from their source tokens; collected tests and suites are compared from their names. The first item preserves Vitest's cached order, then Faster lazily chooses the least-similar candidate against the cumulative selected set. For groups larger than 256, it samples `sqrt(n)` candidates per selection to bound prioritization overhead.

An optional FAST priority manifest overrides the built-in order for scored files and tests. This lets a producer add signals such as failure history or coverage without making a fresh checkout wait for preprocessing.

```ts
import { defineConfig } from 'faster/config'

export default defineConfig({
  test: {
    faster: {
      changed: true,
      priorityFile: '.faster/priorities.json',
      immediateFailureOutput: true,
    },
  },
})
```

Faster does not filter the suite. Use Vitest's existing [`changed`](/guide/cli#changed) or `related` options when you want to run only affected tests.

## faster.enabled

- **Type:** `boolean`
- **Default:** `true`
- **CLI:** `--faster.enabled`, `--faster.enabled=false`

Enables or disables all Faster-specific behavior. Setting the top-level `faster` option to a boolean is equivalent to setting this field.

## faster.changed

- **Type:** `boolean | string`
- **Default:** `true`
- **CLI:** `--faster.changed[=<revision>]`

Detects staged, unstaged, and untracked files with the configured VCS provider, then uses Vite's module graph to find every test file that transitively depends on them. A string additionally includes committed changes since that Git revision.

Set this to `false` to disable the changed-source bucket while retaining built-in and manifest ordering plus immediate failures.

## faster.priorityFile

- **Type:** `string`
- **Default:** `'.faster/priorities.json'`
- **CLI:** `--faster.priorityFile=<path>`

Path to an optional FAST-produced JSON manifest, resolved from the project root. Test identifiers use the portable form `<relative-test-file>::<suite>::<test>` and higher finite scores run first. Any unscored files and tests fall back to Faster's built-in lazy MinHash order.

```json
{
  "schemaVersion": 1,
  "tests": {
    "src/cart.test.ts::checkout::rejects an expired card": {
      "score": 0.982,
      "signals": {
        "similarity": 0.91,
        "failureHistory": 0.72
      }
    },
    "src/cart.test.ts::checkout::accepts a valid card": 0.73
  }
}
```

The optional `signals` object is retained for producer diagnostics; scheduling uses `score`. Missing manifests are accepted because the built-in prioritizer needs no generated artifacts. Malformed manifests fail fast with the manifest path and invalid field.

## faster.immediateFailureOutput

- **Type:** `boolean`
- **Default:** `true`
- **CLI:** `--faster.immediateFailureOutput`, `--faster.immediateFailureOutput=false`

Prints a failed test, its captured console output, assertion diff, and stack as soon as the test result reaches the reporter. Faster remembers immediately printed failures and does not repeat their full error block at the end of the run.

## Custom sequencers

An explicit [`sequence.sequencer`](/config/sequence#sequence-sequencer) continues to control file ordering. Built-in and manifest priorities still order tests within each file. This preserves existing custom sequencing behavior.
