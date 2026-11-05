# vitest-faster agent guide

This repository holds `vitest-faster`, a Vite plugin that brings FASTER test
prioritization and selection to upstream Vitest 4.0, 4.1 and 5, and the suite
that shows it makes the same decisions as the FASTER fork of Vitest.

## Layout

- `packages/vitest-faster` - the plugin.
  - `src/decision` - FASTER's decision code, moved from the fork. It no
    longer has to match the fork's files; `pnpm test` compares its decisions
    with those of the fork the paper evaluated, so a change that alters a
    decision shows up there.
  - `src/*.ts` - the host layer that runs the decision code on Vitest's public
    extension points.
- `test/faster-compat` - equivalence suite. Hosts under `hosts/` install
  upstream Vitest releases and the fork (built from a commit of this
  repository) outside the workspace. `holdout/` replays real commits.
- `examples/faster-demo` - a small project using the plugin.
- `research/` - the paper's research workspace. Leave it alone.

## Commands

- `pnpm install`, then `pnpm build` to build the plugin.
- `pnpm lint:fix` after changes; `pnpm typecheck` for types.
- `pnpm test` installs the hosts (building the fork the first time) and runs
  `test/faster-compat`.

Do NOT use `--` when passing test filters to pnpm; it drops the filter.

When writing tests, prefer `toMatchInlineSnapshot` over `toContain`. Never
mock anything in tests.
