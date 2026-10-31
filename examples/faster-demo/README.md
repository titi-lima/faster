# FASTER demo

A small Vitest 4.1 project that makes FASTER's scheduling visible. The tests
import from `vitest` as usual; only `vite.config.ts` adds the `vitest-faster`
plugin.

## Run it

From the repository root:

```bash
pnpm install && pnpm build
pnpm -C examples/faster-demo demo:order
```

The `[execution-order]` lines show the order in which tests start. The
checked-in `.faster/priorities.json` gives the availability and checkout tests
the highest producer scores, so they run first on the first run.

## Show changed-source prioritization

1. Run `pnpm -C examples/faster-demo demo:order` once.
2. Edit `examples/faster-demo/src/catalog.ts` (change a product name or price).
3. Run the same command again.

The catalog and checkout tests move to the front: FASTER follows the change
from `catalog.ts` to the tests that called the edited functions in the
previous run. The full suite still runs; without `selectAffected`, FASTER only
changes the order.

## Show failure ordering

```bash
pnpm -C examples/faster-demo demo:failure
pnpm -C examples/faster-demo demo:apfd
```

The first command fails `test/failure-demo.test.ts` on purpose. With
`optimizeFor: 'apfd'`, the next run starts that file first, because it failed
in the previous run.

With the default `optimizeFor: 'dx'`, `demo:order` runs the same file last
instead: a known failure in a file you did not change, and whose sources did
not change, would only repeat what you already know. Edit the test file and it
moves to the front again.

## Compare with plain Vitest

```bash
pnpm -C examples/faster-demo test:vitest
```

`vitest-faster run --no-faster` runs the same project with FASTER disabled.
