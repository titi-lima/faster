# FASTER instrumentation overhead: profile, fix, equivalence and A/B evidence

Branch `claude/faster-instrumentation-perf-33510d`. All run outputs are under `research/work/perf-*` (main checkout, git-ignored).

| Build | Commit | What it is |
| --- | --- | --- |
| **old** | `997c7387c` | The frozen FASTER used by the recorded studies, rebuilt in `.claude/worktrees/faster-perf-baseline-997c738`. All 338 package dist, FASTER source, sequencer and lock files are byte-identical to `implementation-sha256.json` of `valibot-window50-study-01`, `pathe-window50-study-01` and `unocss-pr5407-study-03`. Replay fingerprint `e3bf8a76…`. |
| **new** | `9dfc8b50e` | This change (tests `02778e2ae`). Replay fingerprint `c7e10f96…`. Pathe equivalence rerun and Valibot revisions `1bb74`/`d4da6` used `c7e10f96…`; the other 49 Valibot rows used the same code (`a1c4e8bb…`, which differs only by a `tsconfig.tmp.tsbuildinfo` that `pnpm typecheck` left in `packages/vitest/dist`). |

The uncommitted harness (`research/javascript/*`) was copied unchanged into both worktrees. Nothing in the main checkout or in recorded study data was modified.

## Summary

- **Overhead vs stock Vitest (same fork, `faster: false`), paired and interleaved, 95% bootstrap intervals:**
  - **Valibot:** **+56% [48, 68] → +9.9% [6.0, 18.1]**. New is 2.56 s faster than old per run [2.07, 3.22], 23/24 units.
  - **Pathe:** **+29% [21, 33] → +12.4% [7.7, 17.8]**. New is 107 ms faster [86, 182], 21/24.
  - **Unocss target:** __UNOCSS_SUMMARY__
  - The ≤ +15% target is met on medians for Valibot and Pathe; the upper interval bounds are 18% and 18% under load ≈ 12–15 from concurrent studies.
- **Decisions unchanged:**
  - **All 51 Pathe, all 51 Valibot and both Unocss revisions:** byte-identical features/policy orders and selected sets vs the recordings for both builds, and identical case identities and outcomes. Caches are identical old vs new, except 7 `called` flags of asynchronous webpack callbacks in one Unocss test, which flip between runs of the *same* build (§3.3).
  - **Seeded-fault matrices:** 0 mismatches over 193 killed mutants (Pathe 107, Valibot 86); `faster-selected` detects every one with both builds.
- **Repository checks:** `pnpm build`, `pnpm typecheck`, `pnpm lint`, all FASTER tests (165), full `test/core` (5,697 tests) and the research harness tests pass.

## 1. Where the overhead came from

Method: `research/perf/replay.ts` replays a recorded revision and runs its recorded `oracle` request: instrumented, frozen `faster-full` order, prior cache restored. The `stock` arm is the same order with `instrumented: false`, i.e. the study's `vitest-stock` arm. Wall time is split with study-reporter timestamps into *before the first test module starts*, *while modules run* and *after the last module ends*. The Vitest main process is CPU-profiled (`--cpu-prof`, main process only), and busy CPU is attributed to the first matching category on each sample's synchronous stack (`research/perf/profile-summary.ts`).

Root causes in the old build:

1. **A coverage report pipeline nobody reads (`isolate: true` subjects: Pathe, Unocss).**
   - With `isolate: true`, FASTER forces `coverage.enabled = true, reporter: []` so that workers return V8 function counts.
   - That also created the full `@vitest/coverage-v8` node-side provider. Loading it (istanbul, magicast, babel parser, test-exclude; amplified in the harness, which resolves every import through `runner-redirect.mjs`) cost ≈ 0.2 s on Pathe and ≈ 2.4 s on Unocss in module loading.
   - It also deleted and recreated `coverage/`, wrote one JSON file per test file, and at the end merged and converted all V8 coverage to Istanbul, only to report it to zero reporters.
