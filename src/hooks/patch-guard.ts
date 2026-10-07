/**
 * Built-in hook: `cordis-patch-guard`. Any Edit/Write/MultiEdit landing on a
 * `cordis.patch.yml` is re-parsed with the exact dialect the real boot uses
 * (js-yaml JSON_SCHEMA extended with the `!!js` tag; top-level array; mapping
 * entries), and a failure denies the result with a model-visible, actionable
 * message — the same class of error that once blocked a plugin update until
 * the next market trial boot surfaced it.
 * @module dsh-native-hooks/hooks/patch-guard
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { load, JSON_SCHEMA, Type } from 'js-yaml'
import type { HookSpec } from '../types.ts'

const jsExpr = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown): boolean => typeof data === 'string',
  construct: (data: unknown): unknown => ({ __jsExpr: String(data) }),
})
const entrySchema = JSON_SCHEMA.extend(jsExpr)

/** Parse entry-list source with the DSH dialect; `null` when it is not a list. */
export function parsePatchText(text: string): unknown[] | null {
  try {
    const value = load(text, { schema: entrySchema })
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** Validate the file's text; `null` when it is a well-formed entry list. */
export function patchProblem(text: string): string | null {
  let parsed: unknown
  try {
    parsed = load(text, { schema: entrySchema })
  } catch (error) {
    return `cordis.patch.yml 不是合法的条目列表 / invalid entry list: ${error instanceof Error ? error.message : String(error)}`
  }
  if (!Array.isArray(parsed)) {
    return 'cordis.patch.yml 不是合法的条目列表 / invalid entry list: 顶层必须是 YAML 数组（每行一个 "- id: ..." 补丁条目），而不是对象或标量。'
  }
  for (let index = 0; index < parsed.length; index++) {
    const entry = parsed[index]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return `cordis.patch.yml 不是合法的条目列表 / invalid entry list: 第 ${index + 1} 个条目必须是映射（entry ${index + 1} must be a mapping）。`
    }
  }
  return null
}

const FIX_HINT = '注意：Windows 路径要么不加引号（command: C:\\Path\\File.exe），要么双引号内双反斜杠（"C:\\\\Path\\\\File.exe"）。'

/** Read-shaped tools must still see the file CONTENT — a blocked read leaves
 * the agent unable to repair the file. Reads get the diagnostic as injected
 * context instead; mutations get the deny. */
const READISH_TOOL = /\bread\b|\bview\b|\blist\b|\bsearch\b|\bgrep\b|\bglob\b|\bls\b|\bcat\b|\bshow\b|\bpeek\b|\bfind\b/i

export const cordisPatchGuard: HookSpec = {
  id: 'cordis-patch-guard',
  event: 'PostToolUse',
  // No tool-name matcher on purpose: file tools differ per host (Claude Code
  // Edit/Write, DSH `edit`/`write`/`str_replace_editor`, …). The handle
  // filters by the edited path's basename instead, so ANY tool call that
  // landed on a cordis.patch.yml is guarded.
  source: 'builtin:cordis-patch-guard',
  handle(input) {
    const toolInput = (input.toolInput ?? {}) as Record<string, unknown>
    const filePath = ['file_path', 'path', 'filePath', 'filename']
      .map((key) => toolInput[key])
      .find((value): value is string => typeof value === 'string' && value.length > 0) ?? ''
    // The basename is the contract: every profile's patch layer and the
    // home-level one are guarded; backups (`cordis.patch.yml.bak-*`) are not.
    if (filePath.length === 0 || basename(filePath) !== 'cordis.patch.yml') return undefined
    let text: string
    try {
      text = readFileSync(filePath, 'utf8')
    } catch {
      return undefined // deleted or unreadable after the edit — nothing to guard
    }
    const problem = patchProblem(text)
    if (problem === null) return undefined
    const toolName = input.toolName ?? ''
    const isRead = READISH_TOOL.test(toolName) || toolInput.command === 'view'
    if (isRead) {
      return { additionalContext: `⚠ ${problem} ${FIX_HINT}` }
    }
    return { decision: 'deny', feedback: `${problem} ${FIX_HINT}` }
  },
}
