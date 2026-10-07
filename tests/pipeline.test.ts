import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as nativeHooks from '../src/index.ts'
import type { Config } from '../src/index.ts'

const CALL = () => ({ callId: ToolCallId(`c${Math.random()}`), name: 'probe', arguments: {}, signal: new AbortController().signal })
const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms) })

const moduleRoot = mkdtempSync(join(tmpdir(), 'native-hooks-pipeline-'))
after(() => { rmSync(moduleRoot, { recursive: true, force: true }) })

async function setup(config?: Partial<Config>) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(nativeHooks, {
    dirs: [], dropInDir: false, modules: [], disabledHooks: [], timeoutMs: 5000, ...config,
  })
  return ctx
}

const probeTool = defineContentToolFixture({
  name: 'probe', description: 'always ok', parameters: {},
  async execute() { return [{ type: 'text' as const, text: 'ok' }] },
})

describe('native-hooks pipeline (real Context + ToolRuntime)', () => {
  it('provides the nativeHooks service with the built-in patch guard registered', async () => {
    const ctx = await setup()
    assert.ok(ctx.nativeHooks, 'ctx.nativeHooks must be provided')
    assert.ok(ctx.nativeHooks.has('cordis-patch-guard'))
  })

  it('honors disabledHooks', async () => {
    const ctx = await setup({ disabledHooks: ['cordis-patch-guard'] })
    assert.equal(ctx.nativeHooks.has('cordis-patch-guard'), false)
  })

  it('a PreToolUse deny becomes a model-visible error result', async () => {
    const ctx = await setup()
    ctx.nativeHooks.register({
      id: 'deny-probe', event: 'PreToolUse', matcher: /^probe$/,
      handle: () => ({ decision: 'deny', reason: 'nope' }),
    })
    ctx.tools.register(probeTool)
    const result = await ctx.tools.execute(CALL())
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result.error ?? result), /nope/)
  })

  it('matcher filtering keeps other tools unaffected', async () => {
    const ctx = await setup()
    ctx.nativeHooks.register({
      id: 'deny-other', event: 'PreToolUse', matcher: /^other$/,
      handle: () => ({ decision: 'deny', reason: 'should not fire' }),
    })
    ctx.tools.register(probeTool)
    const result = await ctx.tools.execute(CALL())
    assert.equal(result.isError, false)
  })

  it('a PostToolUse deny turns corrective feedback into the result', async () => {
    const ctx = await setup()
    ctx.nativeHooks.register({
      id: 'post-block', event: 'PostToolUse',
      handle: () => ({ decision: 'deny', feedback: 'corrective feedback here' }),
    })
    ctx.tools.register(probeTool)
    const result = await ctx.tools.execute(CALL())
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result.content ?? result), /corrective feedback here/)
  })

  it('unregistering stops the hook from firing', async () => {
    const ctx = await setup()
    const unregister = ctx.nativeHooks.register({
      id: 'temporary', event: 'PreToolUse',
      handle: () => ({ decision: 'deny', reason: 'temporarily blocked' }),
    })
    unregister()
    ctx.tools.register(probeTool)
    const result = await ctx.tools.execute(CALL())
    assert.equal(result.isError, false)
  })

  it('config modules are discovered detached and still drive decisions', async () => {
    const modulePath = join(moduleRoot, 'from-module.mjs')
    writeFileSync(modulePath, `export default {
      id: 'from-module', event: 'PreToolUse', matcher: /^probe$/,
      handle: async () => ({ decision: 'deny', reason: 'blocked by module' }),
    }`, 'utf8')
    const ctx = await setup({ modules: [modulePath] })
    for (let i = 0; i < 100 && !ctx.nativeHooks.has('from-module'); i++) await sleep(20)
    assert.ok(ctx.nativeHooks.has('from-module'), 'discovered module spec must register')
    ctx.tools.register(probeTool)
    const result = await ctx.tools.execute(CALL())
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result.error ?? result), /blocked by module/)
  })

  it('keeps the named-export loader contract (no default export)', () => {
    assert.equal('default' in nativeHooks, false)
    assert.equal(typeof nativeHooks.apply, 'function')
    assert.equal(nativeHooks.name, 'native-hooks')
  })

  it('malformed registrations throw synchronously with a reason', async () => {
    const ctx = await setup()
    assert.throws(() => { ctx.nativeHooks.register({ id: 'x', event: 'Sometime' as never, handle: async () => undefined }) }, /spec\.event/)
  })
})
