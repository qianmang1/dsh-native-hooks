import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { auditPackage } from '../src/lib/release-audit.ts'
import { releaseGate } from '../src/hooks/release-gate.ts'
import type { HookInput } from '../src/types.ts'

const REPO = 'D:/DSH_work/dsh-native-hooks'
const DESKTOP_PROFILE = 'C:/Users/Y/.dsh/profiles/desktop'

function bashInput(command: string, cwd: string, rawAgent = true): HookInput {
  return {
    event: 'PreToolUse', subject: 'Bash', toolName: 'Bash', toolInput: { command },
    signal: new AbortController().signal,
    raw: rawAgent ? { agent: { session: { header: { cwd } } } } : {},
  }
}

function fixturePackage(dir: string, options: { broken?: boolean; dshless?: boolean; withLib?: boolean } = {}): void {
  mkdirSync(join(dir, 'lib'), { recursive: true })
  const patch = options.broken
    ? `- id: x\n  config:\n    command: "C:\\Users\\Y\\.dsh\\broken.js"\n`
    : `- insert:\n    - id: fixture-row\n      name: ./lib/index.js\n`
  const pkg = options.dshless
    ? { name: 'plain-repo', version: '1.0.0', type: 'module', main: 'lib/index.js' }
    : {
        name: 'dsh-fixture-plugin', version: '1.0.0', type: 'module', main: 'lib/index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        peerDependencies: { '@deepseek-ai/dsh-tools': '*' },
      }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg), 'utf8')
  writeFileSync(join(dir, 'cordis.patch.yml'), patch, 'utf8')
  if (options.withLib) writeFileSync(join(dir, 'lib', 'index.js'), `export const name = 'dsh-fixture-plugin'\nexport function apply() {}\n`, 'utf8')
}

describe('auditPackage', () => {
  it('passes on this repository itself (dogfood)', async () => {
    const result = await auditPackage(REPO)
    assert.equal(result.packageName, 'dsh-native-hooks')
    const errors = result.findings.filter((finding) => finding.level === 'error')
    assert.deepEqual(errors, [], `unexpected errors: ${JSON.stringify(errors)}`)
    assert.equal(result.ok, true)
  })

  it('passes L3 with the real profile when asked (clean profile, warnings are non-blocking)', async () => {
    const result = await auditPackage(REPO, { profileDir: DESKTOP_PROFILE })
    const compositionErrors = result.findings.filter((finding) => finding.level === 'error' && finding.check === 'composition')
    assert.deepEqual(compositionErrors, [])
  })

  it('flags the boot-breaking omissions on a broken fixture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'release-gate-'))
    after(() => { rmSync(root, { recursive: true, force: true }) })
    const dir = join(root, 'bad-plugin')
    fixturePackage(dir, { broken: true })
    const result = await auditPackage(dir)
    assert.equal(result.ok, false)
    const checks = result.findings.filter((finding) => finding.level === 'error').map((finding) => finding.check)
    assert.ok(checks.includes('dsh.bundle.patch'), `patch parse error expected: ${JSON.stringify(result.findings)}`)
    assert.ok(checks.includes('entry') || checks.includes('smoke'), 'missing lib artifact expected')
  })
})

describe('release-gate hook', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-gate-hook-'))
  after(() => { rmSync(root, { recursive: true, force: true }) })
  const badDir = join(root, 'bad')
  const goodDir = join(root, 'good')
  const plainDir = join(root, 'plain')
  fixturePackage(badDir, { broken: true })
  fixturePackage(goodDir, { withLib: true })
  fixturePackage(plainDir, { dshless: true, withLib: true })

  it('denies git tag in a failing dsh package, with the report as the reason', async () => {
    const result = await releaseGate.handle(bashInput('git tag v1.0.0', badDir))
    assert.ok(result && typeof result === 'object' && 'decision' in result)
    assert.equal((result as { decision: string }).decision, 'deny')
    assert.match((result as { reason: string }).reason, /发布门禁/)
  })

  it('allows git tag in a healthy dsh package', async () => {
    const result = await releaseGate.handle(bashInput('git tag v1.0.0', goodDir))
    assert.equal(result, undefined)
  })

  it('never fires for non-tag commands, tag deletion, or non-dsh packages', async () => {
    assert.equal(await releaseGate.handle(bashInput('npm test', badDir)), undefined)
    assert.equal(await releaseGate.handle(bashInput('git tag -d v1.0.0', badDir)), undefined)
    assert.equal(await releaseGate.handle(bashInput('git tag v1.0.0', plainDir)), undefined)
    assert.equal(await releaseGate.handle(bashInput('git tag v1.0.0', join(root, 'no-package-json'))), undefined)
    // No agent in the payload (no session cwd) — fail-open.
    assert.equal(await releaseGate.handle(bashInput('git tag v1.0.0', badDir, false)), undefined)
  })
})
