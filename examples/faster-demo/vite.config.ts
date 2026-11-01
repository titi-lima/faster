import { faster } from 'vitest-faster'
import { defineConfig } from 'vitest/config'

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
