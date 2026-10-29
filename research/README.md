# FASTER research

FASTER orders tests using previous failures, changed/affected code and duration/size
scores. This package covers **17 Java repair cases and 18 JavaScript mutations**.

## Run the replication

Requires Git, Python 3.12+, Node 24, pnpm 10, JDK 8 and Maven 3.9.9. From the
repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
python3 research/replicate.py --java-home /path/to/jdk8 --maven /path/to/mvn
```

On macOS, prefix the last command with `caffeinate -is` to keep the machine awake.

The last command fetches the pinned repositories, recreates each fault, collects
coverage at its recorded history revisions, runs passing controls and full/selected
faulty suites, checks method-level outcomes, then calculates metrics and paired
bootstrap comparisons. No original `outputs/` directory is needed.

Results go to `research/work/replication/`: `summary.json`, `comparisons.json`,
`ledger.json`, and per-case logs, frozen inputs/orders, audits and metrics.
`metrics.json` compares each new result with its recorded result. Blocked cases
remain in the ledger and prevent aggregate reporting; a missed selected fault is
scored zero. Use a fresh `--out` directory for each run.

```bash
python3 research/replicate.py --list
python3 research/replicate.py --project pinia --out research/work/pinia
# Add --case COMMIT_OR_MUTATION_PREFIX to run one case.
```

Java rebuilds method coverage and replays recorded dependency/history observations,
prior durations and comparator permutations. Maven validates full and selected
outcomes; Java ranks remain offline permutations, not observed execution times.
Change features use the fixed snapshot; faulty executions use parent production
and the fixed test tree.
JavaScript rebuilds function coverage, retains recorded prior durations, and
records serial FASTER and Vitest-base execution orders for the Pinia core and
Zod v4 classic suites in `adapters/vitest.config.ts`. FAST-pw/Fastazi baseline
orders remain data; their implementations are not included. Historical build
adjustments are confined to the released Jackson parent and Commons IO JVM locale.

## Analyze the saved results

These commands use the included dataset without fetching or executing subjects;
Python 3.10+ is sufficient:

```bash
python3 research/bench.py validate
python3 research/bench.py summarize
python3 research/bench.py compare --cohort java --left FASTER --right 'Ekstazi+random'
python3 -m unittest discover -s research/tests -v
```

`inspect --cohort java --project PROJECT --case COMMIT` explains one case.
With the separately held original evidence, `validate --evidence-root /path/to/outputs`
checks its fingerprints; `import-evidence --evidence-root /path/to/outputs --out
research/work/import` rebuilds the dataset. [Adapters](adapters/README.md) document
the individual native tools.

## Code and interpretation

| Location | Responsibility |
| --- | --- |
| [FasterSequencer](../packages/vitest/src/node/sequencers/FasterSequencer.ts) | Failure/change buckets, producer scores and path ties |
| [apfdPriority](../packages/vitest/src/node/faster/apfdPriority.ts) | Duration/size scores; DX defers unchanged, unaffected failures |
| [functionCoverage](../packages/vitest/src/node/faster/functionCoverage.ts) | Match changed functions to recorded callers |
| `replicate.py`, `adapters/` | Fetch subjects, recreate faults and verify native runs |
| `benchmark/` | Shared metrics and native outcome checks |
| `data/` | Pinned cases, mutations, historical inputs and attempt ledger |
| `runtime/` | Locked dependencies for the JavaScript subjects |

[Recorded results](RESULTS.md) precede the current cleanup. Each case represents
one fault: APFDf is `1 - (firstRevealingRank - 0.5) / fullSuiteSize`, with misses
scoring zero. Higher is better; rank is a test position. Budgets use full suite
size; comparisons bootstrap projects, then cases, within each language cohort.

All Java faults have an edited/unknown revealing test. JavaScript is a seeded
development cohort. Replication does not make these independent holdout cases
or establish selection safety. End-to-end runtime savings remain unmeasured.
Generated files stay in ignored `work/`; research is excluded from the package.
