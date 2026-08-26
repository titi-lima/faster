import type { Reporter, TestCase } from 'vitest/node'

class DemoReporter implements Reporter {
  onTestCaseReady(testCase: TestCase) {
    console.log(`[execution-order] ${testCase.module.relativeModuleId} :: ${testCase.fullName}`)
  }
}

export default DemoReporter
