/** Key of the escapes a test file's worker observed, in the file task's `meta`. */
export const ESCAPES_META_KEY = 'vitestFasterEscapes'

/** Target of the entry that marks where the worker stopped recording escapes of one kind group. */
export const TRUNCATED = '(more not recorded)'

/**
 * Ways a test can depend on code that runs outside its worker's V8 isolate,
 * where FASTER's import graph and function coverage cannot see it.
 *
 * - `process`: started a child process (async or sync).
 * - `network`: connected to an address that no server in the worker listens on.
 * - `thread`: started a worker thread.
 * - `native`: loaded a native addon.
 * - `file`: read a file through `fs`, or checked whether it exists.
 */
export type EscapeKind = 'process' | 'network' | 'thread' | 'native' | 'file'

export interface ObservedEscape {
  kind: EscapeKind
  target: string
}
