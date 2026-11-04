import type { ChildProcess } from 'node:child_process'
import type { Server, Socket } from 'node:net'
import type { EscapeKind, ObservedEscape } from './escapeRecord'
import { fileURLToPath } from 'node:url'
import { resolve } from 'pathe'
import * as vitest from 'vitest'
import { ESCAPES_META_KEY, TRUNCATED } from './escapeRecord'

const RECORDER = Symbol.for('vitest-faster.recorder')
/** At most this many files, and this many other escapes, are recorded per test file. */
const MAX_FILES = 5000
const MAX_OTHERS = 1000
const LOOPBACK = /^(?:127\.|::1$|::ffff:127\.|localhost$)/

interface Recorder {
  /** Starts recording for the next test file and returns the list its escapes go to. */
  begin: () => ObservedEscape[]
}

/**
 * Setup file the host prepends to every recorded project. Vitest runs setup
 * files before each test file, so everything observed from this module's
 * evaluation until the next file's belongs to that file. The list is the
 * file task's `meta` entry itself, so it is sent with the file's results even
 * when every test is skipped. The hooks are installed once per worker and
 * kept on `process`, which VM pools share between test files while each file
 * gets its own `globalThis`.
 */
// The hooks must be in place before the test file's own imports run.
// eslint-disable-next-line antfu/no-top-level-await
const recorder: Recorder = (process as any)[RECORDER] ??= await install()
const escapes = recorder.begin()
// Vitest 5 has `getCurrentSuite` on `TestRunner`, Vitest 4 only in `vitest/suite`.
const getCurrentSuite: (() => any) | undefined = (vitest as any).TestRunner?.getCurrentSuite
  // eslint-disable-next-line antfu/no-top-level-await
  ?? (await import(/* @vite-ignore */ 'vitest/suite' as string).catch(() => undefined))?.getCurrentSuite
const file = getCurrentSuite?.()?.file
if (file) {
  file.meta[ESCAPES_META_KEY] = escapes
}
else {
  // Vitest 4.0 passes the suite first, 4.1 passes fixtures first and rejects a named first parameter.
  vitest.afterAll(function () {
    // eslint-disable-next-line prefer-rest-params
    const suite = Array.prototype.find.call(arguments, (argument: any) => argument?.type === 'suite') as any
    if (suite?.file) {
      suite.file.meta[ESCAPES_META_KEY] = escapes
    }
  })
}

/**
 * VM pools give each test file copies of the builtin modules, made from the
 * process's own modules when the file first imports them. Patching the
 * process's modules before any copy exists reaches every file.
 */
async function builtin<T>(id: string): Promise<T> {
  return (process as any).getBuiltinModule?.(id) ?? (await import(/* @vite-ignore */ id)).default
}

