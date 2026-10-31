import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { x } from 'tinyexec'
import { expect, test } from 'vitest'

const host = resolve(import.meta.dirname, '../hosts/vitest-3.2')

test.skipIf(!existsSync(join(host, 'node_modules/vitest')))('refuses Vitest 3 instead of degrading to dependency-level relevance', async () => {
  const root = join(host, 'fixtures/refusal')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'test'), { recursive: true })
  writeFileSync(join(root, 'test/a.test.js'), `import { test } from 'vitest'\ntest('a', () => {})\n`)
  writeFileSync(join(root, 'vitest.config.mjs'), `import { faster } from 'vitest-faster'\nexport default { plugins: [faster()] }\n`)
  const run = await x('node', [join(host, 'node_modules/vitest/vitest.mjs'), 'run'], {
    nodeOptions: { cwd: root, env: { ...process.env, CI: 'true', NO_COLOR: '1' } },
    throwOnError: false,
  })
  const output = `${run.stdout}\n${run.stderr}`
  expect({
    exitCode: run.exitCode,
    error: output.match(/\[vitest-faster\][^\n]*/)?.[0],
    ran: /Test Files/.test(output),
  }).toMatchInlineSnapshot(`
    {
      "error": "[vitest-faster] Vitest 3.2.7 is not supported. FASTER needs Vitest 4.0 or newer to keep function-level relevance.",
      "exitCode": 1,
      "ran": false,
    }
  `)
})
