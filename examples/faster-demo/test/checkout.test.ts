import { describe, expect, test } from 'vitest'
import { checkout } from '../src/checkout.js'

describe('checkout', () => {
  test('keeps available products and calculates the total', () => {
    expect(checkout(['keyboard', 'monitor'])).toEqual({
      items: ['keyboard', 'monitor'],
      total: 528,
    })
  })

  test('skips products that are out of stock', () => {
    expect(checkout(['webcam', 'keyboard'])).toEqual({
      items: ['keyboard'],
      total: 129,
    })
  })
})