2. **Per-test-file re-hashing on save (all subjects).** `saveTestRunSourceSnapshots` re-read and SHA-1'd every tracked source once *per test file*. On Valibot that is 272 files × ~165 sources ≈ 45 k reads (~170 MB), costing ≈ +1.1–1.4 s after the last module.
3. **Per-test-file dependency walks (all subjects).** Each test's import graph was re-walked separately (per-import `join` + `existsSync`, per-path `relative`/`resolve`, ~45 k times on Valibot): ≈ 0.3–0.5 s of capture CPU.
4. **Quadratic coverage matching (`isolate: true`).** For each function of each module model, every V8 function of every script was scanned (`O(F × V)` per test and module), and the full transformed code was re-hashed per lookup.
5. **Dependency discovery serialized before the run.** Capture transforms every tracked module in Vite's `ssr` environment before the pool starts. On Valibot that is ≈ 1.1–1.3 s, and its `jsdom` tests use Vite's `client` environment, so the workers reuse none of it.

Harness note: the study facade links `vitest` to the fork's `packages/vitest`, outside `node_modules`. FASTER therefore tracks 26 of the fork's own runtime dist files (≈ 600 kB) as dependencies of every test, transforms them and models them. This is part of the measured setup and is preserved bit-for-bit.

Main-process profile, one replay each (`research/work/perf-profile-02-*`, old/new/stock interleaved on the same revision; for each arm the run with less busy time of two). Busy CPU per category in ms:

| Subject | Arm | Wall ms | Before first / modules / after last module (ms) | Main busy CPU ms | faster capture | faster save | faster state io | coverage report pipeline | vite transform | module loading | garbage collection | other |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| valibot | stock | 5911 | 1488 / 4328 / 95 | 2526 | 0 | 0 | 0 | 75 | 710 | 399 | 123 | 1218 |
| valibot | old | 9084 | 3247 / 4399 / 1438 | 4988 | 461 | 164 | 34 | 71 | 1435 | 378 | 325 | 2120 |
| valibot | new | 7222 | 2665 / 4175 / 382 | 3925 | 149 | 38 | 47 | 95 | 1405 | 499 | 283 | 1411 |
| pathe | stock | 1074 | 852 / 170 / 52 | 756 | 0 | 0 | 0 | 7 | 46 | 426 | 19 | 258 |
| pathe | old | 1719 | 1346 / 214 / 159 | 1238 | 3 | 43 | 1 | 53 | 171 | 606 | 51 | 310 |
| pathe | new | 1291 | 981 / 190 / 120 | 958 | 2 | 41 | 6 | 6 | 154 | 439 | 40 | 270 |
| unocss | stock | 52251 | 2238 / 49670 / 343 | 3243 | 0 | 0 | 0 | 28 | 681 | 423 | 186 | 1925 |
| unocss | old | 69308 | 7588 / 58819 / 2902 | 10805 | 244 | 330 | 450 | 920 | 1508 | 2844 | 1109 | 3401 |
| unocss | new | 74900 | 2414 / 71611 / 875 | 4480 | 54 | 210 | 367 | 31 | 608 | 445 | 717 | 2048 |

Reading the table:

- **Valibot:** capture CPU dropped from 461 to 149 ms and save from 164 to 38 ms. Post-run went from 1.4 s to 0.38 s. Pre-run is shorter because capture now overlaps worker start-up.
- **Pathe:** the coverage pipeline (53 → 6 ms) and its module loading (606 → 439 ms, stock 426) disappear.
- **Unocss:** coverage pipeline 920 → 31 ms, module loading 2,844 → 445 ms, main busy CPU 10.8 → 4.5 s (stock 3.2 s). Its single-run wall times are dominated by load noise; see §4.

## 2. The change

Every input to FASTER's decisions stays identical by construction:

