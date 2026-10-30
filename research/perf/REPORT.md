# FASTER instrumentation overhead: profile, fix, equivalence and A/B evidence

Branch `claude/faster-instrumentation-perf-33510d` (worktree `.claude/worktrees/faster-instrumentation-perf-33510d`).

| Build | Commit | What it is |
| --- | --- | --- |
| **old** | `997c7387c` | Frozen FASTER used by the recorded studies. Rebuilt in `.claude/worktrees/faster-perf-baseline-997c738`; all 338 package/source/lock files byte-identical to `implementation-sha256.json` of `valibot-window50-study-01`, `pathe-window50-study-01` and `unocss-pr5407-study-03` (only the uncommitted harness files differ, which are copied unchanged from `research/javascript`). |
| **new** | `9dfc8b50e` (+ tests `02778e2ae`, tooling `7db9b36e7`) | This change. Runtime-side files that tests import are unchanged; only node-side chunks differ. |

The research harness (`research/javascript/*`, uncommitted in the main checkout) was copied unchanged into both worktrees. No file in the main checkout or in recorded study data was modified; all outputs are under `research/work/perf-*`.

__SUMMARY__

## 1. Where the overhead came from (profile before)

Method: the replay tool (§5) runs the recorded `oracle` request (instrumented, frozen `faster-full` order, prior cache restored) and the same order uninstrumented (`stock`, i.e. the `vitest-stock` arm: same fork, `faster: false`). Wall time is split into *before the first test module starts*, *while modules run*, and *after the last module ends* (study-reporter timestamps), and the Vitest main process is CPU-profiled (`--cpu-prof`, main process only).

Findings (old build):

1. **Coverage report pipeline nobody reads (Pathe, Unocss; every `isolate: true` subject).** With `isolate: true` FASTER forces `coverage.enabled = true, reporter: []` so workers return V8 function counts. That also instantiated the full `@vitest/coverage-v8` node-side provider: loading it (istanbul, magicast, babel parser, test-exclude… ≈ 0.6–0.8 s of module loading in the harness, which resolves every import through `runner-redirect.mjs`), deleting/recreating `coverage/`, writing one JSON file per test file, and at the end merging and converting all V8 coverage to Istanbul (`generateCoverage`) only to report it to zero reporters. Pathe: ≈ +1.2 s before the first module; Unocss: ≈ +2 s after the last module.
2. **Per-test-file re-hashing on save (all subjects).** `saveTestRunSourceSnapshots` re-read and SHA-1'd every dependency once *per test file* (fresh hash map per spec). Valibot: 272 files × ~165 tracked sources = ~45 k file reads (~170 MB, incl. 26 Vitest dist files of ~600 kB per test) ≈ +1.1 s after the last module.
3. **Per-test-file dependency walks (all subjects).** `getTestDependencies` re-walked each test's import graph separately: per-import `join` + `existsSync`, per-path `relative`/`resolve`, ~45 k times on Valibot (≈ 0.3 s).
4. **Quadratic coverage matching (`isolate: true`).** For every function of a module's model, `collectFasterFunctionSnapshots` scanned every V8 function of every script (`O(F × V)` per test and module) and re-hashed the full transformed code per lookup.
5. **Dependency discovery is serialized before the run (all subjects).** Capture transforms every tracked module in Vite's `ssr` environment before the pool starts (Valibot ≈ 1.1–1.3 s of Vite transforms; its tests run in `jsdom`, i.e. Vite's `client` environment, so none of this is reused by the workers).

Note on the harness: the study facade links `vitest` to the fork's `packages/vitest`, *outside* `node_modules`, so FASTER tracks 26 of the fork's own runtime dist files (≈ 600 kB) as dependencies of every test, transforms them and builds their function models. That is part of the measured setup and is kept bit-for-bit (see §6 for what removing it would buy).

__PROFILE_TABLE__

## 2. The change

All changes keep every input to FASTER's decisions identical by construction:

| # | Change | Why decisions cannot change |
| --- | --- | --- |
| C1 | When FASTER alone forced coverage (`faster.ownsCoverage`: user did not enable coverage and set no thresholds; no browser project; no runtime `enableCoverage()` override), the node-side coverage provider is not created. Workers get the identical serialized coverage config (`enabled: true`, `provider: 'v8'`) and still start/take V8 precise coverage exactly as before; `recordFasterFunctionCoverage` receives the same payload. | The provider only consumed the payload for reports (`reporter: []`). Thresholds keep the provider (tested). Side effects that disappear: an existing `coverage/` folder is no longer deleted, the "Coverage enabled with v8" banner is not printed. |
| C2 | One per-run `SourceCache` (hashes, `relative`/`resolve` results, import lists) shared by all test files in capture, save and `getTestSourceChanges`; `findAffectedTestSpecifications` shares import lists too. | Same pure functions on the same inputs within one pass; save still re-reads every file after the run (once instead of once per test). Key order inside snapshot objects was already nondeterministic (async completion) and is irrelevant to every consumer. |
| C3 | `collectFasterFunctionSnapshots` indexes V8 function ranges by end offset; the transformed-code hash is memoized per transform result *and* code string (fetching rewrites `transformResult.code` in place). | Same predicate (`end === fn.end && start <= bodyStart`, `some(count > 0)`); `ranges[0]` is still read for every function, so malformed coverage fails the same way. |
| C4 | Capture starts together with the pool; RPC `fetch`, `resolve` and `transform` (VM pools) wait for it. Browser projects keep the sequential order. | No project module can be loaded (hence no test, setup file or project environment code can run) before the pre-run snapshot is complete; workers only boot meanwhile. A test that rewrites a source at import time still yields the pre-run hash and an empty function snapshot (regression test fails without the gate, passes with it). |

Files: `packages/vitest/src/node/{core.ts,pools/rpc.ts,config/resolveConfig.ts}`, `packages/vitest/src/node/faster/{affectedTests,functionCoverage,priorityManifest,sourceChanges}.ts`; tests `test/core/test/faster-instrumentation.test.ts`.

__EQUIVALENCE__

__BENCHMARKS__

__REMAINING__

## 7. Repository checks

__CHECKS__

## 8. Reproduce

__COMMANDS__