async function install(): Promise<Recorder> {
  const [childProcess, diagnostics, fs, nodeModule, net] = await Promise.all([
    builtin<typeof import('node:child_process')>('node:child_process'),
    builtin<typeof import('node:diagnostics_channel')>('node:diagnostics_channel'),
    builtin<typeof import('node:fs')>('node:fs'),
    builtin<typeof import('node:module')>('node:module'),
    builtin<typeof import('node:net')>('node:net'),
  ])
  let escapes: ObservedEscape[] = []
  const seen = new Set<string>()
  const counts = { files: 0, others: 0 }
  /** Ports that servers started during the current test file listen on; connections to them stay in its isolate. */
  const ports = new Set<number>()
  const record = (kind: EscapeKind, target: string) => {
    const key = `${kind}\t${target}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    const count = kind === 'file' ? 'files' : 'others'
    const limit = kind === 'file' ? MAX_FILES : MAX_OTHERS
    if (counts[count] < limit) {
      escapes.push({ kind, target })
    }
    else if (counts[count] === limit) {
      escapes.push({ kind, target: TRUNCATED })
    }
    counts[count]++
  }
  const connect = (address: string | undefined, port: number | undefined) => {
    if (!address) {
      record('network', 'local socket')
    }
    else if (!(LOOPBACK.test(address) && port != null && ports.has(port))) {
      record('network', `${address}:${port ?? ''}`)
    }
  }

  const listen = net.Server.prototype.listen
  net.Server.prototype.listen = function (this: Server, ...args: any[]) {
    this.once('listening', () => {
      const address = this.address()
      if (address && typeof address === 'object') {
        ports.add(address.port)
      }
    })
    return listen.apply(this, args as any)
  } as typeof listen

  diagnostics.subscribe('net.client.socket', (message: any) => {
    const socket: Socket = message.socket
    let connected = false
    socket.once('connect', () => {
      connected = true
      connect(socket.remoteAddress, socket.remotePort)
    })
    socket.once('close', () => {
      if (!connected) {
        record('network', 'failed connection')
      }
    })
  })
  // Keep-alive agents reuse sockets across requests, so requests are checked too.
  diagnostics.subscribe('http.client.request.start', (message: any) => {
    message.request.once('socket', (socket: Socket) => {
      if (socket.remoteAddress) {
        connect(socket.remoteAddress, socket.remotePort)
      }
    })
  })
  diagnostics.subscribe('undici:request:create', (message: any) => {
    try {
      const url = new URL(message.request.origin)
      connect(url.hostname.replace(/^\[|\]$/g, ''), Number(url.port || (url.protocol === 'https:' ? 443 : 80)))
    }
    catch {
      record('network', String(message.request.origin))
    }
  })
  diagnostics.subscribe('udp.socket', () => record('network', 'udp'))
  diagnostics.subscribe('worker_threads', () => record('thread', 'worker'))

  // The channel fires in the ChildProcess constructor, before the command is set.
  diagnostics.subscribe('child_process', (message: any) => {
    const child: ChildProcess = message.process
    process.nextTick(() => record('process', describeCommand(child.spawnargs, child.spawnfile)))
  })
  // Synchronous spawns create no ChildProcess, so the channel misses them.
  for (const name of ['spawnSync', 'execFileSync'] as const) {
    wrap(childProcess, name, (file, args) => record('process', describeCommand(Array.isArray(args) ? [file, ...args] : [file])))
  }
  wrap(childProcess, 'execSync', command => record('process', describeCommand([command])))

  // Dependencies change only with the lockfile, so addons and files under `node_modules` are not recorded.
  const dlopen = process.dlopen
  process.dlopen = function (module: { exports: any }, filename: string, ...rest: any[]) {
    const filepath = toPath(filename)
    if (filepath && !filepath.includes('/node_modules/')) {
      record('native', filepath)
    }
    return (dlopen as any).call(process, module, filename, ...rest)
  } as typeof process.dlopen

  const read = (path: unknown) => {
    const filepath = toPath(path)
    if (filepath && !filepath.includes('/node_modules/')) {
      record('file', filepath)
    }
  }
  /** `flags` is the second argument of `open`, which is the callback when the default `'r'` is used. */
  const isRead = (flags: unknown) => flags == null || typeof flags === 'function'
    || (typeof flags === 'number' ? (flags & 3) !== fs.constants.O_WRONLY : typeof flags === 'string' && !/^[wa]/.test(flags))
  const open = (path: unknown, flags: unknown) => isRead(flags) && read(path)
  // Existence and metadata checks count as reads: a test can behave differently once a file appears.
  for (const name of ['readFileSync', 'readFile', 'readdirSync', 'readdir', 'createReadStream', 'existsSync', 'exists', 'statSync', 'stat', 'lstatSync', 'lstat', 'accessSync', 'access'] as const) {
    wrap(fs, name, read)
  }
  wrap(fs, 'openSync', open)
  wrap(fs, 'open', open)
  for (const name of ['readFile', 'readdir', 'stat', 'lstat', 'access'] as const) {
    wrap(fs.promises, name, read)
  }
  wrap(fs.promises, 'open', open)

  // Named ESM imports of builtins see the patched functions only after this.
  nodeModule.syncBuiltinESMExports()
  return {
    begin() {
      escapes = []
      seen.clear()
      counts.files = 0
      counts.others = 0
      ports.clear()
      return escapes
    },
  }
}

function wrap<T extends object>(target: T, name: keyof T & string, observe: (...args: any[]) => unknown): void {
  const original = target[name] as any
  if (typeof original !== 'function') {
    return
  }
  const wrapped = function (this: unknown, ...args: any[]) {
    try {
      observe(...args)
    }
    catch {}
    return original.apply(this, args)
  }
  Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original))
  target[name] = wrapped as any
}

function describeCommand(args: readonly unknown[] | undefined, file?: string | null): string {
  const parts = args?.length ? args : [file ?? 'unknown']
  return parts.map(String).join(' ').slice(0, 300)
}

/** Paths, URLs and buffers can come from another VM context, so they are not checked with `instanceof`. */
function toPath(path: unknown): string | undefined {
  if (typeof path === 'string') {
    return resolve(path)
  }
  if (ArrayBuffer.isView(path)) {
    return resolve(new TextDecoder().decode(path as Uint8Array))
  }
  const url = path as URL | undefined
  return url?.protocol === 'file:' && typeof url.href === 'string' ? resolve(fileURLToPath(url.href)) : undefined
}
