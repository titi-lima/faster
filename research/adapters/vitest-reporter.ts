import type { Reporter, TestModule } from 'vitest/node'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'

/** Records actual start order. Use only with one worker and fileParallelism:false. */
export default class ResearchReporter implements Reporter {
  private root = ''
  private output = ''
  private startedUTC = ''
  private order: string[] = []
  private modules: { file: string; state: string; errors: unknown[] }[] = []
  private cases: { file: string; name: string; state: string }[] = []
  private active = new Set<string>()
  private violations: { name: string; message: string }[] = []

  onInit(ctx: Parameters<NonNullable<Reporter['onInit']>>[0]) {
    if (ctx.config.maxWorkers !== 1) {
      throw new Error('Research ranks require fileParallelism:false and maxWorkers:1')
    }
    if (!process.env.FASTER_RESEARCH_OUTPUT) {
      throw new Error('Set FASTER_RESEARCH_OUTPUT to a fresh execution.json path')
    }
    this.root = ctx.config.root
    this.output = process.env.FASTER_RESEARCH_OUTPUT
    this.startedUTC = new Date().toISOString()
  }

  onTestModuleStart(module: TestModule) {
    if (this.active.size) {
      this.violations.push({ name: 'ParallelExecution', message: 'Overlapping modules invalidate serial rank evidence' })
    }
    this.active.add(module.moduleId)
    this.order.push(relative(this.root, module.moduleId))
  }

  onTestCaseResult(test: Parameters<NonNullable<Reporter['onTestCaseResult']>>[0]) {
    this.cases.push({ file: relative(this.root, test.module.moduleId), name: test.fullName, state: test.result().state })
  }

  onTestModuleEnd(module: TestModule) {
    this.active.delete(module.moduleId)
    this.modules.push({ file: relative(this.root, module.moduleId), state: module.state(), errors: module.errors() })
  }

  onTestRunEnd(_modules: readonly TestModule[], errors: Parameters<NonNullable<Reporter['onTestRunEnd']>>[1]) {
    mkdirSync(dirname(this.output), { recursive: true })
    writeFileSync(this.output, `${JSON.stringify({
      order: this.order,
      modules: this.modules,
      cases: this.cases,
      errors: [...errors.map(error => ({ name: error.name, message: error.message })), ...this.violations],
      startedUTC: this.startedUTC,
      endedUTC: new Date().toISOString(),
    }, null, 2)}\n`)
  }
}
