# Native adapters and adding a project

The shared layer is the case contract, metrics and native outcome checks. A
framework adapter supplies observations and executes a requested set of units.
It must not redefine APFDf or substitute another test universe after selection.

## Portable ordering replay

After the normal repository `pnpm install`, source-bearing features can be ranked
without Java or a Vitest process:

```bash
pnpm exec tsx research/adapters/order.ts FEATURES.json research/work/orders.json
```

`FEATURES.json` has `files`, in a frozen deterministic input order. Each entry
has `id`, `source`, `bytes`, `duration` (optional), `failed`, `known`, `testChanged`
and `affected`. The adapter imports the production FAST kernel and APFD scorer,
then emits full/selected APFD orders and historical comparator orders. It reads
no target-fault labels. Run it before target execution and retain hashes of both
files. This single-project adapter has no manifest overrides; a multi-project
study must use the native sequencer or explicitly preserve its group boundaries.

## JavaScript / Vitest

Use the built fork and the project's actual required aliases, defines,
environment and setup files. Configure isolated Node execution with
`fileParallelism: false`, `maxWorkers: 1`, and the research reporter
`research/adapters/vitest-reporter.ts` (use an absolute reporter path when the
project root is outside this checkout). Set `FASTER_RESEARCH_OUTPUT` to a fresh
output path. The reporter rejects parallel scheduling because module completion
order is not a valid substitute for serial start order.

The relevant configuration is:

```ts
import { defineConfig } from 'faster/config'

export default defineConfig({
  test: {
    faster: {
      enabled: true,
      changed: true,
      optimizeFor: 'apfd',
      granularity: 'function', // compare against 'file' using the SAME prior cache
      selectAffected: true,
    },
    fileParallelism: false,
    maxWorkers: 1,
    isolate: true,
    pool: 'forks',
  },
})
```

Establish a full prior control with `selectAffected: false` first. Both comparison
arms must receive independent copies of that same cache, including function
observations. The first arm must not update the cache used by the second. Use the
matching V8 coverage package; finer granularity automatically enables the needed
coverage collection. Browser and nonisolated execution currently fall back to
coarse behavior and must be labeled as such.

Normalize the reporter's output:

```bash
python3 research/native.py vitest research/work/execution.json research/work/records.json
```

The original pilot used three Git snapshots each of Pinia, Zod and H3, with a
shared pinned runtime and explicitly recorded configuration adaptations. Its
seeded AST mutations were not natural Git faults. The paired granularity study
reused those targets and original method identities. Exporting new observations
with this reporter does not recreate the old project's configuration by itself.

## Java / Maven / Surefire

Maven/Surefire executes Java; the TypeScript adapter only ranks supplied class
features. File-level dependencies in the existing Java studies came from the
native Ekstazi 5.3.0 agent. Do not call Vite's import-graph selector “Ekstazi”.

`java/ScopeAgent.java` and `java/Analyze.java` are the exact recorder/analyzer
sources used in the 17-case method ablation. They use JDK 8, Maven 3.9.9,
JaCoCo 0.8.4, ASM core/tree/commons/analysis 7.1 and ASM util 6.0. The latter
versions preserve the recorded environment. Dependency SHA256s are in
`java/dependencies.json`; jars are not committed. With those dependencies in a
Maven cache:

```bash
python3 research/adapters/java/build.py --m2 /path/to/m2 --java-home /path/to/jdk8
```

The generated `research/work/java-tools/classpath.txt` is the classpath for
`Analyze`. Its interfaces are:

```text
java -cp CLASSPATH Analyze model PRODUCTION_CLASSES:TEST_CLASSES
java -cp CLASSPATH Analyze coverage PRODUCTION_CLASSES:TEST_CLASSES EXEC_DIRECTORY
```

`model` writes METHOD/SHELL TSV fingerprints; `coverage` writes
suite/class/method TSV observations. Instrument native Surefire forks with the
JaCoCo agent first (`output=none,dumponexit=false`), then `scope-agent.jar` with
the fresh execution directory as its agent argument. Preserve the project's
existing JVM options. Run serially. The recorded namespace filters cover
`org.apache.commons`, `com.squareup.javapoet` and `com.fasterxml.jackson`;
adding another namespace requires modifying and validating both filters.

The scope recorder intercepts Surefire class boundaries, dumps/reset JaCoCo
coverage, and records methods observed during static initialization. Merge
`initialization-*.tsv` observations into `__GLOBAL__` coverage, as well as startup
coverage, before refinement. Every recorded class must have an observed suite
boundary. Require no `transform-error-*.txt`, valid class identities and an
observed initialization guard. Do not silently accept an agent that attached
but failed to instrument classes. The previous study independently verified
all 26 coverage controls against original compiled bytecode and native membership.

`java/refine.py` centralizes the actual method-affectedness decision. It accepts
current full features, current model JSON and an index of each test's actual
prior model/coverage. Missing prior data falls back to file-level affectedness.
It preserves all other input features and writes a decision ledger alongside
refined features. Its missing-attribution guard is additionally conservative;
all recorded paired cases have attribution and reproduce the original decisions.

```bash
python3 research/adapters/java/refine.py FEATURES.json CURRENT_MODEL.json \
  PRIOR_INDEX.json research/work/method-features.json
pnpm exec tsx research/adapters/order.ts research/work/method-features.json research/work/method-orders.json
```

Run the resulting selected classes through the native framework. Surefire XML
does not establish their actual scheduling order; Java APFDf remains an offline
rank replay unless a separate native scheduling recorder is added. Clear reports
before each run so stale XML cannot inflate membership.

```bash
python3 research/native.py surefire /path/to/fresh/target/surefire-reports research/work/subset.json
python3 research/native.py audit-subset --oracle research/work/full-fault.json \
  --subset research/work/subset.json --selected research/work/selected-ids.json \
  --control research/work/full-passing-control.json
```

The full unmodified control and full fault oracle must have the same method
membership. The subset must have exactly the selected classes and the oracle's
method membership and pass/fail/skip vector for those classes. The audit returns
recall rather than rejecting a legitimate missed fault. Establish oracle
stability with repeated native runs before accepting that result.

Historical build adaptations remain part of the original evidence: Jackson's
unpublished parent replacement, Commons Text source encoding and Commons IO JVM
memory/locale settings. The portable adapters do not reconstruct those project
builds or download datasets. A full native replication must supply them and
record the resulting hashes; compact analysis replay needs none of them.

## Adding an experiment

Write a protocol and attempt ledger before collecting outcomes. Use a new cohort
identifier and pin the production revision. Export one JSONL case per fault;
`schemaVersion: 1`, `tests` and `revealing` use the full current universe, and each
policy maps to a list of index permutations/subsequences. Declare full-suite
policies in `fullPolicies`; label ranks `offline-replay` or `native-serial`.
Use `benchmark.metrics` for validation/scoring and `benchmark.native` for native
checks. Keep large raw observations in `research/artifacts/`, with a manifest
and a clear acquisition procedure for reviewers.
