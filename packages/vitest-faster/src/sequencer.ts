import type { TestSequencer, TestSequencerConstructor, TestSpecification, Vitest } from 'vitest/node'
import type { FasterHost } from './host'
import { FasterSequencer } from '../../vitest/src/node/sequencers/FasterSequencer'

export interface HostSequencerOptions {
  host: FasterHost
  /** The sequencer Vitest resolved before FASTER replaced it. */
  fallback: TestSequencerConstructor
  /** The fork installs its sequencer only without a user sequencer. */
  faster: boolean
}

/**
 * Vitest calls `sort` at the start of every pool run, right where the fork
 * starts its source snapshot, so the snapshot starts here whichever sequencer
 * orders the files.
 */
export function createHostSequencer(options: HostSequencerOptions): TestSequencerConstructor {
  const { host } = options
  return class FasterHostSequencer implements TestSequencer {
    private ordering: TestSequencer
    private faster: boolean

    constructor(vitest: Vitest) {
      this.faster = options.faster
      const Fallback = options.fallback
      this.ordering = options.faster
        ? new FasterSequencer(host.context) as unknown as TestSequencer
        : new Fallback(vitest)
    }

    async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
      if (!this.faster) {
        return this.ordering.shard(files)
      }
      await host.populateStats(files)
      return unwrap(await this.ordering.shard(files.map(file => host.specification(file))))
    }

    async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
      const capture = host.startCapture(files)
      try {
        if (!this.faster) {
          return await this.ordering.sort(files)
        }
        await host.populateStats(files)
        return unwrap(await this.ordering.sort(files.map(file => host.specification(file))))
      }
      finally {
        // Workers start after `sort` returns, so the snapshot precedes all test code.
        await capture
      }
    }
  }
}

function unwrap(files: any[]): TestSpecification[] {
  return files.map(file => file.original)
}
