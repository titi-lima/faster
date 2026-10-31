import { defineConfig } from 'vitest/config'
import { faster } from 'vitest-faster'

export default defineConfig({
  plugins: [
    faster({
      changed: true,
      priorityFile: '.faster/priorities.json',
    }),
  ],
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    reporters: ['default', './demo-reporter.ts'],
  },
})
