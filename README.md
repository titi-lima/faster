# vitest-faster

FASTER test prioritization and selection for upstream Vitest 4.0, 4.1 and 5,
as a Vite plugin.

FASTER started as a fork of Vitest. This repository now holds only the plugin,
which runs the fork's decision code on Vitest's public extension points, and
the suite that shows the plugin makes the fork's decisions.

## What it does

On every run, FASTER orders the test files and, if you ask it to, runs only
some of them. It decides from what it recorded in earlier runs:

- **Failures.** Files that failed in the previous run go first. With the
  default `optimizeFor: 'dx'`, a failure in a file whose test and sources did
  not change goes last instead, since rerunning it first would only repeat
  what you already know. `optimizeFor: 'apfd'` keeps every failure first.
- **Changes.** Among failing files and among the others, new files and files
  whose test changed go first, then files affected by a changed source. For isolated Node projects with V8 coverage,
  "affected" is decided per function: a test is affected only if it called a
  function whose body changed since its previous run. Elsewhere any change to
  an imported module counts.
- **Producer scores.** An optional `.faster/priorities.json` gives scores per
  file or per test. Within each of those groups, scored files go first, highest
  score first; the scores also order the tests within a file.
- **Cost.** Ties are broken by a score that weighs the previous duration most
  and the file size less, highest first.
- **Selection.** With `selectAffected: true`, only edited, affected, unknown
  and previously failing test files run.

FASTER keeps its history in Vitest's cache directory, next to Vitest's own.

## Setup

`vitest-faster` is not on npm yet. Build and pack it from this repository:

```bash
pnpm install && pnpm build
pnpm -C packages/vitest-faster pack
```

Then install the tarball together with the V8 coverage provider of your
Vitest version, which FASTER uses for function-level relevance:

| Your Vitest | Install | Notes |
| --- | --- | --- |
| 5.x | `npm i -D ./vitest-faster-0.1.0.tgz @vitest/coverage-v8@5` | |
| 4.1.x | `npm i -D ./vitest-faster-0.1.0.tgz @vitest/coverage-v8@4.1` | |
| 4.0.x | `npm i -D ./vitest-faster-0.1.0.tgz @vitest/coverage-v8@4.0` | no `experimental.vcsProvider`, so `changed: '<revision>'` always uses Git |
| 3.x and older | not supported | the plugin stops with an error |

On Vitest 3, tests run through vite-node, where FASTER records no function
observations and would silently fall back to dependency-level relevance. The
plugin refuses to run there rather than degrade.

The configuration is the same for every supported version:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import { faster } from 'vitest-faster'

export default defineConfig({
  plugins: [faster({ selectAffected: true })],
})
```

Run Vitest as usual. To pass FASTER options on the command line, run
`npx vitest-faster` instead, which accepts `--faster.selectAffected`,
`--faster.optimizeFor=apfd`, `--faster.changed[=<revision>]`,
`--faster.priorityFile=<path>` and `--no-faster` and hands everything else to
Vitest.

[`packages/vitest-faster/README.md`](./packages/vitest-faster/README.md)
lists every option, how the plugin behaves with projects, coverage, custom
sequencers and runners, and where function-level relevance does not apply.
[`examples/faster-demo`](./examples/faster-demo) is a small project that makes
the ordering visible.

## How we check that the plugin makes the fork's decisions

`packages/vitest-faster/src/decision` holds the fork's decision code: the
ordering, selection, change and function-level relevance, and per-test
ordering. It was moved from the fork's `packages/vitest` and
`packages/runner`. Since then it stores what it records more compactly (see
[History](./packages/vitest-faster/README.md#what-the-plugin-changes-in-your-setup)),
and two checks make sure it still decides as the fork the FASTER evaluation
ran.

### On the suite's scenarios

`test/faster-compat` runs the same scenarios on five standalone installs
under `hosts/`, set up outside the workspace as a user would install them:

- `fork`: the fork, built from `3e78239dc` (or `FASTER_FORK_REF`) by
  `scripts/pack-fork.mjs` in a temporary directory and installed as `vitest`;
- `vitest-4.0`, `vitest-4.1`, `vitest-5`: Vitest 4.0.18, 4.1.7 and 5.0.5 with
  the packed plugin;
- `vitest-3.2`: Vitest 3.2.7 with the plugin, which must refuse to run.

Each scenario writes a small project, then runs a sequence of steps against
it: cold runs, edits to called and uncalled functions, edits to tests, new and
failing tests, projects with different isolation, producer scores, Git
revisions, user coverage, sharding and CLI flags. After every step the suite
compares each plugin host with the fork:

- the test files and tests that ran, in the order they started;
- the exit code;
- FASTER's persisted state, expanded from the plugin's compact layout into
  the fork's, with structural hashes replaced by ordinals because they embed
  each install's paths;
- whether coverage reports were written.

```bash
pnpm install && pnpm build
pnpm test
```

The first run builds the fork, which takes a few minutes and needs Node
^20.19.0 or >=22.12.0; later runs reuse the tarball cached in
`test/faster-compat/.fork`.

### On real commits

`test/faster-compat/holdout` replays 10 real revisions of Vue core and VueUse
through the fork and through Vitest 4.1.7 with the plugin. It compares the
selected files, the full and selected orders, per-file outcomes, persisted
state and run time. It clones the subjects and installs every revision, so it
is not part of `pnpm test`; see its
[README](./test/faster-compat/holdout/README.md) for how to run it and what
it found.

## Repository layout

- `packages/vitest-faster`: the plugin.
- `test/faster-compat`: the equivalence suite, its hosts and the holdout
  replay.
- `examples/faster-demo`: a demo project.
- `research`: the research workspace of the FASTER paper. Its experiments ran
  on the fork; run them from a commit that still holds it, such as
  `3e78239dc`.

## License

[MIT](./LICENSE). The decision code comes from the FASTER fork of Vitest,
© VoidZero Inc. and Vitest contributors.
