export interface CatalogItem {
  id: string
  name: string
  price: number
  inStock: boolean
}

const catalog: CatalogItem[] = [
  { id: 'keyboard', name: 'Mechanical keyboard', price: 129, inStock: true },
  { id: 'monitor', name: '4K monitor', price: 399, inStock: true },
  { id: 'webcam', name: 'Webcam', price: 79, inStock: false },
]

export function findItem(id: string): CatalogItem | undefined {
  return catalog.find(item => item.id === id)
}

export function total(items: string[]): number {
  return items.reduce((sum, id) => sum + (findItem(id)?.price ?? 0), 0)
}

export function availableItems(): CatalogItem[] {
  return catalog.filter(item => item.inStock)
}
