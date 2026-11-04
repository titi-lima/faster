import type { ResolvedCoverageOptions } from 'vitest/node'
import type { ResolvedFasterOptions } from '../decision/priorityManifest'

export type { AfterSuiteRunMeta, RunnerTestFile as File, RunnerTask as Task } from 'vitest'
export type { TestProject, TestSequencer, TestSpecification, Vitest } from 'vitest/node'

// The fork's own types for what the decision code reads. Upstream Vitest has
// `_coverageOptions` and `onAfterSetServer` at runtime but keeps them out of
// its public types, and the host stores the resolved options in `faster`.
declare module 'vitest/node' {
  interface ResolvedConfig {
    faster: ResolvedFasterOptions
  }

  interface Vitest {
    readonly _coverageOptions: ResolvedCoverageOptions
    onAfterSetServer: (fn: () => void | Promise<void>) => void
  }
}
