import { expect, test } from 'vitest'

test('prints a failure as soon as it finishes', () => {
  if (process.env.FASTER_DEMO_FAIL) {
    expect({ checkout: 'ready' }).toEqual({ checkout: 'broken' })
  }
  else {
    expect(true).toBe(true)
  }
})
