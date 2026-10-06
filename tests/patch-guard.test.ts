import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { cordisPatchGuard, patchProblem } from '../src/hooks/patch-guard.ts'
import type { HookInput } from '../src/types.ts'

const GOOD = `# comment
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: system
- insert:
    - id: mcp-ima
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        command: C:\\Program Files\\nodejs\\node.exe
`
const BROKEN_ESCAPE = `- id: mcp-ima
  config:
    command: C:\\Program Files\\nodejs\\node.exe
    args:
      - "C:\\Users\\Y\\.dsh\\mcp\\ima-mcp-server\\server.js"
`
const TOP_LEVEL_OBJECT = `id: not-a-list
name: x
`
const NON_MAPPING_ENTRY = `- id: ok-entry
  name: some-plugin
- [also, wrong]
`

function patchInput(filePath: string): HookInput {
  return {
    event: 'PostToolUse', subject: 'Edit', toolName: 'Edit', toolInput: { file_path: filePath },
    signal: new AbortController().signal, raw: {},
  }
}

describe('patchProblem (the same dialect the boot parses)', () => {
  it('accepts a well-formed entry list', () => {
    assert.equal(patchProblem(GOOD), null)
  })
  it('rejects double-quoted single-backslash Windows paths', () => {
    assert.match(patchProblem(BROKEN_ESCAPE) ?? '', /invalid entry list/)
  })
  it('rejects a top-level mapping', () => {
    assert.match(patchProblem(TOP_LEVEL_OBJECT) ?? '', /YAML 数组/)
  })
  it('rejects non-mapping entries', () => {
    assert.match(patchProblem(NON_MAPPING_ENTRY) ?? '', /entry 2 must be a mapping/)
  })
})

describe('cordis-patch-guard handle', () => {
  const root = mkdtempSync(join(tmpdir(), 'patch-guard-test-'))
  after(() => { rmSync(root, { recursive: true, force: true }) })

  it('denies an edited cordis.patch.yml that no longer parses', () => {
    const filePath = join(root, 'cordis.patch.yml')
    writeFileSync(filePath, BROKEN_ESCAPE, 'utf8')
    const result = cordisPatchGuard.handle(patchInput(filePath))
    assert.ok(result && !Array.isArray(result) && typeof result === 'object')
    assert.equal((result as { decision?: string }).decision, 'deny')
    const feedback = (result as { feedback?: string }).feedback ?? ''
    assert.match(feedback, /invalid entry list/)
    assert.match(feedback, /双反斜杠/) // the actionable fix hint is attached
  })

  it('is silent on a healthy patch file', () => {
    const filePath = join(root, 'cordis.patch.yml')
    writeFileSync(filePath, GOOD, 'utf8')
    assert.equal(cordisPatchGuard.handle(patchInput(filePath)), undefined)
  })

  it('ignores other filenames (including patch backups)', () => {
    const backup = join(root, 'cordis.patch.yml.bak-argsfix')
    writeFileSync(backup, BROKEN_ESCAPE, 'utf8')
    assert.equal(cordisPatchGuard.handle(patchInput(backup)), undefined)
    const readme = join(root, 'README.md')
    assert.equal(cordisPatchGuard.handle(patchInput(readme)), undefined)
  })

  it('fails open when the edited file is already gone', () => {
    assert.equal(cordisPatchGuard.handle(patchInput(join(root, 'deleted', 'cordis.patch.yml'))), undefined)
  })
})
