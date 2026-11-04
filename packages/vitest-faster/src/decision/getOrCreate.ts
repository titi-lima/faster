/** The value cached under `key`, created and cached the first time it is asked for. */
export function getOrCreate<K, V>(
  cache: { get: (key: K) => V | undefined; set: (key: K, value: V) => unknown },
  key: K,
  create: () => V,
): V {
  let value = cache.get(key)
  if (value === undefined) {
    value = create()
    cache.set(key, value)
  }
  return value
}
