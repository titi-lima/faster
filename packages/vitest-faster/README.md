# vitest-faster

FASTER test prioritization and selection for upstream Vitest. It orders test
files by previous failures and by source changes, checked down to the
functions each test called, then by prior duration and file size. With
`selectAffected` it runs only edited, affected, unknown and failing test files.

The plugin runs the FASTER fork's own decision code, bundled unchanged, on
Vitest's public extension points. On the same inputs it makes the fork's
decisions: same files, same order, same tests inside each file, same
selection. `test/faster-compat` in the FASTER repository checks this on every
supported Vitest release.

## Which setup to use

| Your Vitest | Setup | Function-level relevance |
| --- | --- | --- |
| 5.x | [`vitest-faster` plugin](#vitest-5) | yes |
| 4.1.x | [`vitest-faster` plugin](#vitest-41) (or the [fork](#the-fork-vitest-417)) | yes |
| 4.0.x | [`vitest-faster` plugin](#vitest-40) | yes |
| 3.x and older | not supported, [upgrade to 4 or 5](#vitest-3-and-older) | n/a |

Function-level relevance applies to isolated Node projects collecting V8
coverage, exactly as in the fork. See [where it does not apply](#where-function-level-relevance-does-not-apply).

## Installing before the package is published

`vitest-faster` is not on npm yet. Build and pack it from the FASTER
repository, then install the tarball wherever the commands below say
`vitest-faster`:

```bash
pnpm install && pnpm build
pnpm -C packages/vitest-faster pack
```

```bash
npm i -D /path/to/faster/packages/vitest-faster/vitest-faster-0.1.0.tgz
```

## Vitest 5

```bash
npm i -D vitest-faster @vitest/coverage-v8@5
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import { faster } from 'vitest-faster'

export default defineConfig({
  plugins: [faster({ selectAffected: true })],
})
```

Run Vitest as usual (`npx vitest`). Use `npx vitest-faster` instead when you
want to pass `--faster.*` flags.

## Vitest 4.1

```bash
npm i -D vitest-faster @vitest/coverage-v8@4.1
```

The configuration is the same as for Vitest 5.

## Vitest 4.0

```bash
npm i -D vitest-faster @vitest/coverage-v8@4.0
```

The configuration is the same as for Vitest 5. Vitest 4.0 has no
`experimental.vcsProvider`, so `faster.changed: '<revision>'` always uses Git.

## The fork (Vitest 4.1.7)

The FASTER fork replaces Vitest itself and enables FASTER by default. Its
`packages/faster` package is not published; `faster` on npm is an unrelated
project, so never install `npm:faster`. Pack it from the repository and
install it under the name `vitest`:

```bash
pnpm install && pnpm build
pnpm -C packages/faster pack
```

```bash
npm i -D vitest@file:/path/to/faster/packages/faster/faster-4.1.7-faster.0.tgz @vitest/coverage-v8@4.1.7
```

Configure it with `test.faster` (see the fork's `faster` config docs). Keep
using it if you need `immediateFailureOutput`.

## Vitest 3 and older

Not supported. Vitest 3 runs tests through vite-node instead of the Vite
module runner, and there FASTER recorded no function observations at all; it
would silently fall back to dependency-level relevance. The plugin stops with
an error on Vitest 3 rather than run in that degraded mode.

## Options

`faster(options)` takes the fork's options. A project's `test.faster` overrides
them, so a fork configuration works unchanged once the plugin is added.

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `faster(false)` disables FASTER for that project |
| `optimizeFor` | `'dx'` | `'dx'` defers unchanged, unaffected known failures to the end; `'apfd'` keeps them first |
| `changed` | `true` | compare with each test's previous run; a Git revision also adds changes since it; `false` disables change tracking |
| `selectAffected` | `false` | run only edited, unknown, affected and previously failing files (requires `changed`) |
| `priorityFile` | `.faster/priorities.json` | optional producer scores, per file or per test (`file::suite::test`) |
| `immediateFailureOutput` | — | accepted for parity with the fork; the plugin leaves Vitest's reporters unchanged |

CLI flags (with `npx vitest-faster`): `--faster.selectAffected`,
`--faster.optimizeFor=apfd`, `--faster.changed[=<revision>]`,
`--faster.priorityFile=<path>`, `--no-faster`. They override every project's
options. `VITEST_FASTER_OPTIONS='{"selectAffected":true}'` does the same
without the wrapper.

### Projects

FASTER applies to each project whose configuration contains the plugin, and
the root configuration must contain it for FASTER's ordering. With inline
projects, use `extends: true` or add `faster()` to each project:

```ts
export default defineConfig({
  plugins: [faster()],
  test: {
    projects: [
      { extends: true, test: { name: 'unit' } },
      { plugins: [faster({ optimizeFor: 'apfd' })], test: { name: 'integration' } },
    ],
  },
})
```

A project without the plugin behaves like `faster: false` in the fork.

## What the plugin changes in your setup

- **Coverage.** Function-level relevance needs V8 coverage. Without your own
  coverage settings, the plugin enables V8 collection only, with no reports;
  temporary files go to Vitest's cache directory. With your own V8 coverage
  settings, reports and thresholds work as before. With Istanbul or a custom
  provider, the plugin leaves coverage alone and FASTER uses dependency-level
  relevance, as the fork does.
- **Sequencer.** FASTER orders the files unless you configured
  `sequence.sequencer` yourself. Your sequencer then keeps ordering, and
  FASTER still records history and selects.
- **Runner.** Per-test producer scores install a small runner that extends
  Vitest's default runner. Projects with their own `runner` keep it and skip
  per-test priorities, with a warning.
- **History.** FASTER keeps its own `faster-results.json` and
  `faster-sources.json` in Vitest's cache directory. `vitest --clearCache`
  clears them.

## Where function-level relevance does not apply

The plugin keeps exactly the fork's fallbacks. These use dependency-level
relevance: any change to an imported source marks the test as affected.

- projects with `isolate: false`
- browser mode
- `experimental.viteModuleRunner: false`
- coverage providers other than V8
- changes found through a Git revision (`changed: '<revision>'`)
- typecheck (`*.test-d.ts`) files
- tests and sources without a recorded observation yet (first run, a changed
  dependency graph, a source edited during the run)
