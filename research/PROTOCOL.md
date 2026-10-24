# Unified benchmark protocol

## Common experimental contract

One case represents one target fault at one current version. Its revealing units
are alternative test classes/files that reveal that fault, not independent
faults. The full current runnable universe has N unique units. Method names
remain in the native evidence to check that collection and outcomes agree.

The shared lifecycle for new experiments is:

1. Freeze projects, eligible revisions, sampling rules, environments, policy
   revision, random seeds and exclusion rules before new outcomes are inspected.
2. Run an unmodified native control and verify complete test-method membership.
   Obtain history only from completed prior runs. Record each unit's actual prior
   revision; do not substitute a display-level previous-commit pointer.
3. Obtain current source/dependency features. Keep current fault labels and
   outcomes outside the ranking interface. Record hashes of features and every
   candidate order before target execution, with the cache identity and timestamp.
4. Run the full target oracle twice where required for stability. Record literal
   history separately from repaired-test/seeded-fault execution. Every attempted
   version stays in the ledger, including passing candidates and exclusions.
5. Run selected subsets natively. Require exact selected class/file membership,
   method multiset and pass/fail/skip vector equality with the corresponding full
   oracle subset. Check target failures are absent from unmodified controls.
6. Export a case under the shared schema. Score every policy with the same N and
   target fault. Report fault detection and revealing-unit recall separately.

`benchmark/native.py` supplies the common membership/outcome gate. A missed fault
is a result, not an exclusion. A failing unmodified control or an incompatible
test overlay is an exclusion/qualified diagnostic; it must not silently become
evidence of target detection.

## Shared metrics

For a single target fault, let r be the one-based rank of the first revealing
unit in an executed/frozen order. If none is present, the trial misses.

```text
APFDf = 1 - (r - 0.5) / N, if detected; 0 otherwise
skippedFraction = 1 - numberOfSelectedUnits / N
budgetCount(b) = floor(b × N)
```

APFDf is higher-is-better. First-failure rank is lower-is-better. Historical
`TTFF` fields in these datasets denote a **rank**, not elapsed seconds. The common
output calls it `meanFirstFailureRankWhenDetected` and reports detection
probability alongside it. Never make a policy look faster by dropping its misses
from the APFDf average or shrinking N after selection.

At each of the paper's twelve fractions (10, 20, 25, 30, 40, 50, 60, 70, 75, 80,
90, 100%), report mean detection probability and whether all stochastic trials
hit. All common outputs use full N. Older artifacts also contain selected-count
budget analyses; those remain reference evidence with a different denominator.

Policies have one or more orders per case. Average repetitions within each case
before aggregating cases. Report project-specific case means; paired comparisons
use project-balanced differences and a project-then-case percentile bootstrap
(20,000 draws, seed 20261024). The interval describes this small convenience
sample. It is not a confidence interval for universal fault recall or selection
soundness. Projects, cases and repeated orders are not interchangeable samples.

There is no common wall-clock, APFDc or end-to-end overhead claim in this dataset.
Kernel timing, compilation time and total execution time measure different work.
A future performance study must state its boundaries and include coverage,
dependency maintenance, ordering and execution overhead.

## Existing cohorts retain their different meanings

| Cohort | Fault and execution model | Rank evidence | Main limitation |
| --- | --- | --- | --- |
| `paper-java-file`: 541 faults, 12 subjects | Curated paper/Defects4J targets; live fixed test suites, prior observations and file/class dependency signals | Offline order replay with curated revealing classes | Strong edited/new revealing-test signal; author bug order is not always forward ancestry; no method-granularity rerun |
| `external-java-paired`: 17 faults, 5 projects | Real Git repair commits; buggy parent production with the fixed test tree; native Maven controls and subset checks | Offline replay of native fault identities | Fixed-version features and repair tests; not a natural passing-to-failing CI replay |
| `javascript-paired`: 18 faults, 2 projects | Three snapshots per project from Git; seeded AST mutations, clean prior controls; native Vitest runs | Actual serial selected-run order | Development cohort reused for granularity work; mutations are not historical bugs |

The 93 Jsoup targets were available during APFD tuning. The other 448 paper
targets evaluate that frozen policy outside Jsoup; they do not establish natural
CI generalization. The paired Java method ablation reuses previously observed
faults and changes only affectedness, retaining durations, sizes, source,
unknown/changed classification, prior caches and FAST settings.

All 17 external Java faults have a revealing changed/unknown test. Retaining
17/17 faults therefore does not independently validate coverage selection safety.
The class/file scheduling unit also differs from a single test method.

Selection and ordering interact differently in these executions: the Java
adapter filters a frozen full-suite order to its selected subsequence; native
Vitest schedules the selected candidates through its sequencer. Both use full N
for APFDf. Removing nonrevealing units can improve selected-run APFDf even without
improving the full-suite ordering policy, so a selection ablation must not be
presented as an isolated improvement in full-suite prioritization.

The JavaScript pilot froze 54 broadly sampled mutations, then an additional 18
core mutations. Its original ledger includes 19 evaluated faults, 32 survivors,
10 bad controls and 11 unstable attempts. The granularity replay scores 18 clean
Pinia/Zod faults. H3 had no passing current full control in 13 attempts at the
relevant snapshot; its one retained target is a separate failed-prior diagnostic,
not pooled here. Type/comment filtering was not introduced.

The external Java search includes 31 attempted candidates: 17 evaluated,
12 excluded and 2 with no observed target fault. `data/attempts.json` retains the
candidate identifiers and reasons. Metadata-only searches that yielded no
eligible revision are described in `data/cohorts.json`; they add no fault cases.

## Provenance and reproducibility levels

1. **Analysis replay:** included case records, orders and revealing units allow
   common metrics to be recomputed without dependencies.
2. **Ordering replay:** the portable adapter imports the production scorer and
   FAST kernel. Complete source-bearing features are required to regenerate FAST;
   they are in the external raw evidence, not this compact dataset.
3. **Native replication:** requires pinned projects/runtimes, caches, build
   adaptations, native controls and coverage/dependency evidence. The large
   original artifacts are separately held. The importer does not rerun them.

The original dated studies and their sealed files remain untouched. A source hash
matches bytes; it does not by itself prove that an experimental protocol is
unbiased. Newly generated evidence belongs under `research/artifacts/` with its
own manifest and attempt ledger. Do not replace the recorded cohorts when a
future experiment produces a more favorable result.
