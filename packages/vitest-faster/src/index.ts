import type { Plugin } from 'vite'
import type { FasterOptions } from '../../vitest/src/node/faster/priorityManifest'
import type { FasterLayer } from './host'
import { getHost, PLUGIN_NAME } from './host'

export type { FasterOptions }

interface FasterPluginApi {
  fasterOptions: FasterLayer
}

/**
 * Enables FASTER for every Vitest project whose configuration contains this
 * plugin. Options here are defaults; a project's `test.faster` and the
 * `vitest-faster` CLI flags override them, in that order.
 */
export function faster(options: boolean | FasterOptions = {}): Plugin {
  const plugin: Plugin & { api: FasterPluginApi } = {
    name: PLUGIN_NAME,
    api: { fasterOptions: options },
    configureVitest({ vitest, project }: any) {
      assertSupportedVitest(vitest.version)
      const host = getHost(vitest)
      host.options.set(project, [options])
      const root = (vitest.vite.config.plugins as Plugin[]).find(candidate => candidate.name === PLUGIN_NAME) as typeof plugin | undefined
      if (root) {
        host.rootOptions = [root.api.fasterOptions]
      }
    },
  } as any
  return plugin
}

/**
 * Vitest 3 executes tests through vite-node instead of the Vite module runner
 * the fork's function matching is built on; on 3.2.7 the plugin recorded no
 * function observations, which would silently degrade FASTER to
 * dependency-level relevance. The plugin refuses to run instead.
 */
function assertSupportedVitest(version: string | undefined): void {
  const major = Number.parseInt(version ?? '')
  if (!(major >= 4)) {
    throw new Error(`[${PLUGIN_NAME}] Vitest ${version ?? '(unknown)'} is not supported. FASTER needs Vitest 4.0 or newer to keep function-level relevance.`)
  }
}

export default faster
