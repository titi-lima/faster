import { expect, test } from 'vitest'
import { availableItems } from '../src/catalog.js'

test('exposes a stable list for the storefront', () => {
  expect(availableItems()).toHaveLength(2)
})

test('keeps product ids unique', () => {
  const ids = availableItems().map(item => item.id)
  expect(new Set(ids).size).toBe(ids.length)
})
