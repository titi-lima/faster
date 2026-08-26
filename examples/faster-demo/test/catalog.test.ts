import { describe, expect, test } from 'vitest'
import { availableItems, findItem, total } from '../src/catalog.js'

describe('catalog', () => {
  test('finds a product by id', () => {
    expect(findItem('keyboard')?.name).toBe('Mechanical keyboard')
  })

  test('calculates a cart total', () => {
    expect(total(['keyboard', 'monitor'])).toBe(528)
  })

  test('only lists products in stock', () => {
    expect(availableItems().map(item => item.id)).toEqual(['keyboard', 'monitor'])
  })
})
