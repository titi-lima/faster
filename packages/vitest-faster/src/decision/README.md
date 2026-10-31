# FASTER's decision code

The files in this directory are the FASTER fork's decision code: test-file
ordering, `selectAffected`, change and function-level relevance, producer
scores and the per-test ordering inside a file. They were moved here from the
fork's `packages/vitest` and `packages/runner` and must stay identical to the
fork's files except for the module specifiers of their imports, so that the
published plugin is the code the FASTER evaluation ran.

`test/faster-compat/scripts/check-decision-code.mjs` compares each file with
its origin at a commit that still holds the fork, and
`test/faster-compat/test/decision-code.test.ts` runs that comparison.
Imports of the fork's internal modules point at `../shims`, which re-export
the same types from upstream Vitest and the two helpers the code needs.

Change anything else here only together with the fork commit the check uses.
