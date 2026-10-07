/**
 * Live reload for the discovery dirs: fold an added, edited, or deleted hook
 * module into the running registry without a plugin reload. Startup discovery
 * and this watcher share one rule set — the same extensions, the same
 * "no hook export = intentionally disabled" reading, the same validation — so a
 * dropped file behaves identically whether the plugin just started or has been
 * running for hours.
 *
 * Registration is effect-scoped by construction: every spec this watcher
 * installs is unregistered by the disposer it returns, so a plugin reload
 * cannot leave a stale hook behind.
 * @module dsh-native-hooks/watch
 */

import { existsSync, watch as watchFs, type FSWatcher } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DISCOVERABLE_EXTENSIONS, hookFromModule } from './discover.ts'
import { validateSpec } from './service.ts'
import { errorText } from './fold.ts'
import type { HookSpec } from './types.ts'

/** The registry surface this watcher touches; `NativeHooksService` satisfies it. */
export interface HookRegistry {
  register(spec: HookSpec): () => void
}

export interface WatchOptions {
  /** Absolute discovery dirs — the same list startup discovery scans. */
  dirs: readonly string[]
  /** Coalescing window; an editor's atomic save emits several events per write. */
  debounceMs: number
  /** Hook ids the config disables; a reloaded spec carrying one is skipped. */
  disabledHooks: readonly string[]
  logger: { warn(message: string): void; info?(message: string): void }
}

/**
 * Watch every discovery dir and fold file changes into the registry.
 * @param registry Receives each loaded spec; its `register` returns the unregister.
 * @param options Dirs, debounce window, disabled ids, and the log sink.
 * @returns Disposer that closes the watchers and unregisters everything they registered.
 */
export function startWatch(registry: HookRegistry, options: WatchOptions): () => void {
  const registered = new Map<string, () => void>()
  const unregister = (file: string): void => {
    registered.get(file)?.()
    registered.delete(file)
  }
  const load = async (file: string): Promise<void> => {
    unregister(file)
    // A delete, or the rename half of an atomic save, leaves nothing to load.
    if (!existsSync(file)) return
    try {
      // The cache-busting query is the point: a bare import() of an unchanged
      // URL returns the module Node already cached, so editing a file that
      // startup discovery loaded would never take effect.
      const module = await import(`${pathToFileURL(file).href}?v=${Date.now()}`) as Record<string, unknown>
      const candidate = hookFromModule(module)
      // No hook export reads the same here as at startup: intentionally disabled.
      if (candidate === undefined) return
      const problem = validateSpec(candidate)
      if (problem !== null) {
        options.logger.warn(`native-hooks: ${file}: ${problem}`)
        return
      }
      const spec = candidate as HookSpec
      if (options.disabledHooks.includes(spec.id)) return
      registered.set(file, registry.register(spec))
      options.logger.info?.(`native-hooks: reloaded ${basename(file)}`)
    } catch (error) {
      options.logger.warn(`native-hooks: ${file}: failed to load — ${errorText(error)}`)
    }
  }
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    timer = undefined
    const files = [...pending]
    pending.clear()
    for (const file of files) void load(file)
  }
  const watchers: FSWatcher[] = []
  for (const dir of options.dirs) {
    try {
      watchers.push(watchFs(dir, { recursive: true }, (_event, filename) => {
        if (filename === null) return
        const file = join(dir, filename.toString())
        if (!DISCOVERABLE_EXTENSIONS.some((extension) => file.endsWith(extension))) return
        pending.add(file)
        timer ??= setTimeout(flush, options.debounceMs)
      }))
    } catch {
      // An absent discovery dir is the normal case — watch nothing, warn nothing.
    }
  }
  return () => {
    if (timer !== undefined) clearTimeout(timer)
    for (const watcher of watchers) watcher.close()
    for (const file of [...registered.keys()]) unregister(file)
  }
}
