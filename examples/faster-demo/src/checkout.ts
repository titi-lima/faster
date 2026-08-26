import { findItem, total } from './catalog.js'

export function checkout(ids: string[]): { items: string[]; total: number } {
  const items = ids.filter(id => findItem(id)?.inStock)
  return { items, total: total(items) }
}
