/** Historical FAST kernel retained only for the recorded ordering ablation. */
const MINHASH_SIZE = 32
const EXHAUSTIVE_CANDIDATE_LIMIT = 256

export function getSimilarityOrder(values: string[]): number[] {
  if (values.length < 2) {
    return values.map((_, index) => index)
  }

  const signatures = values.map(createMinHash)
  const remaining = values.slice(1).map((_, index) => index + 1)
  const ordered = [0]
  const cumulative = signatures[0].slice()

  while (remaining.length) {
    const candidatePositions = getCandidatePositions(remaining.length)
    let selectedPosition = candidatePositions[0]
    let selectedIndex = remaining[selectedPosition]
    let selectedSimilarity = estimateSimilarity(cumulative, signatures[selectedIndex])

    for (const position of candidatePositions.slice(1)) {
      const index = remaining[position]
      const similarity = estimateSimilarity(cumulative, signatures[index])
      if (
        similarity < selectedSimilarity
        || (similarity === selectedSimilarity && index < selectedIndex)
      ) {
        selectedPosition = position
        selectedIndex = index
        selectedSimilarity = similarity
      }
    }

    ordered.push(selectedIndex)
    mergeMinHash(cumulative, signatures[selectedIndex])
    remaining[selectedPosition] = remaining[remaining.length - 1]
    remaining.pop()
  }

  return ordered
}

function getCandidatePositions(length: number): number[] {
  if (length <= EXHAUSTIVE_CANDIDATE_LIMIT) {
    return Array.from({ length }, (_, index) => index)
  }

  const sampleSize = Math.ceil(Math.sqrt(length))
  const positions: number[] = []
  for (let index = 0; index < sampleSize; index++) {
    positions.push(Math.floor(index * length / sampleSize))
  }
  return positions
}

function createMinHash(text: string): Uint32Array {
  const signature = new Uint32Array(MINHASH_SIZE).fill(0xFFFFFFFF)
  const tokens = new Set(
    text
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .match(/[a-z0-9_$]+/g)
      || [text],
  )

  for (const token of tokens) {
    const tokenHash = fnv1a(token)
    for (let seed = 0; seed < signature.length; seed++) {
      const hash = mixHash(tokenHash, seed)
      if (hash < signature[seed]) {
        signature[seed] = hash
      }
    }
  }
  return signature
}

function fnv1a(value: string): number {
  let hash = 0x811C9DC5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function mixHash(hash: number, seed: number): number {
  let mixed = (hash ^ Math.imul(seed + 1, 0x9E3779B1)) >>> 0
  mixed ^= mixed >>> 16
  mixed = Math.imul(mixed, 0x85EBCA6B)
  mixed ^= mixed >>> 13
  mixed = Math.imul(mixed, 0xC2B2AE35)
  mixed ^= mixed >>> 16
  return mixed >>> 0
}

function estimateSimilarity(left: Uint32Array, right: Uint32Array): number {
  let matches = 0
  for (let index = 0; index < left.length; index++) {
    matches += Number(left[index] === right[index])
  }
  return matches / left.length
}

function mergeMinHash(target: Uint32Array, source: Uint32Array): void {
  for (let index = 0; index < target.length; index++) {
    target[index] = Math.min(target[index], source[index])
  }
}
