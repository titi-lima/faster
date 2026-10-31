import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(resolve(root, 'dist'), { recursive: true })
copyFileSync(resolve(root, 'types/index.d.ts'), resolve(root, 'dist/index.d.ts'))
