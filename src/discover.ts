/**
 * Module discovery: turn config (`dirs` + `modules`) into registered HookSpecs.
 * A dropped `.mjs` file in a discovery dir is the whole authoring workflow —
 * default-export a HookSpec (or name it `hook`) and it is live after the next
 * plugin reload. A module that cannot be read, parsed, or validated is
 * skipped with a problem report and never takes down the boot.
 * @module dsh-native-hooks/discover
 */

import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { errorText } from './fold.ts'
import { validateSpec } from './service.ts'
import type { HookSpec } from './types.ts'

export const DSH_HOME_ENV = 'DSH_HOME'

/** `$DSH_HOME` when set, else `~/.dsh` — the same anchor the harness home uses. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[DSH_HOME_ENV]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * Resolve one configured path. Absolute paths and `file:` URLs pass through;
 * `~/…` expands to the OS home; a relative path anchors at the DSH home so a
 * config entry means the same thing regardless of the launch directory.
 */
export function resolveModulePath(path: string, dshHome: string = resolveDshHome()): string {
  if (path.startsWith('file:')) return path
  const expanded = path === '~' || path.startsWith(`~${'/'}`) || path.startsWith(`~${'\\'}`)
    ? join(homedir(), path.slice(1).replace(/^[/\\]/, ''))
    : path
  if (isAbsolute(expanded)) return pathToFileURL(expanded).href
  return pathToFileURL(join(dshHome, expanded)).href
}

/** Expand one configured dir: `~/…` to the OS home, everything else absolute. */
function expandDir(raw: string): string {
  return raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
    ? join(homedir(), raw.slice(1).replace(/^[/\\]/, ''))
    : resolve(raw)
}

/**
 * The discovery dirs a startup scan and the live watcher both use: every
 * configured dir expanded to an absolute path. An ABSENT list means the
 * documented drop-in dir `$DSH_HOME/native-hooks` — "drop a .mjs and it is
 * live" must not require reading the README. An explicitly EMPTY list means no
 * discovery dirs at all; the two must not collapse into one branch, or every
 * caller that passes `[]` to disable discovery silently watches the real home.
 */
export function resolveDiscoveryDirs(raw: readonly string[] | undefined, dshHome: string): string[] {
  if (raw === undefined) return [join(dshHome, 'native-hooks')]
  return raw.map(expandDir)
}

export const DISCOVERABLE_EXTENSIONS = ['.mjs', '.js', '.ts']

export interface DiscoveryReport {
  specs: HookSpec[]
  /** Non-fatal problems: unreadable dir, bad module, invalid spec, duplicate id. */
  problems: string[]
  /** Files with no hook export at all — inert by design (commented-out
   * examples, unrelated helpers). Skipped silently, but counted so the boot
   * log can show why a hook the author expects is not loaded. */
  inert: string[]
}

/**
 * Load hook modules from every existing discovery `dir` (one `HookSpec` per
 * file, from its default export or named `hook` export) plus every explicit
 * `modules` entry. First-wins on duplicate ids across all sources.
 */
export async function discoverHooks(
  dirs: readonly string[],
  modules: readonly string[],
  dshHome: string = resolveDshHome(),
): Promise<DiscoveryReport> {
  const specs: HookSpec[] = []
  const problems: string[] = []
  const inert: string[] = []
  const seen = new Set<string>()
  const accept = (value: unknown, source: string): void => {
    const problem = validateSpec(value)
    if (problem !== null) {
      problems.push(`${source}: ${problem}`)
      return
    }
    const spec = value as HookSpec
    if (seen.has(spec.id)) {
      problems.push(`${source}: duplicate hook id "${spec.id}" — keeping the first registration`)
      return
    }
    seen.add(spec.id)
    specs.push({ ...spec, source })
  }
  for (const rawDir of dirs) {
    const dir = expandDir(rawDir)
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue // absent discovery dir is the normal case — nothing dropped yet
    }
    for (const entry of entries) {
      if (!DISCOVERABLE_EXTENSIONS.some((ext) => entry.endsWith(ext))) continue
      const source = join(dir, entry)
      try {
        const module = await import(pathToFileURL(source).href)
        const candidate = hookFromModule(module)
        // A module with no hook export at all is inert by design (a fully
        // commented-out example, an unrelated helper) — skip without a
        // problem entry, but count it so the boot log stays explainable.
        if (candidate === undefined) {
          inert.push(source)
          continue
        }
        accept(candidate, source)
      } catch (error) {
        problems.push(`${source}: failed to load — ${errorText(error)}`)
      }
    }
  }
  for (const modulePath of modules) {
    const url = resolveModulePath(modulePath, dshHome)
    try {
      const module = await import(url)
      const candidate = hookFromModule(module)
      // Unlike a drop-in discovery dir, an EXPLICITLY listed module that
      // exports nothing is a misconfiguration (you named it; it does
      // nothing) — keep it a problem rather than an inert skip.
      if (candidate === undefined) {
        problems.push(`${modulePath}: module exports neither a default nor a named \`hook\` HookSpec`)
        continue
      }
      accept(candidate, modulePath)
    } catch (error) {
      problems.push(`${modulePath}: failed to load — ${errorText(error)}`)
    }
  }
  return { specs, problems, inert }
}

export function hookFromModule(module: Record<string, unknown>): unknown {
  // `undefined` = no hook export — the caller skips the file silently (an
  // intentionally disabled or non-hook module), while an exported-but-invalid
  // spec still fails validation loudly.
  return module.default ?? module.hook
}
