/**
 * Release-gate audit for one dsh plugin package — the executable form of the
 * `dsh-plugin-diagnostics` skill's L1 + L2, plus an optional L3 composition
 * check when a profile directory is supplied and the market's check engine is
 * resolvable from the audited package.
 *
 * Deliberately dependency-light: js-yaml comes bundled with this package, and
 * the market engine is resolved opportunistically from the audited package's
 * own module ancestry. Every finding is leveled; only `error` fails the gate.
 * @module dsh-native-hooks/lib/release-audit
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load, JSON_SCHEMA, Type } from 'js-yaml'

export interface AuditFinding {
  level: 'error' | 'warning' | 'info'
  check: string
  message: string
}

export interface AuditResult {
  ok: boolean
  packageDir: string
  packageName: string
  findings: AuditFinding[]
}

const jsExpr = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown): boolean => typeof data === 'string',
  construct: (data: unknown): unknown => ({ __jsExpr: String(data) }),
})
const entrySchema = JSON_SCHEMA.extend(jsExpr)

function errorText(error: unknown): string {
  try {
    if (error instanceof Error) return error.message
    return String(error)
  } catch {
    return '<unprintable thrown value>'
  }
}

export interface AuditOptions {
  /** Run the L3 composition check against this profile (needs dshmarket resolvable from the audited package). */
  profileDir?: string
}

