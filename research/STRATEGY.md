# Strategy and implementation map

FASTER is a Vitest fork that orders test files using source changes, previous
execution observations and a deterministic similarity order. Running fewer files
is an optional selection step. Java experiments use a research adapter around
native Java execution; Vitest does not execute Java tests.

## Core code to review

| Research concern | Production implementation |
| --- | --- |
| Assemble global FAST order, buckets and within-bucket ordering | [FasterSequencer.ts](../packages/vitest/src/node/sequencers/FasterSequencer.ts) |
| Duration/size rank calculation and the fixed 0.1 weight | [apfdPriority.ts](../packages/vitest/src/node/faster/apfdPriority.ts) |
| Deterministic MinHash diversity kernel | [priority.ts](../packages/runner/src/utils/priority.ts), `getSimilarityOrder` |
| Persistent observations, source hashes and cache lifecycle | [sourceChanges.ts](../packages/vitest/src/node/faster/sourceChanges.ts) |
| Transitive Vite dependency traversal | [affectedTests.ts](../packages/vitest/src/node/faster/affectedTests.ts) |
| V8 coverage, transformed-function fingerprints and fallbacks | [functionCoverage.ts](../packages/vitest/src/node/faster/functionCoverage.ts) |
| Optional selection and explicit full-suite rerun guard | [specifications.ts](../packages/vitest/src/node/specifications.ts), `getRelevantTestSpecifications` |
| Configuration defaults and validation | [priorityManifest.ts](../packages/vitest/src/node/faster/priorityManifest.ts) |
| Behavioral checks | [Faster integration tests](../test/core/test/faster-function-coverage.test.ts) and adjacent `faster-*.test.ts` files |

`adapters/order.ts` is a single-project experimental adapter. It calls the
production MinHash and rank functions; it reconstructs the bucket rule for Java
inputs. It does not implement Vitest project grouping, producer overrides or
revision-related filtering. Native JavaScript runs use `FasterSequencer` itself.

## Formal APFD policy

For a current test file/class t, let:

- F(t): its last completed recorded execution failed.
- K(t): a usable previous observation exists.
- T(t): its own source changed relative to that observation.
- A(t): a tracked dependency changed, conservatively refined by function/method
  observations when that experiment enables finer granularity.
- D(t): previous duration; B(t): current test source size in **bytes**.

Define category C(t) = 0 for unknown/new/changed tests (`!K || T`), 1 for affected
tests (`A`), and 2 otherwise. The APFD bucket is:

```text
bucket(t) = 3 × !F(t) + C(t)
```

The six buckets, in execution order, are:

| Bucket | Previous result | Change category |
| --- | --- | --- |
| 0 | Failed | Unknown/new or own source changed |
| 1 | Failed | Affected dependency |
| 2 | Failed | Remaining |
| 3 | Passed/no prior failure | Unknown/new or own source changed |
| 4 | Passed/no prior failure | Affected dependency |
| 5 | Passed/no prior failure | Remaining |

For each distinct input value within a project, R(x) is its ascending distinct
rank divided by `max(1, numberOfDistinctValues - 1)`. Missing/nonfinite duration
becomes zero; negative duration is clamped to zero. The descending score is:

```text
score(t) = R(D(t)) + 0.1 × R(B(t))
```

Compute one FAST permutation of all enabled candidates. Compute the buckets in
parallel with that work. Traverse the FAST permutation to populate buckets; sort
each APFD bucket by producer priority, then descending score, retaining FAST
order for ties. Concatenate buckets within the existing project/group order.
The experiments supply no producer priorities.

The similarity kernel tokenizes source text, splits camel case, lowercases it,
and builds 32-component MinHash signatures. It starts with input index zero and
repeatedly chooses a least-similar signature relative to the cumulative selected
set. Ties favor smaller original indices. When more than 256 candidates remain,
it inspects a deterministic evenly spaced sample of `ceil(sqrt(remaining))`.
This is a FAST-pw-style implementation, not the authors' identical Python FAST-pw
algorithm. The experiments keep the authors' implementation as a separate control.

Duration and size are empirical fault-likelihood proxies. Ordering longer tests
first does not minimize runtime. The 0.1 weight was chosen during Jsoup tuning;
it is fixed for the recorded external evaluation. Its generality and the effect
of promoting repair tests remain research questions.

The default DX mode has a different rule: affected files first and previous
failures first within affected/remaining groups, with global FAST order inside
those buckets. Select `optimizeFor: 'apfd'` to evaluate the six-bucket policy.

## Granularity and selection

File granularity treats a changed transitive dependency as affecting its recorded
dependents. Function granularity compares transformed function bodies against
per-test-file V8 observations and can clear affectedness when the changed body
was not called. Nested bodies are tracked. Structural/module changes, missing or
ambiguous observations and unsupported execution modes retain coarse behavior.
The Java analogue uses JaCoCo method coverage and bytecode fingerprints, with
shared initialization coverage and structural/resource fallbacks.

Neither refinement is a proof of selection soundness. Previously unseen dynamic
behavior, external state and missing observations require careful evaluation.
The Java recorder currently recognizes the namespaces in the evaluated projects;
extending that set requires validating instrumentation and initialization guards.

When selection is enabled, retain a unit iff:

```text
previousFailure OR unknownObservation OR ownTestChanged OR affected
```

The full suite is the default. Explicit full-rerun triggers bypass selection;
revision-based changed mode conservatively keeps the relevant suite. Completed
executed units refresh their observations; skipped units retain their previous
ones. A failed completed run still refreshes its observation. A source that
changes during execution does not receive an unsound fresh observation.

## Version boundary

- APFD evaluation pin: `c3a28ac84309d5df30d70c29ac60aefe92447ff5`.
- JavaScript granularity evaluation pin: `d3e3811df4f23dc73de56a32728c044a3b7de6d5`.
- Subsequent explicit-rerun guard: `f598a7e58577a1834ce1e6a53e48938387d87557`.
  That guard is integration-tested and was outside the recorded experiments'
  configuration; the benchmark is not relabeled as a new execution at f598.

`core-map.json` records source hashes at this research snapshot. The production
policy remains the source of truth; research changes should not silently change
its runtime behavior.
