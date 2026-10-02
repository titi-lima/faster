import type { Reporter, TestCase } from 'vitest/node'

class DemoReporter implements Reporter {
  onTestCaseReady(testCase: TestCase) {
    process.stdout.write(`[execution-order] ${testCase.module.relativeModuleId} :: ${testCase.fullName}\n`)
  }
}

export default DemoReporter
