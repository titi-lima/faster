# vitest-faster agent guide

This repository holds `vitest-faster`, a Vite plugin that brings FASTER test
prioritization and selection to upstream Vitest 4.0, 4.1 and 5, and the suite
that shows it makes the same decisions as the FASTER fork of Vitest.

## Layout

- `packages/vitest-faster` - the plugin.
  - `src/decision` - FASTER's decision code, moved from the fork. It must stay
    identical to the fork's files except for import specifiers; see
    `src/decision/README.md`. Do not edit, reformat or reorder it.
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
- `pnpm check:decision-code` compares `src/decision` with the fork.
- `pnpm test` installs the hosts (building the fork the first time) and runs
  `test/faster-compat`.

Do NOT use `--` when passing test filters to pnpm; it drops the filter.

When writing tests, prefer `toMatchInlineSnapshot` over `toContain`. Never
mock anything in tests.
