import type { Plugin } from 'vite'

export interface FasterOptions {
  enabled?: boolean
  /**
   * Both objectives use failure/change buckets and prior duration/source size.
   * DX defers unchanged, unaffected known failures to the end.
   *
   * @default 'dx'
   */
  optimizeFor?: 'dx' | 'apfd'
  /**
   * Put tests affected by source changes since the previous completed test run
   * ahead of the remaining suite. A string also includes changes since that
   * Git revision.
   *
   * @default true
   */
  changed?: boolean | string
  /** Run only changed, unknown, affected or previously failing test files. */
  selectAffected?: boolean
  /**
   * Optional producer scores within each scheduling bucket. Equal scores and
   * unscored files use the shared ranking, with path order breaking ties.
   *
   * @default '.faster/priorities.json'
   */
  priorityFile?: string
  /**
   * Accepted for configuration parity with the FASTER fork. The plugin does not
   * change Vitest's reporters, so failures are printed by them as usual.
   */
  immediateFailureOutput?: boolean
}

/**
 * Enables FASTER for every Vitest project whose configuration contains this
 * plugin. Options here are defaults; a project's `test.faster` and the
 * `vitest-faster` CLI flags override them, in that order.
 */
export declare function faster(options?: boolean | FasterOptions): Plugin
export default faster

declare module 'vitest/node' {
  interface InlineConfig {
    /** FASTER options for this project, applied by the `vitest-faster` plugin. */
    faster?: boolean | FasterOptions
  }
}
