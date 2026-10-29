# FASTER research

FASTER orders tests using previous failures, source changes and history/size scores.
Function coverage identifies tests affected by a changed function. Selection is
optional; unknown, edited and previously failing tests always remain eligible.

## Code

| Location | Responsibility |
| --- | --- |
| [FasterSequencer](../packages/vitest/src/node/sequencers/FasterSequencer.ts) | Combine priority buckets, scores and path order |
| [apfdPriority](../packages/vitest/src/node/faster/apfdPriority.ts) | Score previous duration and test-source size |
| [functionCoverage](../packages/vitest/src/node/faster/functionCoverage.ts) | Match changed function bodies to recorded callers |
| `benchmark/metrics.py` | Validate cases, calculate metrics and compare policies |
| `benchmark/import_evidence.py` | Import recorded experiments and audit native outcomes |
| `adapters/` | Observe Vitest/Surefire runs and rank Java inputs |
| `data/` | Recorded cases, candidate ledger and source fingerprints |
| `tests/` | Contract tests and optional raw-evidence audit |

The APFD order is: previous failures first; within each failure group, edited or
unknown tests, then affected tests, then remaining tests. Within a bucket, use
`durationRank + 0.1 × sizeRank` descending, with path order breaking ties. DX uses
the same ranking, but sends unchanged,
unaffected known failures to the end. Producer priorities take precedence inside
a bucket.

## Run the analysis

Python 3.10+; no additional packages needed. From the repository root:

```bash
python3 research/bench.py validate
python3 research/bench.py summarize
python3 research/bench.py compare --cohort java --left FASTER --right 'Ekstazi+random'
python3 -m unittest discover -s research/tests -v
```

`inspect --cohort java --project PROJECT --case COMMIT` shows one case.
`native.py` normalizes runner output and checks selected-test membership and
outcomes. See [adapters](adapters/README.md) for native tooling.

## Evidence

The active dataset has 17 Java repair cases and 18 JavaScript mutations.
[Results](RESULTS.md) describe these recorded runs; changing the current code
has not rerun them. Java ranks are replayed offline; JavaScript ranks come from
serial execution. Java uses parent production with repaired tests, and every
Java fault has an edited/unknown revealing test. JavaScript is a development
cohort. These limitations prevent a general selection-safety claim.

Each case treats its target as one fault. APFDf is
`1 - (firstRevealingRank - 0.5) / fullSuiteSize`; misses score zero. Higher is
better. Rank is a test position, not elapsed time. Budgets also use full suite
size. Repetitions are averaged within cases; comparisons bootstrap projects,
then cases. Runtime savings have not been measured.

`validate` checks the dataset and eight production source pins. With original
artifacts, add `--evidence-root /path/to/outputs` to verify their fingerprints.
Reimport with `import-evidence --evidence-root /path/to/outputs --out research/work/import`.
The importer checks native method membership and outcomes. Reports without a
start timestamp explicitly lack proof of a pre-execution freeze.

Large logs, checkouts and coverage belong in ignored `artifacts/`; generated
outputs belong in ignored `work/`. Research code is excluded from the package.
