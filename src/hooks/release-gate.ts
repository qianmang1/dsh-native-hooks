/**
 * Built-in hook: `release-gate`. Intercepts `git tag` (creation only —
 * `-d`/deletion passes) run inside a dsh plugin package and audits the
 * package first: a failing audit denies the tag with the full report, so the
 * release discipline ("diagnose after dev, before tag") is enforced where the
 * agent's hands are. Non-dsh directories and non-tag git commands are no-ops.
 * @module dsh-native-hooks/hooks/release-gate
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { auditPackage } from '../lib/release-audit.ts'
import type { HookSpec } from '../types.ts'

const TAG_CREATE = /^\s*git\s+tag\b(?!\s+-(?:d|delete)\b)/

/** The session workspace the command would run in, when the payload carries an agent. */
function sessionCwd(raw: unknown): string | undefined {
  const header = (raw as { agent?: { session?: { header?: { cwd?: string } } } })?.agent?.session?.header
  const cwd = header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/** Only gate packages that ARE dsh plugins — never a plain repo's `git tag`. */
function isDshPackage(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name?: unknown
      dsh?: unknown
      peerDependencies?: Record<string, unknown>
    }
    if (typeof pkg.name !== 'string') return false
    if (pkg.dsh !== undefined && pkg.dsh !== null) return true
    const peers = pkg.peerDependencies ?? {}
    return Object.keys(peers).some((key) => key.startsWith('@deepseek-ai/'))
  } catch {
    return false
  }
}

export const releaseGate: HookSpec = {
  id: 'release-gate',
  event: 'PreToolUse',
  source: 'builtin:release-gate',
  handle: async (input) => {
    const toolInput = (input.toolInput ?? {}) as Record<string, unknown>
    const command = typeof toolInput.command === 'string' ? toolInput.command : ''
    if (!TAG_CREATE.test(command)) return undefined

    const cwd = sessionCwd(input.raw) ?? process.cwd()
    if (!existsSync(join(cwd, 'package.json'))) return undefined
    if (!isDshPackage(cwd)) return undefined

    const audit = await auditPackage(cwd)
    if (audit.ok) return undefined

    const report = audit.findings
      .map((finding) => `  [${finding.level}] ${finding.check}: ${finding.message}`)
      .join('\n')
    return {
      decision: 'deny',
      reason: `git tag 已被发布门禁拦截：${audit.packageName} 存在 error 级发现。\n${report}\n修复后重试；完整复检命令：npm run release-check（若仓库已配置）。确认要跳过本门禁时，在 native-hooks 配置的 disabledHooks 里加入 "release-gate"。`,
    }
  },
}
