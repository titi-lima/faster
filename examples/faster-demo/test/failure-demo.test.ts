import { expect, test } from 'vitest'

test('fails while FASTER_DEMO_FAIL is set', () => {
  if (process.env.FASTER_DEMO_FAIL) {
    expect({ checkout: 'ready' }).toEqual({ checkout: 'broken' })
  }
  else {
    expect(true).toBe(true)
  }
})
