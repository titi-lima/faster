# Native adapters

## Vitest

Use the project's existing configuration and add:

```ts
import { defineConfig } from 'faster/config'

export default defineConfig({
  test: {
    faster: { optimizeFor: 'apfd', selectAffected: true },
    isolate: true,
    fileParallelism: false,
    maxWorkers: 1,
  },
})
```

Install matching `@vitest/coverage-v8`. Run once with `selectAffected: false` to
establish history. Function observations are collected automatically. Missing
observations and structural changes keep tests eligible.

Add `vitest-reporter.ts` as a reporter and set `FASTER_RESEARCH_OUTPUT` to a fresh
output path. It records serial execution order, outcomes and start/end times.
Normalize the output with `python3 research/native.py vitest INPUT OUTPUT`.

## Java

Maven/Surefire executes Java. `ScopeAgent.java` records per-class coverage;
`Analyze.java` extracts method fingerprints and coverage. `refine.py` maps changed
methods to affected tests; `order.ts` ranks them using production FAST/scoring.
The recorder currently recognizes the evaluated Commons, JavaPoet and Jackson
namespaces. Native project setup and model collection still require the original
study artifacts. XML reports alone do not establish execution order.

```bash
python3 research/adapters/java/build.py --m2 /path/to/m2 --java-home /path/to/jdk8
python3 research/adapters/java/refine.py FEATURES MODEL PRIORS OUTPUT
pnpm exec tsx research/adapters/order.ts FEATURES ORDERS
python3 research/native.py surefire /path/to/fresh/surefire-reports RECORDS
```

JDK 8 and dependency fingerprints are pinned in `java/dependencies.json`.
`build.py` writes the agent and analyzer classpath under `research/work/java-tools`.
The analyzer accepts `model CLASSES` or `coverage CLASSES EXEC_DIRECTORY` and
writes TSV. Refinement accepts model/coverage JSON from the collector; its prior
index maps test IDs to `model` and `coverage` paths relative to that index.

## Check a selected run

```bash
python3 research/native.py audit-subset --oracle FULL_FAULT --subset SELECTED_RUN \
  --selected SELECTED_IDS --control FULL_PASSING_CONTROL
```

Require a stable full oracle and passing unmodified control with matching test
membership. The selected run must contain exactly the requested units and their
oracle method outcomes. A missed fault is a measured result, not an exclusion.
Freeze features/orders before target execution and retain every attempted case.
