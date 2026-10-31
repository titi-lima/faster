import { writeFileSync } from 'node:fs'
import { relative } from 'node:path'

/**
 * Records the order in which test files start and every file's and test's
 * outcome. Both hosts run Vitest 4.1.7's reporter API.
 */
export default class HoldoutReporter {
  order = []

  onInit(vitest) {
    this.root = vitest.config.root
  }

  onTestModuleStart(module) {
    this.order.push(relative(this.root, module.moduleId))
  }

  onTestRunEnd(modules, errors, reason) {
    const files = {}
    for (const module of [...modules].sort((a, b) => a.moduleId.localeCompare(b.moduleId))) {
      const tests = {}
      for (const test of module.children.allTests()) {
        tests[test.fullName] = test.result().state
      }
      files[relative(this.root, module.moduleId)] = { state: module.state(), tests }
    }
    writeFileSync(process.env.HOLDOUT_REPORT, JSON.stringify({
      reason,
      errors: errors.map(error => String(error?.message ?? error)),
      order: this.order,
      files,
    }, null, 2))
  }
}
