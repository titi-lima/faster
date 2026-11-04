# FASTER's decision code

The files in this directory are the FASTER fork's decision code: test-file
ordering, `selectAffected`, change and function-level relevance, producer
scores and the per-test ordering inside a file. They were moved here from the
fork's `packages/vitest` and `packages/runner`; imports of the fork's internal
modules point at `../shims`, which re-export the same types from upstream
Vitest and the two helpers the code needs.

The code no longer has to match the fork's files. `test/faster-compat` runs
the fork the FASTER evaluation ran (`3e78239dc`) next to the plugin and
compares the files and tests each runs, their order, the exit codes and the
recorded state, so a change that alters a decision shows up there.

What changed since the fork:

- `sourceChanges.ts` stores each source version, function model and function
  snapshot once instead of once per test file, compressed with Brotli in
  `faster-sources.json.br`, and forgets test files that no longer exist. A
  test file deleted and later created again at the same path is therefore
  new to FASTER, where the fork compared it with its last run.
- `functionCoverage.ts` keeps only the first range of each function from the
  V8 coverage of a test file as it arrives, and stores 96-bit hashes of
  function bodies and module shapes instead of 160-bit ones.
