---
title: faster | Config
outline: deep
---

# faster

- **Type:** `boolean | FasterOptions`
- **Default:** `true`
- **CLI:** `--faster`, `--no-faster`

Enables Faster's built-in test prioritization and immediate failure feedback. Faster keeps the Vitest API and configuration surface intact; this option is the only additional behavior.

With the default `optimizeFor: 'dx'`, Faster schedules files in two buckets:

1. Test files affected by source changes since the previous completed test run.
2. The remaining test files.

Each bucket puts cached failures before its other files. Faster computes one deterministic FAST-pw-style MinHash order over the full file set, then preserves that relative order inside each bucket. Source reads and changed-source detection run concurrently; shared dependency hashes are reused within that scheduling pass. The same FAST ordering applies on cold and warm runs. Prior durations do not determine file order.

An optional manifest supplies higher-priority scores within each bucket on every run. Equal scores and unscored files use the configured objective's ordering. Collected tests and suites use manifest scores and name-based similarity within each file. For sets larger than 256, the built-in similarity algorithm samples `sqrt(n)` candidates per selection. Project groups, project order and isolation boundaries remain in control.

```ts
import { defineConfig } from 'faster/config'

export default defineConfig({
  test: {
    faster: {
      optimizeFor: 'dx',
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
- **CLI:** `--faster.changed[=<revision>]`, `--faster.changed=false`

Compares source and dependency snapshots from the previous completed run. Faster captures the sources before execution and saves snapshots only for completed test files, including failed files. Interrupted runs retain the previous source history. Vite's module graph supplies the dependencies. Edits and reverts both count as changes relative to that run. A string additionally includes changes since that Git revision.

Source history lives in the configured results-cache directory and is cleared by `--clearCache`. Setting `faster: false`, `faster.changed: false` or `cache: false` disables source-history persistence. Malformed or incompatible history is treated as a cold start. Projects with Faster disabled keep Vitest's file ordering.

Set this to `false` to disable the changed-source bucket while retaining built-in and manifest ordering plus immediate failures.

## faster.optimizeFor

- **Type:** `'dx' | 'apfd'`
- **Default:** `'dx'`
- **CLI:** `--faster.optimizeFor=apfd`

`dx` puts affected files before unchanged files, including unchanged cached failures, and retains the global FAST order within each bucket.

`apfd` puts all cached failing files first. Within each failure-status group it orders directly edited or newly added tests before transitively affected tests, then the remaining files. Within those buckets it combines normalized ranks of previous duration and current source size: `durationRank + 0.1 * sizeRank`, with higher scores first. Ranks use the distinct values within each project; missing durations have rank zero. This uses prior duration as a fault-revelation signal, rather than an execution-time objective. Manifest scores take precedence, and FAST breaks remaining ties. Project grouping and explicit custom sequencers remain in control.

```bash
faster run --faster.optimizeFor=apfd --no-file-parallelism --maxWorkers=1
```

This is a heuristic for experiments, not a guarantee of optimal APFD. Ranking uses current source bytes and changes plus results from prior runs; current outcomes never enter the ranking. Cold starts have no duration history, so APFD favors larger files while DX uses FAST. Stale failures and unrelated test edits can delay new faults. The policy operates at file level; test and suite ordering within a file is unchanged. Use serial execution for position-based metrics; parallel feedback needs event timestamps.

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
