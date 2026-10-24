# Recorded results and questions for review

These are matched results from our experiments, not the paper's published scores.
The included data preserves each experiment's fault model and rank evidence.

## APFD policy on the external Java faults

| Policy, 17 cases | Mean APFDf ↑ | Mean first revealing class rank ↓ |
| --- | ---: | ---: |
| FASTER APFD | 0.9183 | 4.12 |
| Previous FASTER | 0.5264 | 33.29 |
| Vitest base adapter | 0.6053 | 21.35 |
| Native Ekstazi selection + random order | 0.6268 | 21.03 |

These are offline ranks of native fault identities. They use repaired tests,
and every fault has a revealing changed/unknown test. The result supports a
benefit on this corpus; it does not settle the unchanged-test natural CI question.
All eight original comparator policies can be inspected through `bench.py`.

Two useful counterexamples remain: JavaPoet `3829f2ca` has FASTER rank 7 versus
author FAST-pw mean rank 2.93; Commons Text `d3051739` has FASTER rank 12 versus
Ekstazi+random mean rank 7.17. New tests without prior duration can sit behind
other changed tests, and coarse affectedness can retain a broad suite. These are
different comparators; do not draw a single unlabeled “baseline” curve for them.

## Granularity changes selection more consistently than ordering

Mean skipped fraction per case:

| Project | Faults | File granularity | Function/method granularity |
| --- | ---: | ---: | ---: |
| Commons CSV | 3 | 28.4% | 40.3% |
| Commons IO | 1 | 9.8% | 9.8% |
| Commons Text | 2 | 6.4% | 6.4% |
| Jackson Core | 5 | 15.6% | 24.5% |
| JavaPoet | 6 | 12.6% | 21.5% |
| Pinia | 13 | 0.0% | 76.0% |
| Zod | 5 | 2.6% | 79.8% |

Java: 812 to 742 retained class occurrences out of 948 (not unique classes across
versions). Case-mean skipped fraction rises from 15.4% to 23.2%; 4 improvements,
13 ties, no expansion. All 17 faults and all 22 revealing class occurrences stay
selected. APFDf and first-failure rank tie in every case. Project-balanced extra
skipping is 5.9 percentage points, bootstrap 95% interval [0.0, 13.7].

JavaScript: Pinia APFDf rises from 0.6855 to 0.9480 and mean first-failure rank
falls from 5.85 to 1.38. Zod APFDf rises from 0.9044 to 0.9857 and rank falls from
9.20 to 1.80. The paired runs retain all 18 target faults, with 10 APFDf wins,
8 ties and no losses. These were development mutations, not a new holdout.
The selected-run APFDf gain includes the effect of skipping nonrevealing files;
it is not an isolated claim about improved full-suite prioritization.

The earlier JavaScript file-level result largely reflected import fan-out:
tests depended on common modules but did not all call the mutated function.
This is compatible with a correct file graph. The Java method refinement has a
smaller effect because direct changed/unknown tests already receive priority and
are always retained. The two studies therefore answer different questions.

## Paper subjects

The 541-case file-granularity replay spans all 12 subjects; 93 Jsoup targets were
available during tuning. The 448 outside-Jsoup cases have mean FASTER APFDf
0.9354. This workspace recomputes deterministic orders from their recorded
permutations and labels. It retains the other policies' reported metrics as
reference evidence rather than claiming to reconstruct missing permutations.
The original 541 cases have **not** been rerun at method granularity.

## Proposed next study to agree on before execution

Freeze the policy, then sample forward-ancestry histories independently of
whether repair commits edit tests. Keep unchanged existing tests as a separate
stratum and include natural failures and passing transitions in the ledger.
Evaluate full versus selectively refreshed history rather than refreshing every
unit at each sampled version. Compare file and function/method selection using
the same native failure oracle and full N.

The main questions for the professor are whether the observed direct-test signal
is useful beyond repaired benchmarks, which soundness conditions the coverage
refinement needs, and whether coverage cost is repaid in end-to-end time. The
current observations justify those experiments; they do not answer them yet.
