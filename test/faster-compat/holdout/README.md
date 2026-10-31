# Holdout replay: fork vs. plugin on real commits

`test/faster-compat` shows on synthetic scenarios that the `vitest-faster`
plugin makes the FASTER fork's decisions. This directory checks the same claim
on real revisions of two holdout subjects, Vue core and VueUse. It also
measures whether the plugin costs any time relative to the fork.

```bash
pnpm install && pnpm build
node test/faster-compat/holdout/run.mjs            # every subject in subjects.json
node test/faster-compat/holdout/run.mjs vue-core   # one subject
```

Environment variables:
- `HOLDOUT_WORK` sets the work directory. The default is `.work` here.
- `HOLDOUT_TIMING` sets how many interleaved timing repetitions run per
  configuration. The default is 3; `0` skips timing.
- `FASTER_FORK_REF` sets the commit of this repository the fork host is built
  from. The default is `3e78239dc`, the commit that merged the plugin.

The results go to `results/<subject>.json`. `results/SUMMARY.md` gives the
tables.

The committed results were recorded at `73804bff8`, where the fork lived in
this repository's `packages/`. Its decision code and plugin are identical to
those at `3e78239dc`; the only difference in the fork is an unrelated fix that
applies `--faster.*` CLI flags to every project.

The committed `results/<subject>.json` came from a version of `run.mjs` with
the same decisions, runs and comparisons as the committed one. The committed
version adds two diagnostics:
- `persistedState.detail` lists, for each differing test, the functions and
  fields that differ (before, it named only the test);
- the raw per-revision states are kept in the work directory.

It also exports the helpers that `determinism.mjs` and `small-runs.mjs` use.

## Findings (run of 2026-10-31)

There are 10 target revisions: 4 Vue core, 6 VueUse.

- **Selected set (`selectAffected`):** identical at every target.
- **Full order and selected order, with shared durations:** identical at every
  target, in both directions.
  - On Vue core this compares the plugin with the fork's `FasterSequencer`.
  - The fork as configured orders Vue core with `BaseSequencer`; see "The fork
    ignores FASTER's order when `test.sequence` is set".
- **Full order, with each host's own durations:** differs at every target.
  - Durations come from separate runs, so 6–14% of file pairs swap duration
    rank.
  - The order uses those ranks within each bucket.
- **Per-file outcomes:** identical at every revision. Every test of every
  file has the same state.
- **Persisted state:** identical at every revision except three.
  - **Vue core `243aabcc`:** `runtime-core/__tests__/hydration.spec.ts`
    records different `called` flags for `runtime-dom/src/components/Transition.ts`
    from one run to the next, on the same host.
    `results/vue-core.fork-repeats.json` shows this between two consecutive
    fork runs of one clone. An earlier `determinism.mjs` run showed it within
    both hosts. The committed `vue-core.determinism.json` comes from a rerun in
    which the test happened to behave the same every time.
  - **VueUse `c5a08502` and `5cc18005`:** `test/package-json-export.test.ts`
    records one of two structural hashes for its own module, from one run to
    the next.
    - Seen only on the plugin host: in 2 of its 7 chain runs, and its 3
      `determinism.mjs` repeats alternated between the two values.
    - The fork's 10 full runs (7 chain, 3 repeats) never varied.
    - Single-file runs and 3 instrumented full runs did not reproduce it.
    - The root cause is not identified.
    - Decisions never read a test file's own function snapshot; its own
      changes are detected by source hash. So this cannot change an order or a
      selection.
- **Performance:**
  - On full runs and on runs of the files FASTER selects (16–60 files), the
    hosts are within run-to-run noise:
    - full runs: plugin over fork 0.987 (Vue core) and 0.994 (VueUse);
    - selected files: 0.992 and 1.017.
  - On one-file runs, the plugin adds a fixed 0.26 s (Vue core) to 1.0 s
    (VueUse).
    - The gap appears only with change tracking on.
    - It matches the pre-run source snapshot. The plugin takes it before
      workers start; the fork takes it while its worker starts up.

## Hosts

These are the hosts of `test/faster-compat`:

- **fork**: `packages/faster` at `FASTER_FORK_REF`, built by
  `../scripts/pack-fork.mjs` from that commit, packed and installed under the
  name `vitest`, with `@vitest/coverage-v8@4.1.7`.
- **plugin**: upstream `vitest@4.1.7` and `@vitest/coverage-v8@4.1.7`, with
  `packages/vitest-faster` packed.

Each host is a standalone install. It also pins the subject's own `vite` (and
`jsdom` for VueUse), so both hosts run the subject on the Vite the subject
locks.

## Protocol per subject

Each host gets its own clone. Its FASTER state lives in that clone's
`node_modules/.vite/vitest`, so each host has a separate cache.

For the warm-up and then for each target, in chain order:

1. Check out the revision. Install it with the `packageManager` pnpm version
   and `--frozen-lockfile`.
2. Point the clone's `node_modules/vitest` and `@vitest/coverage-v8` at the
   host's install. On the plugin host, also point `vitest-faster` there.