| # | Change | Why decisions cannot change |
| --- | --- | --- |
| C1 | When FASTER alone forced coverage, the node-side coverage provider is not created. That means `faster.ownsCoverage`: the user enabled no coverage and set no thresholds, there is no browser project, and no runtime `enableCoverage()` override. Workers get the identical serialized coverage config (`enabled: true`, `provider: 'v8'`), still start and take V8 precise coverage as before, and `recordFasterFunctionCoverage` receives the same payload. | The provider only fed reports (`reporter: []`). Configured thresholds keep the provider and are still enforced (tested). Two side effects disappear: an existing `coverage/` folder is no longer deleted (tested), and the "Coverage enabled with v8" banner is no longer printed. |
| C2 | One per-run `SourceCache` (hashes, `relative`/`resolve` results, import lists) is shared by all test files in capture, save and `getTestSourceChanges`; `findAffectedTestSpecifications` shares import lists. | The same pure functions run on the same inputs within one pass. Save still re-reads every file after the run, once instead of once per test. Key order inside snapshot objects was already nondeterministic (async completion) and no consumer depends on it. |
| C3 | `collectFasterFunctionSnapshots` indexes V8 ranges by end offset. The code hash is memoized per transform result *and* code string, because fetching rewrites `transformResult.code` in place. | The predicate is unchanged (`end === fn.end && start <= bodyStart`, `some(count > 0)`), and `ranges[0]` is still read for every function, so malformed coverage fails the same way. |
| C4 | Capture starts together with the pool. The RPC calls `fetch`, `resolve` and `transform` (VM pools) wait for it; browser projects keep the sequential order. | No project module can load, so no test, setup or project environment code can run, before the pre-run snapshot is complete; workers only boot meanwhile. Regression test: a test that rewrites a source at import time still yields the pre-run hash and an empty function snapshot. It fails with the gate removed and passes with it. |

Code: `packages/vitest/src/node/{core.ts,pools/rpc.ts,config/resolveConfig.ts}` and `packages/vitest/src/node/faster/{affectedTests,functionCoverage,priorityManifest,sourceChanges}.ts`. Tests: `test/core/test/faster-instrumentation.test.ts`. The fork's runtime files that tests import (the 26 tracked dist files) are byte-identical between old and new; only node-side chunks changed.

## 3. Decision equivalence on recorded revisions

How each revision is replayed (`research/perf/replay.ts`):

- **Setup:** rebuild the checkout from `git archive`, a private copy of the recorded per-revision native install (offline `pnpm install` from the shared store), and the recorded `prior-cache`.
- **Features:** run `phase.ts` `features` with the recorded `features/request.json`, once per build, and require byte-identical `files` + `policies` vs the recorded `features/result.json`. That covers every policy order and selected set: `faster-selected`, `faster-file-selected`, the instability discount and all ablations.
- **Execution:** run the recorded `oracle` request (instrumented) once per build, and require identical module order, case identities (file, id, name, state) and errors vs the recorded `oracle/result.json`. Cases are compared per module by id because concurrent tests finish in any order, and Pathe prints its checkout path in test names, which is normalized.
- **Cache:** compare the resulting `.study-cache` (`faster-sources.json`, `results.json` without `duration`) with the recorded `oracle-cache`, *and* old vs new.
- **Old vs new:** both builds are cloned once and renamed into one fixed path before each run, so old vs new is compared **unmasked**.
- **Masking (recording only):** vs the recording, location-dependent fields are masked: each module's `shape` and the function hashes of modules with dynamic imports, which embed absolute import paths; and every function hash and `called` flag of the fork's own dist, whose V8 offsets come from the native file while the model comes from a Vite transform whose length depends on the fork path. Source hashes, function ids and all subject `called` flags stay compared. The masked counts are reported.
- **Run order:** builds run in seeded random order per revision.

