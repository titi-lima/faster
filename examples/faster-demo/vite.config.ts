/// <reference types="vitest/config" />

import { defineConfig } from 'faster/config'

export default defineConfig({
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    reporters: ['default', './demo-reporter.ts'],
    faster: {
      changed: true,
      priorityFile: '.faster/priorities.json',
      immediateFailureOutput: true,
    },
  },
})