3. Patch the root `vitest.config.ts`:
   - Both hosts get `maxWorkers: 1` and `fileParallelism: false`.
   - Both hosts get the FASTER options from `HOLDOUT_FASTER`. The fork reads
     them as `test.faster`; the plugin host as `faster()` in the root plugins.
   - Projects inherit both settings through `extends`.
4. Compute the decisions without running any test (`decide.mjs`):
   - The full order: the host's sequencer `sort` over every file of project
     `unit`.
   - The `selectAffected` set and its order: Vitest's
     `getRelevantTestSpecifications`, as the run would call it.
   - Options: `optimizeFor: 'apfd'` and `selectAffected: true`.
5. Repeat step 4 with the durations swapped:
   - the plugin host ranks by the fork's recorded durations;
   - the fork ranks by the plugin's recorded durations.

   Only durations are replaced; failure flags and source state stay the
   host's own.
6. Run the full suite on each host with `optimizeFor: 'apfd'`, which advances
   its history. Hosts alternate which runs first.
   - `reporter.mjs` records the order files started and each file's and test's
     outcome.
   - The persisted `faster-sources.json` is read after each run.

## Comparison

At every revision the script compares:

- the full order;
- the selected set and its order;
- the order under shared durations, in both directions;
- the per-file outcomes: file state and every test's state;
- the persisted FASTER state, by `canonicalStates` from
  `test/faster-compat/test/harness.ts`. Structural and function hashes are
  compared by first-appearance ordinal; source hashes, paths, function
  identities and call observations are compared as they are.

It also checks that each host's executed order equals the order it decided
beforehand.

### The fork ignores FASTER's order when `test.sequence` is set

The fork installs `FasterSequencer` only when the user configured no
sequencer. In `resolveConfig`, `resolved.sequence` is the same object as the
user's `options.sequence` whenever the config contains a `sequence` key. The
fork assigns the default `BaseSequencer` to that object first. Its check for a
user sequencer then reads the same object, finds a sequencer and keeps
`BaseSequencer`.

So any config with a `test.sequence` object loses FASTER's ordering in the
fork, even `sequence: {}`. Vue core's config sets
`sequence: { hooks: 'list' }`. Selection and history are not affected.

The plugin treats `BaseSequencer` as Vitest's default and orders with FASTER,
as documented.

When the fork's configured sequencer is not `FasterSequencer`, `decide.mjs`
also computes the order with the fork's own `FasterSequencer`. That class is
not exported, so the script takes it from a configuration without `sequence`.
The results report both comparisons:
- `comparison.fullOrder` and `comparison.selectedOrder`: against the order
  the fork used;
- `comparison.forkFasterSequencer`: against the order FASTER computes in the
  fork.

On Vue core, the fork's executed warm-up order differs from its decided
order. `BaseSequencer` sorts by file sizes that Vitest records only during a
run, and the decision step runs no tests.

Durations come from separate runs, so two hosts can rank files with
near-equal durations differently. The order uses those ranks within each
bucket. That is why the shared-duration orders are reported alongside the
own-history orders.

## Nondeterministic observations

A test's recorded function observations (`called` flags) can differ between
two runs of the same host. `run.mjs` alone cannot tell such run-to-run
variation from a host difference. `determinism.mjs` checks for it:

```bash
node test/faster-compat/holdout/determinism.mjs [subject...]
```

It runs after `run.mjs`, on the clones left at the last revision. Each host
runs the full suite `HOLDOUT_REPEATS` times (default 3), alternating hosts.
The script then compares the canonical states:
- with the same host's previous run;
- with the other host's run in the same round.

The results go to `results/<subject>.determinism.json`. `run.mjs` also keeps
each revision's raw persisted state in the work directory, as
`state-<host>-<index>.json`.

## Timing

After the chain, the last revision is run `HOLDOUT_TIMING` times in each of
four configurations, in rotating order:

- the fork, FASTER on;
- the plugin, FASTER on;
- the fork, `faster: { enabled: false }`;
- the plugin, `faster({ enabled: false })`, where the plugin does nothing,
  which is plain upstream Vitest 4.1.7.

The summary reports these ratios of medians:

- plugin over fork, with FASTER on;
- each host's FASTER-on over FASTER-off.

`decisionTimings` holds the time each host took to sort and to select. The two
hosts' sort times are not comparable:
- the plugin's `sort` waits for the pre-run source snapshot;
- the fork takes the same snapshot when its pool starts, overlapped with
  worker startup, so its `sort` time excludes it.

Full runs include both. Small runs weigh fixed per-run costs the most.
`small-runs.mjs` times them on the clones `run.mjs` left at the last revision:

```bash
node test/faster-compat/holdout/small-runs.mjs [subject...]
```

It runs the files FASTER selected at the last target, and the first of them
alone, `HOLDOUT_SMALL_REPEATS` times per host (default 5), alternating hosts.
The results go to `results/<subject>.small-runs.json`.

`summarize.mjs` writes `results/SUMMARY.md` from all result files.
