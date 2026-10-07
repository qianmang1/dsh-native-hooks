import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { resolveDiscoveryDirs } from '../src/discover.ts'
import { startWatch, type HookRegistry } from '../src/watch.ts'
import type { HookSpec } from '../src/types.ts'

/** A registry stand-in that records ids with the same replace/unregister semantics. */
function recordingRegistry(): HookRegistry & { ids: () => string[] } {
  const specs = new Map<string, HookSpec>()
  return {
    register(spec) {
      specs.set(spec.id, spec)
      return () => { if (specs.get(spec.id) === spec) specs.delete(spec.id) }
    },
    ids: () => [...specs.keys()].sort(),
  }
}

/** A module body exporting one valid spec. */
const specBody = (id: string): string =>
  `export default { id: '${id}', event: 'PreToolUse', handle: async () => undefined }\n`

async function eventually(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Give the watcher a window to act on events that must NOT register anything. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400))

const roots: string[] = []
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'native-hooks-watch-'))
  roots.push(dir)
  return dir
}

describe('startWatch', () => {
  after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

  it('registers a dropped module, replaces it on edit, and unregisters it on delete', async () => {
    const dir = makeDir()
    const registry = recordingRegistry()
    const stop = startWatch(registry, { dirs: [dir], debounceMs: 20, disabledHooks: [], logger: { warn: () => {} } })
    try {
      const file = join(dir, 'dropped.mjs')
      writeFileSync(file, specBody('watch-a'), 'utf8')
      await eventually(() => registry.ids().includes('watch-a'), 'the dropped module to register')

      // Must be an edit of the SAME url: the cache-busting query is what makes
      // this take effect at all.
      writeFileSync(file, specBody('watch-b'), 'utf8')
      await eventually(() => registry.ids().includes('watch-b'), 'the edited module to replace its spec')
      assert.deepEqual(registry.ids(), ['watch-b'], 'the replaced id must not linger')

      rmSync(file)
      await eventually(() => registry.ids().length === 0, 'the deleted module to unregister')
    } finally {
      stop()
    }
  })

  it('skips an inert module silently and reports a broken one, without failing the watcher', async () => {
    const dir = makeDir()
    const registry = recordingRegistry()
    const warnings: string[] = []
    const stop = startWatch(registry, {
      dirs: [dir], debounceMs: 20, disabledHooks: [], logger: { warn: (message) => warnings.push(message) },
    })
    try {
      writeFileSync(join(dir, 'inert.mjs'), `// export default { id: 'off', event: 'Stop', handle: () => {} }\n`, 'utf8')
      writeFileSync(join(dir, 'broken.mjs'), 'export default { id: broken !!! }\n', 'utf8')
      await eventually(() => warnings.some((warning) => warning.includes('broken.mjs')), 'the load problem to be reported')
      assert.deepEqual(registry.ids(), [], 'neither an inert nor a broken module may register')
      assert.equal(
        warnings.some((warning) => warning.includes('inert.mjs')), false,
        'an inert module is intentionally disabled, not a problem',
      )
    } finally {
      stop()
    }
  })

  it('honours disabledHooks and registers nothing after disposal', async () => {
    const dir = makeDir()
    const registry = recordingRegistry()
    const stop = startWatch(registry, {
      dirs: [dir], debounceMs: 20, disabledHooks: ['watch-off'], logger: { warn: () => {} },
    })
    writeFileSync(join(dir, 'off.mjs'), specBody('watch-off'), 'utf8')
    await settle()
    assert.deepEqual(registry.ids(), [], 'a disabled id must not register')

    stop()
    writeFileSync(join(dir, 'late.mjs'), specBody('watch-late'), 'utf8')
    await settle()
    assert.deepEqual(registry.ids(), [], 'nothing may register after the watcher is disposed')
  })
})

describe('resolveDiscoveryDirs', () => {
  it('defaults to the drop-in dir so "drop a .mjs" needs no config', () => {
    const home = join(tmpdir(), 'native-hooks-home-')
    assert.deepEqual(resolveDiscoveryDirs(undefined, home), [join(home, 'native-hooks')])
  })

  it('keeps an explicitly empty list empty, and expands configured entries', () => {
    const home = join(tmpdir(), 'native-hooks-home-')
    // `[]` is how a caller (and the pipeline test) says "discover nothing" — it
    // must not fall back to the real home dir.
    assert.deepEqual(resolveDiscoveryDirs([], home), [])
    assert.deepEqual(resolveDiscoveryDirs(['~/extra-hooks'], home), [join(homedir(), 'extra-hooks')])
    assert.deepEqual(resolveDiscoveryDirs([home], home), [home])
  })
})