/** Audit one dsh plugin package; `ok` is false iff any `error` finding. */
export async function auditPackage(packageDir: string, options: AuditOptions = {}): Promise<AuditResult> {
  const dir = resolve(packageDir)
  const findings: AuditFinding[] = []
  const add = (level: AuditFinding['level'], check: string, message: string): void => {
    findings.push({ level, check, message })
  }

  // ── 1. package.json ────────────────────────────────────────────────────
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
  } catch (error) {
    add('error', 'package.json', `unreadable: ${errorText(error)}`)
    return { ok: false, packageDir: dir, packageName: '(unreadable)', findings }
  }
  const name = typeof pkg.name === 'string' ? pkg.name : '(unnamed)'

  // ── 2. entry contract ─────────────────────────────────────────────────
  if (pkg.type !== 'module') {
    add('error', 'entry', `"type" must be "module" (got ${JSON.stringify(pkg.type ?? undefined)})`)
  }
  const exportsDot = (pkg.exports as Record<string, unknown> | undefined)?.['.']
  const entry = typeof pkg.main === 'string' && pkg.main.length > 0
    ? pkg.main
    : typeof exportsDot === 'string'
      ? exportsDot
      : typeof exportsDot === 'object' && exportsDot !== null && typeof (exportsDot as Record<string, unknown>).default === 'string'
        ? (exportsDot as Record<string, string>).default
        : undefined
  if (entry === undefined) {
    add('error', 'entry', 'no "main" and no exports["."] — the loader has nothing to import')
  } else if (!existsSync(join(dir, entry))) {
    add('error', 'entry', `${entry} does not exist on disk — commit the prebuilt artifact (git installs run no build scripts)`)
  }

  // ── 3. dsh.bundle.patch (boot-blocking per the host's own check) ──────
  const dshMeta = (pkg.dsh ?? {}) as { bundle?: { patch?: unknown } }
  const declared = dshMeta.bundle?.patch
  const patchList = typeof declared === 'string'
    ? [declared]
    : Array.isArray(declared) ? declared.filter((item): item is string => typeof item === 'string') : []
  if (patchList.length === 0) {
    add('error', 'dsh.bundle.patch', 'bundle declares no dsh.bundle.patch — "the profile will fail to boot"')
  }
  for (const relative of patchList) {
    const patchPath = join(dir, relative)
    if (!existsSync(patchPath)) {
      add('error', 'dsh.bundle.patch', `declared patch ${relative} is missing from the package`)
      continue
    }
    try {
      const parsed: unknown = load(readFileSync(patchPath, 'utf8'), { schema: entrySchema })
      if (!Array.isArray(parsed)) {
        add('error', 'dsh.bundle.patch', `${relative} is not a top-level YAML array (entry list)`)
        continue
      }
      parsed.forEach((entryItem, index) => {
        if (typeof entryItem !== 'object' || entryItem === null || Array.isArray(entryItem)) {
          add('error', 'dsh.bundle.patch', `${relative} entry ${index + 1} is not a mapping`)
        }
      })
    } catch (error) {
      add('error', 'dsh.bundle.patch', `${relative} failed to parse: ${errorText(error)}`)
    }
  }

  // ── 4. peer policy: @deepseek-ai/* are host-provided ──────────────────
  const dependencies = (pkg.dependencies ?? {}) as Record<string, string>
  const peers = (pkg.peerDependencies ?? {}) as Record<string, string>
  const dshInDeps = Object.keys(dependencies).filter((key) => key.startsWith('@deepseek-ai/'))
  if (dshInDeps.length > 0) {
    add('error', 'peers', `@deepseek-ai/* must be peerDependencies ("*"), never dependencies: ${dshInDeps.join(', ')}`)
  }
  const dshPeers = Object.keys(peers).filter((key) => key.startsWith('@deepseek-ai/'))
  if (dshPeers.length === 0) {
    add('warning', 'peers', 'no @deepseek-ai/* peerDependencies declared — the host provides them; declare what you import')
  }
  for (const key of dshPeers) {
    if (peers[key] !== '*') {
      add('warning', 'peers', `peer ${key} should be "*" (host-provided, never installed), got ${JSON.stringify(peers[key])}`)
    }
  }

  // ── 5. housekeeping ───────────────────────────────────────────────────
  if (!existsSync(join(dir, 'LICENSE'))) add('warning', 'housekeeping', 'LICENSE missing')
  if (!existsSync(join(dir, 'README.md'))) add('warning', 'housekeeping', 'README.md missing')
  if (typeof pkg.license !== 'string') add('warning', 'housekeeping', 'package.json "license" field missing')

  // ── 6. artifact smoke load ────────────────────────────────────────────
  if (entry !== undefined && existsSync(join(dir, entry))) {
    try {
      const mod = (await import(pathToFileURL(join(dir, entry)).href)) as Record<string, unknown>
      const apply = mod.apply ?? (mod.default as Record<string, unknown> | undefined)?.apply
      if (typeof apply !== 'function') {
        add('error', 'smoke', 'module loads but exports no apply function (named-export loader contract)')
      } else {
        add('info', 'smoke', `loaded standalone (${typeof mod.name === 'string' ? mod.name : 'unnamed'})`)
      }
    } catch (error) {
      const message = errorText(error)
      if (message.includes('@deepseek-ai/') && message.includes('Cannot find package')) {
        add('warning', 'smoke', `standalone load blocked by host-provided peers — expected outside the host, verify in-session: ${message}`)
      } else {
        add('error', 'smoke', `lib failed to load: ${message}`)
      }
    }
  }

  // ── 7. optional L3: composition check via the market's engine ─────────
  if (options.profileDir !== undefined) {
    try {
      // The market lives in the PROFILE's node_modules (it is a profile
      // dependency), so resolve from there — not from the audited package.
      const requireFromProfile = createRequire(join(options.profileDir, 'package.json'))
      const marketRoot = dirname(requireFromProfile.resolve('dshmarket/package.json'))
      const check = (await import(pathToFileURL(join(marketRoot, 'lib', 'check.js')).href)) as {
        analyzeProfile(profileDirectory: string, options?: unknown): {
          summary: { errors: string[]; warnings: string[] }
          bundles: { name: string; error: string | null; parseError: string | null }[]
          duplicates: unknown[]
          orphans: { id: string; layer: string; reason: string }[]
        }
      }
      const report = check.analyzeProfile(options.profileDir)
      const ours = report.bundles.find((bundle) => bundle.name === name)
      if (ours?.error !== undefined && ours.error !== null) add('error', 'composition', `our bundle layer: ${ours.error}`)
      if (ours?.parseError !== undefined && ours.parseError !== null) add('error', 'composition', `our bundle layer: ${ours.parseError}`)
      const ourOrphans = report.orphans.filter((orphan) => orphan.layer === name)
      for (const orphan of ourOrphans) add('error', 'composition', `our layer orphan: ${orphan.id} — ${orphan.reason}`)
      if (report.summary.errors.length > 0) {
        add('error', 'composition', `${report.summary.errors.length} profile composition error(s): ${report.summary.errors.slice(0, 3).join(' | ')}`)
      } else {
        add('info', 'composition', `profile composes clean (${report.summary.warnings.length} warning(s), non-blocking)`)
      }
      if (report.duplicates.length > 0) add('error', 'composition', `${report.duplicates.length} duplicate loader id(s) in the composed tree`)
    } catch (error) {
      add('warning', 'composition', `composition check skipped (dshmarket unavailable from this package): ${errorText(error)}`)
    }
  }

  const ok = !findings.some((finding) => finding.level === 'error')
  return { ok, packageDir: dir, packageName: name, findings }
}
