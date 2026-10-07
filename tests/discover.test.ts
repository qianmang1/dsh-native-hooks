import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { after, describe, it } from 'node:test'
import { discoverHooks, resolveDshHome, resolveModulePath } from '../src/discover.ts'

function writeHook(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, body, 'utf8')
  return path
}

describe('discoverHooks', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-hooks-test-'))
  const dir = join(root, 'native-hooks')
  mkdirSync(dir)

  after(() => { rmSync(root, { recursive: true, force: true }) })

  it('loads a default-export spec and a named `hook` export, skipping other files', async () => {
    writeHook(dir, 'default.mjs', `export default { id: 'from-default', event: 'PreToolUse', handle: async () => undefined }`)
    writeHook(dir, 'named.mjs', `export const hook = { id: 'from-named', event: 'Stop', handle: async () => undefined }`)
    writeHook(dir, 'readme.md', 'not a module')
    const report = await discoverHooks([dir], [])
    assert.deepEqual(report.problems, [])
    assert.deepEqual(report.specs.map((spec) => spec.id).sort(), ['from-default', 'from-named'])
    assert.equal(report.specs[0]!.source, join(dir, 'default.mjs'))
  })

  it('reports a broken module and an invalid spec without failing the rest', async () => {
    writeHook(dir, 'syntax.mjs', 'export default { id: broken !!! }')
    writeHook(dir, 'invalid.mjs', `export default { id: 'bad-event', event: 'Sometime', handle: () => {} }`)
    const report = await discoverHooks([dir], [])
    const problems = report.problems.join('\n')
    assert.match(problems, /syntax\.mjs: failed to load/)
    assert.match(problems, /invalid\.mjs: spec\.event must be one of/)
    assert.ok(report.specs.every((spec) => spec.id !== 'bad-event'))
  })

  it('silently skips a module with no hook export (a fully commented-out example), but counts it as inert', async () => {
    writeHook(dir, 'disabled-example.mjs', `// export default { id: 'off', event: 'Stop', handle: async () => undefined }\n`)
    const report = await discoverHooks([dir], [])
    assert.equal(report.specs.some((spec) => spec.id === 'off'), false)
    assert.equal(report.problems.some((problem) => problem.includes('disabled-example.mjs')), false,
      'an inert example file must not produce load problems')
    assert.ok(report.inert.some((file) => file.includes('disabled-example.mjs')),
      'inert files must be counted so the boot log stays explainable')
  })

  it('an explicitly listed module with no hook export stays a problem (you named it; it does nothing)', async () => {
    const path = writeHook(dir, 'empty-explicit.mjs', `export const anything = 1\n`)
    const report = await discoverHooks([], [path])
    assert.match(report.problems.join('\n'), /empty-explicit\.mjs: module exports neither a default nor a named `hook` HookSpec/)
  })

  it('keeps the first registration on duplicate ids', async () => {
    writeHook(dir, 'first.mjs', `export default { id: 'dup', event: 'PreToolUse', handle: async () => ({ decision: 'deny' }) }`)
    writeHook(dir, 'second.mjs', `export default { id: 'dup', event: 'Stop', handle: async () => undefined }`)
    const report = await discoverHooks([dir], [])
    assert.equal(report.specs.filter((spec) => spec.id === 'dup').length, 1)
    assert.equal(report.specs.find((spec) => spec.id === 'dup')?.event, 'PreToolUse')
    assert.match(report.problems.join('\n'), /duplicate hook id "dup"/)
  })

  it('an absent discovery dir is the normal case, not a problem', async () => {
    const report = await discoverHooks([join(root, 'nope'), join(root, 'also-nope')], [])
    assert.deepEqual(report.problems, [])
    assert.deepEqual(report.specs, [])
  })

  it('explicit modules load through the same validation', async () => {
    const path = writeHook(dir, 'explicit.mjs', `export default { id: 'explicit', event: 'PostToolUse', handle: async () => undefined }`)
    const report = await discoverHooks([], [path])
    assert.deepEqual(report.problems, [])
    assert.deepEqual(report.specs.map((spec) => spec.id), ['explicit'])
  })
})

describe('resolveModulePath', () => {
  const dshHome = 'D:/fake-home/.dsh'
  it('passes file: URLs through', () => {
    assert.equal(resolveModulePath('file:///D:/x/hook.mjs', dshHome), 'file:///D:/x/hook.mjs')
  })
  it('converts absolute paths to file URLs', () => {
    const url = resolveModulePath('D:/x/hook.mjs', dshHome)
    assert.match(url, /^file:\/\/\/[Dd]:\/x\/hook\.mjs$/)
  })
  it('expands ~ against the OS home', () => {
    const url = resolveModulePath('~/hooks/a.mjs', dshHome)
    assert.ok(url.includes(encodeURI(homedir().replace(/\\/g, '/')).replace(/%3A/gi, ':').replace(/\/$/, '')) || url.startsWith('file:///'), url)
    assert.match(url, /hooks\/a\.mjs$/)
  })
  it('anchors relative paths at the DSH home', () => {
    const url = resolveModulePath('my-hooks/a.mjs', dshHome)
    assert.match(url, /fake-home\/\.dsh\/my-hooks\/a\.mjs$/)
  })
})

describe('resolveDshHome', () => {
  it('honors $DSH_HOME and falls back to ~/.dsh', () => {
    assert.equal(resolveDshHome({ DSH_HOME: 'D:/custom-home' } as NodeJS.ProcessEnv), 'D:\\custom-home')
    const fallback = resolveDshHome({} as NodeJS.ProcessEnv)
    assert.ok(fallback.endsWith('.dsh'))
    assert.ok(fallback.includes(homedir().split('\\').pop() ?? ''))
  })
})
