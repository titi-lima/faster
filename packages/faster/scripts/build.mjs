import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vitestRoot = resolve(packageRoot, '../vitest')
const runnerRoot = resolve(packageRoot, '../runner')
const copiedFiles = [
  'config.d.ts',
  'coverage.d.ts',
  'environments.d.ts',
  'globals.d.ts',
  'import-meta.d.ts',
  'importMeta.d.ts',
  'index.cjs',
  'index.d.cts',
  'jsdom.d.ts',
  'node.d.ts',
  'optional-runtime-types.d.ts',
  'optional-types.d.ts',
  'reporters.d.ts',
  'runners.d.ts',
  'snapshot.d.ts',
  'suite.d.ts',
  'suppress-warnings.cjs',
  'worker.d.ts',
]

rmSync(join(packageRoot, 'dist'), { force: true, recursive: true })
rmSync(join(packageRoot, 'browser'), { force: true, recursive: true })
cpSync(join(vitestRoot, 'dist'), join(packageRoot, 'dist'), { recursive: true })
cpSync(join(runnerRoot, 'dist'), join(packageRoot, 'dist/_runner'), { recursive: true })
cpSync(join(vitestRoot, 'browser'), join(packageRoot, 'browser'), { recursive: true })

for (const filename of copiedFiles) {
  cpSync(join(vitestRoot, filename), join(packageRoot, filename))
}

cpSync(join(vitestRoot, 'vitest.mjs'), join(packageRoot, 'faster.mjs'))
rewriteRunnerRuntimeImports(join(packageRoot, 'dist'))
rewritePackageReferences(join(packageRoot, 'dist'))
rewritePackageReferences(join(packageRoot, 'browser'))
for (const filename of copiedFiles) {
  rewriteFile(join(packageRoot, filename))
}

function rewriteRunnerRuntimeImports(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filepath = join(directory, entry.name)
    if (entry.isDirectory()) {
      rewriteRunnerRuntimeImports(filepath)
      continue
    }
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.cjs') && !entry.name.endsWith('.mjs')) {
      continue
    }

    const source = readFileSync(filepath, 'utf8')
    const rewritten = source.replace(
      /(['"])@vitest\/runner(?:\/(utils|types))?\1/g,
      (_, quote, subpath) => {
        const filename = subpath ? `${subpath}.js` : 'index.js'
        let specifier = relative(dirname(filepath), join(packageRoot, 'dist/_runner', filename))
          .replaceAll('\\', '/')
        if (!specifier.startsWith('.')) {
          specifier = `./${specifier}`
        }
        return `${quote}${specifier}${quote}`
      },
    )
    if (rewritten !== source) {
      writeFileSync(filepath, rewritten)
    }
  }
}

function rewritePackageReferences(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filepath = join(directory, entry.name)
    if (entry.isDirectory()) {
      rewritePackageReferences(filepath)
      continue
    }
    if (!entry.name.endsWith('.d.ts') && !entry.name.endsWith('.d.cts')) {
      continue
    }
    rewriteFile(filepath)
  }
}

function rewriteFile(filepath) {
  if (!filepath.endsWith('.d.ts') && !filepath.endsWith('.d.cts')) {
    return
  }
  const source = readFileSync(filepath, 'utf8')
  const rewritten = source.replace(/(['"])vitest(?=[/'"])/g, '$1faster')
  if (rewritten !== source) {
    mkdirSync(dirname(filepath), { recursive: true })
    writeFileSync(filepath, rewritten)
  }
}
