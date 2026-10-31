import type { HostName, ScenarioResult } from './harness'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { canonicalStates, hostNames, hostVersion, missingHosts, runScenario } from './harness'
import { scenarios } from './scenarios'

const missing = missingHosts()

describe.skipIf(missing.length)('FASTER makes the fork\'s decisions on upstream Vitest', () => {
  test('hosts run the expected Vitest releases', () => {
    expect(Object.fromEntries(hostNames.map(name => [name, hostVersion(name)]))).toEqual({
      'fork': '4.1.7-faster.0',
      'vitest-4.0': '4.0.18',
      'vitest-4.1': '4.1.7',
      'vitest-5': '5.0.5',
    })
  })

  describe.each(scenarios)('$name', (scenario) => {
    const results = {} as Record<HostName, ScenarioResult>

    test('runs on every host', async () => {
      await Promise.all(hostNames.map(async (name) => {
        results[name] = await runScenario(name, scenario)
      }))
      expect(Object.keys(results).sort()).toEqual([...hostNames].sort())
    })

    test.each(['vitest-4.0', 'vitest-4.1', 'vitest-5'] as const)('%s executes the fork\'s files and tests in the fork\'s order', (name) => {
      expect(results[name].observations, results[name].output.join('\n----\n')).toEqual(results.fork.observations)
    })

    test('coverage reports exist only where the user enabled coverage', () => {
      const reports = Object.fromEntries(hostNames.map(name => [name, existsSync(join(results[name].root, 'coverage/coverage-summary.json'))]))
      const directories = Object.fromEntries(hostNames.map(name => [name, existsSync(join(results[name].root, 'coverage'))]))
      const expected = scenario.name === 'user-coverage'
      expect({ reports, directories }).toEqual({
        reports: Object.fromEntries(hostNames.map(name => [name, expected])),
        directories: Object.fromEntries(hostNames.map(name => [name, expected])),
      })
    })

    test('the fork\'s decisions', () => {
      expect(summarize(results.fork)).toMatchSnapshot()
    })

    test.each(['vitest-4.0', 'vitest-4.1', 'vitest-5'] as const)('%s records the fork\'s FASTER state', (name) => {
      expect(canonicalStates(results[name].states)).toEqual(canonicalStates(results.fork.states))
    })
  })
})

/** One line per step: exit code, then the executed files in order. */
function summarize(result: ScenarioResult): string[] {
  return result.observations.map(observation => `${observation.step} [${observation.exitCode}]: ${observation.files.join(', ') || '(none)'}`)
}

test.runIf(missing.length)('hosts are installed', () => {
  throw new Error(`Run "pnpm -C test/faster-compat setup:hosts" first. Missing: ${missing.join(', ')}`)
})