| Subject | Revisions | Features = recorded (old / new) | Cases = recorded (old / new) | Cache = recorded, masked (old / new) | Old vs new: cases / cache (unmasked) | Test cases | Masked vs recording (shapes / fork fn / dyn-import fn) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pathe | all 51 | 51 / 51 | 51 / 51 | 51 / 51 | 51 / 51 | 19,133 | 3,540 / 328,452 / 434 |
| Valibot (`isolate: false`) | all 51 | 51 / 51 | 51 / 51 | 51 / 51 | 51 / 51 | 161,240 | 0 / 0 / 0 (no function data) |
| Unocss PR 5407 (control + target) | 2 | 2 / 2 | 2 / 2 | see §3.3 | 2 / 2 cases; cache identical except §3.3 | 2,120 (1 failing: the target's API-snapshot guard) | 37,360 / 577,436 / 1,256 |

Mismatches: **0** in features (policy orders, selected sets), **0** in cases and outcomes, **0** in caches for Pathe and Valibot. The Unocss cache differences are explained in §3.3.

Sources: `perf-eq-pathe-03`, `perf-eq-valibot-01` (49 revisions) + `perf-eq-valibot-02` (`1bb74`, `d4da6`, rerun after the harness fix in §5), `perf-eq-unocss-01`; summaries via `research/perf/equivalence-summary.ts`.

### 3.1 Selection safety: seeded-fault kill matrices

`research/perf/mutant-equivalence.ts` takes, for every revision in `mutants-{pathe,valibot}-01/mutants.json` with killed mutants, all frozen policy orders produced by each build. It requires them to equal the recorded orders, and per mutant it recomputes detection by the selected set together with APFD/APFDc/first-failure scores (`mutant-apfd.ts`'s `prioritizationScores`).

| Subject | Revisions with killed mutants | Killed mutants | Mismatches (orders, detection, scores) | `faster-selected` detects (old / new) |
| --- | --- | --- | --- | --- |
| Pathe | 18 | 107 | 0 | 107 / 107 |
| Valibot | 12 | 86 | 0 | 86 / 86 |

Output: `research/work/perf-report-01/mutants-equivalence.json`.

### 3.2 Unocss PR 5407 target

The features (all policy orders and selected sets) of control and target are byte-identical to the recording for both builds. The executions have identical outcomes, including the single failing API-snapshot guard, so the target's detection is unchanged.

### 3.3 Nondeterministic coverage flags in one Unocss test (both builds)

The only cache differences anywhere are 7 `called` flags out of 1,860 in `packages-integrations/webpack/test/webpack-assets.test.ts`. They belong to webpack plugin callbacks in `virtual-shared/integration/src/{hash,layers}.ts` and `packages-integrations/webpack/src/unplugin.ts`, which may or may not run before V8 coverage is taken. They flip between runs of the **same** build. Five of the flags across every Unocss run I have (T = called, F = not called):

| Revision | recorded | dev old/new | flake-a old/new | flake-b old/new | final old/new |
| --- | --- | --- | --- | --- | --- |
| 76d8c (control) | TTFFT | TTTTT / TTTTT | FFFFF / FFFFF | FFFFF / FFFFF | FFFFF / TTTTT |
| b6476 (target) | FFFFF | FFFFF / FFFFF | — | — | FFFFF / TTTTT |

With those flags excluded, old and new caches are identical on both revisions (98 tests, 9,340 function snapshots).

Earlier a similar one-off flip appeared in two `called` flags of the language-server's asynchronous config-reload listener (`onReload` / `reloadListeners`). It occurred once, for the new build, under load ≈ 25. Two more runs per build plus the recording all agreed, so it is the same kind of timing dependence.

## 4. Paired A/B benchmarks

Protocol:

- **Arms per unit:** each unit is one (revision, pair) in which old, new and stock each run once on the same restored checkout and prior cache. Within a revision, the six possible arm orders are used once each in seeded random order, so every arm occupies every position equally often.
- **Measures:** wall time from process spawn to exit (startup included, as in the studies), plus CPU time (user + sys of the Vitest process tree via `time -l`).
- **Statistics:** medians, paired differences, and 10,000-sample seeded bootstrap 95% intervals over units.
- **Revisions:** Valibot and Pathe use manifest entries 10, 20, 30, 40 × 6 pairs = 24 units; Unocss uses the PR 5407 target × 12 pairs.
- **Load:** I did not pause the main session's studies. Load before each run is recorded (`perf-bench-*.load.txt`, `load1Before` per run): two to three study processes were active throughout.

Wall time:

| Subject | Units | Median stock / old / new (s) | New − old, median [95% CI] | Units where new is faster | Overhead vs stock: old | Overhead vs stock: new | Load (median / max) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Valibot | 24 | 5.86 / 9.11 / 6.53 | −2.56 s [−3.22, −2.07] | 23/24 | +56.1% [48.5, 67.7] | **+9.9% [6.0, 18.1]** | 14.8 / 19.4 |
| Pathe | 24 | 0.94 / 1.20 / 1.07 | −107 ms [−182, −86] | 21/24 | +29.3% [20.6, 33.0] | **+12.4% [7.7, 17.8]** | 12.4 / 13.9 |
| Unocss target | 12 | __UNOCSS_WALL__ |

CPU time (user + sys, Vitest process and workers):

| Subject | Median stock / old / new (s) | New − old, median [95% CI] | Units with lower CPU | Overhead: old | Overhead: new |
| --- | --- | --- | --- | --- | --- |
| Valibot | 7.61 / 14.29 / 10.02 | −4.20 s [−4.45, −4.08] | 24/24 | +86.5% [80.6, 91.8] | +31.5% [27.4, 34.5] |
| Pathe | 1.35 / 1.89 / 1.74 | −160 ms [−200, −140] | 23/24 | +41.3% [38.5, 44.3] | +28.4% [25.5, 31.3] |
| Unocss target | __UNOCSS_CPU__ |

Median wall-time windows (before first module / modules / after last module, ms):

| Subject | stock | old | new |
| --- | --- | --- | --- |
| Valibot | 1,398 / 4,300 / 80 | 3,416 / 4,143 / 1,401 | 2,103 / 4,137 / 209 |
| Pathe | 734 / 156 / 59 | 912 / 167 / 127 | 798 / 170 / 96 |
| Unocss target | __UNOCSS_WINDOWS__ |

__UNOCSS_NOTE__

## 5. Harness bugs found and fixed during this work (no effect on the frozen studies)

Two bugs were in my replay tool, not in FASTER or in the study harness:

1. **Fork location leaking into comparisons.** The recorded caches store fork-dist paths relative to the checkout (`../../../../packages/...`), so the replay checkout has to sit at the study's depth (`research/work/<dir>/checkout`). Builds staged at different paths also produce different function models for the fork's dist and different absolute import strings. Fix: both builds run from one fixed path; the masking rules in §3 apply to the recording comparison only.
2. **Stale facades across fork directories.** Per-revision installs are shared between runs, and each install's facade had been created once, linked to the fork directory of the first run that used it. A run with another fork directory reused that link. After I pruned a fork directory, Node resolved `vitest` up the tree to the **main checkout** (the old build).
   - **Invalidated:** a first round of Valibot/Pathe benchmarks (deleted), one Valibot profile pair (redone), and 4 equivalence rows whose facade pointed at a concurrently toggled directory.
   - **Clean reruns:** the full Pathe equivalence and the two affected Valibot revisions were rerun cleanly; all identical.
   - **Fix (`68586c391`):** one facade per fork directory, plus a hard check before every run that the subject's `vitest` resolves to the active build.

All numbers in this report come from runs after the fix, or from runs whose facades were created for their own fork directory.

## 6. What remains, and why

- **Valibot (+10%):** the remaining main-thread work is Vite `ssr` transforms of ~830 modules to discover the dependency graph (≈ 1.3–1.4 s CPU vs 0.7 s stock). They now overlap worker start-up, but its `jsdom` tests use the `client` environment, so the transforms are not reused. Making them cheaper without changing the graph would mean changing how Vite resolves imports. A persistent dependency cache keyed by content would not be exactly equivalent (resolution depends on the file system and config).
- **Pathe (+12%):** what remains is (a) V8 precise coverage in workers, (b) capture transforms and function models of the 26 fork dist files the harness makes FASTER track (≈ 0.1 s), and (c) save and state I/O. (b) disappears in a normal install where `vitest` is under `node_modules`. Excluding the runner's own packages from tracking would remove it in the harness too, but it changes the cache contents (no fork entries), so it was not done.
- **Unocss:** what remains is in the workers: V8 block coverage (`detailed: true`) in 98 isolated forks and the payload sent back per file. Function-level coverage (`detailed: false`) or trimming the payload in the worker could reduce it. The first changes what V8 reports (equivalence would only be empirical); the second needs a worker-side flag. Neither was done.

## 7. Repository checks

| Check | Result |
| --- | --- |
| `pnpm build` | passes (old and new; old reproduces the recorded hashes byte for byte) |
| `pnpm typecheck` | passes |
| `pnpm lint` | passes |
| FASTER tests (`test/core`, `faster*`: 8 files × 3 pools) | 165 passed |
| `test/core` full suite | 630 files, 5,697 tests passed (63 expected fail, 249 skipped, 75 todo) |
| Research harness tests (`study`, `mutants`, `summarize` node tests; `research/tests` Python) | 13 + 4 + 4 passed; 15 passed |
| New tests discriminate | "keeps `coverage/`" fails on old; the pre-run snapshot test fails with the gate removed |

## 8. Reproduce

Paths assume the main checkout at `$MAIN=/Users/tiagol./Documents/pesquisa/faster` and Node 22.22.2. The harness copy must be in `research/javascript` of both builds.

```sh
# Builds
git worktree add --detach $MAIN/.claude/worktrees/faster-perf-baseline-997c738 997c7387c
(cd $MAIN/.claude/worktrees/faster-perf-baseline-997c738 && pnpm install --frozen-lockfile --prefer-offline && pnpm build)
(cd <this worktree> && pnpm install --frozen-lockfile --prefer-offline && pnpm build)
cp -R $MAIN/research/javascript <each build>/research/javascript

# Old build equals the recorded implementation
python3 - <<'EOF'
import json, hashlib, os
root = '<old build>'
recorded = json.load(open('$MAIN/research/work/valibot-window50-study-01/implementation-sha256.json'))
print([p for p, d in recorded.items() if not p.startswith('research/')
       and hashlib.sha256(open(os.path.join(root, p), 'rb').read()).hexdigest() != d])  # []
EOF

# Equivalence (forks dir per concurrent run), then summaries
export COREPACK_HOME=$MAIN/research/work/toolchain/corepack FASTER_MAIN_REPO=$MAIN W=$MAIN/research/work OLD=<old build>
node --import tsx research/perf/replay.ts --study $W/pathe-window50-study-01 --out $W/perf-eq-pathe-03 --forks $W/perf-forks-eq --builds old=$OLD,new=$PWD
node --import tsx research/perf/replay.ts --study $W/valibot-window50-study-01 --out $W/perf-eq-valibot-01 --forks $W/perf-forks-valibot --builds old=$OLD,new=$PWD
node --import tsx research/perf/replay.ts --study $W/unocss-pr5407-study-03 --out $W/perf-eq-unocss-01 --forks $W/perf-forks-eq --project unit --isolate --builds old=$OLD,new=$PWD
node --import tsx research/perf/equivalence-summary.ts pathe=$W/perf-eq-pathe-03/rows.json valibot=$W/perf-eq-valibot-01/rows.json unocss=$W/perf-eq-unocss-01/rows.json
node --import tsx research/perf/mutant-equivalence.ts $W/perf-report-01/mutants-equivalence.json \
  $W/pathe-window50-study-01=$W/mutants-pathe-01=$W/perf-eq-pathe-03 \
  $W/valibot-window50-study-01=$W/mutants-valibot-01=$W/perf-eq-valibot-02,$W/perf-eq-valibot-01

# Benchmarks (Unocss equivalence, Valibot, Pathe, Unocss benches in sequence), then summaries
sh research/perf/final-runs.sh
node --import tsx research/perf/bench-summary.ts valibot=$W/perf-bench-valibot-02/rows.json pathe=$W/perf-bench-pathe-02/rows.json unocss=$W/perf-bench-unocss-03/rows.json

# Profiles
node --import tsx research/perf/replay.ts --study $W/valibot-window50-study-01 --out $W/perf-profile-02-valibot --forks $W/perf-forks-prof --builds old=$OLD,new=$PWD --revisions d2aa25efbd --checks '' --bench 2 --stock --cpu-prof
node --import tsx research/perf/profile-summary.ts $W/perf-profile-02-valibot/revisions/*/bench/*

# Repository checks
pnpm build && pnpm typecheck && pnpm lint
(cd test/core && CI=true pnpm test faster && CI=true pnpm test)
node --import tsx --test research/javascript/study.test.ts   # likewise mutants.test.ts, summarize.test.ts
python3 -m unittest discover -s research/tests
```
