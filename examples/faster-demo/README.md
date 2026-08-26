# Faster demo

This is a small Vitest project that makes Faster's scheduling visible. The
tests keep importing from `vitest`; only the config and command use Faster.

## Run it

From the monorepo root:

```bash
pnpm install
pnpm --dir examples/faster-demo demo:order
```

The `[execution-order]` lines show the order in which tests are collected and
started. The checked-in `.faster/priorities.json` gives the checkout tests the
highest baseline scores.

## Show changed-source prioritization

1. Run `pnpm --dir examples/faster-demo demo:order` once.
2. Edit `examples/faster-demo/src/catalog.ts` (change a product name or price).
3. Run the same command again.

The catalog and checkout tests move to the front because Faster follows Vite's
module graph from the changed source to dependent tests. The full suite still
runs; Faster changes the order rather than filtering tests.

To compare with the declaration order (Faster disabled), run:

```bash
pnpm --dir examples/faster-demo test:vitest
```

To demonstrate immediate failure output:

```bash
pnpm --dir examples/faster-demo demo:failure
```

That command is intentionally expected to exit with a failing test so the
failure block can be seen immediately.
