# FASTER research workspace

This folder is the review entry point for FASTER's prioritization and selection
research. The runtime implementation stays in `packages/`; research adapters
import that implementation rather than maintaining another FAST or APFD scorer.
This folder is outside every published package's file allowlist.

## Suggested review order

1. [Strategy and core code](STRATEGY.md): the exact scheduling rule, its inputs,
   the meaning of function granularity, and links to the implementation.
2. [Benchmark protocol](PROTOCOL.md): shared metrics and acceptance rules,
   followed by the differences between the three existing cohorts.
3. [Results and research questions](RESULTS.md): what the current evidence
   establishes, regressions, and the next experiment to preregister.
4. [Adapter guide](adapters/README.md): native execution, coverage collection,
   and how to add a project without adding another scoring implementation.

## Reproduce the analysis

From the repository root, Python 3.10+ is sufficient. No project clones, Java,
Node, extra Python packages, or network are needed for these commands:

```bash
python3 research/bench.py validate
python3 research/bench.py summarize --cohort external-java-paired
python3 research/bench.py summarize --cohort javascript-paired
python3 research/bench.py summarize --cohort paper-java-file --partition outside-jsoup --aggregate cohort
python3 research/bench.py inspect --cohort paper-java-file --project Chart --case 1
python3 research/bench.py compare --cohort external-java-paired \
  --left 'FASTER method selected' --right 'FASTER file selected' \
  --metric skippedFraction
python3 -m unittest discover -s research/tests -v
```

`data/cases.jsonl.gz` contains 576 derived cases: 541 paper Java cases, 17
external Java cases and 18 JavaScript faults. Each has its own full test universe,
revealing units, frozen/observed orders, implementation revision and evidence
type. Summaries stay separated by cohort and project. `compare` refuses to pool
cohorts and requires both policies on every included case.

The 541-case dataset recomputes scores for three recorded deterministic orders. Its
other baseline scores are retained under `referenceMetrics`, explicitly outside
the recomputed results: their full permutations are not present in that
authoritative artifact directory. All eight original external-Java policies
have their recorded permutations and are recomputed, alongside the granularity
ablation. The JavaScript ablation uses the two actual selected execution orders.

### Reconcile with the original evidence

The repository includes compact derived data, not the large native logs,
checkouts, dependency caches, bytecode, coverage files or third-party sources.
`data/manifest.json` records the source-file hashes. Given the original `outputs`
directory (obtained separately from the study owner):

```bash
python3 research/bench.py validate --evidence-root /path/to/outputs
python3 research/bench.py import-evidence --evidence-root /path/to/outputs \
  --out research/work/reimport
python3 research/bench.py validate --data research/work/reimport/cases.jsonl.gz
```

With Node and installed workspace dependencies, audit the extracted Java
affectedness adapter and all four ordering permutations against the original
17 paired cases:

```bash
python3 research/tests/audit_original.py --evidence-root /path/to/outputs
```

The importer is read-only, independently rechecks available Java/JavaScript
native method membership and outcome vectors, and checks historical APFDf values
against the common scorer. `validate` also verifies the eight production source
hashes in `core-map.json`. Reproducing analysis is distinct from rerunning native experiments;
the latter additionally requires the pinned runtimes, project versions and
project-specific build configuration described in the adapter guide.

## Where work belongs

| Location | Purpose |
| --- | --- |
| `../packages/` | Production ordering, change tracking, coverage and selection |
| `benchmark/metrics.py` | Shared case validation, APFDf, budgets and paired inference |
| `benchmark/import_evidence.py` | Migration from the original dated studies |
| `benchmark/native.py` | Shared native control, membership and outcome checks |
| `adapters/` | Framework-specific observation and execution glue |
| `data/` | Versioned compact evidence, cohort definitions and attempt ledger |
| `work/`, `artifacts/` | Ignored generated outputs and large raw evidence |
| `apfd/` | Preserved original 93-case Jsoup tuning audit; see note below |

The existing `apfd/` fixture is a historical tuning experiment with its own
recorded cache and selected-count budget convention. It is not another 93
independent cases, and its selected-count budgets must not be mixed with this
workspace's full-N budgets. Keep that frozen audit for provenance; use the common
scorer for new studies.

For a review, comment on the strategy/protocol or the linked production code.
For a new experiment, record its cohort, exclusions, revisions and feature freeze
before observing its outcomes. A policy change needs a new implementation pin
and a new study record; it must not overwrite this dataset.
