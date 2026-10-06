import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { matchesSpec, runSpecs } from '../src/fold.ts'
import type { HookSpec } from '../src/types.ts'

function spec(partial: Partial<HookSpec>): HookSpec {
  return { id: partial.id ?? 's', event: partial.event ?? 'PreToolUse', handle: async () => undefined, ...partial }
}

function input(partial: Partial<Parameters<typeof runSpecs>[1]> = {}) {
  return {
    event: 'PreToolUse' as const, subject: 'Bash', signal: new AbortController().signal,
    toolName: 'Bash', toolInput: {}, raw: {}, ...partial,
  }
}

describe('matchesSpec', () => {
  it('matches everything when no matcher is declared', () => {
    assert.equal(matchesSpec(spec({}), 'Anything'), true)
  })
  it('filters by the event subject', () => {
    const guarded = spec({ matcher: /^Edit$|^Write$/ })
    assert.equal(matchesSpec(guarded, 'Edit'), true)
    assert.equal(matchesSpec(guarded, 'Write'), true)
    assert.equal(matchesSpec(guarded, 'Bash'), false)
  })
  it('is state-free even for g-flagged regexes', () => {
    const flagged = spec({ matcher: /Edit/g })
    assert.equal(matchesSpec(flagged, 'Edit'), true)
    assert.equal(matchesSpec(flagged, 'Edit'), true) // lastIndex must not leak between firings
  })
})

describe('runSpecs folding', () => {
  it('is allow with no matching specs', async () => {
    const outcome = await runSpecs([], input(), 1000)
    assert.deepEqual(outcome, { decision: 'allow', feedback: [], additionalContext: [], errors: [] })
  })

  it('collects additionalContext from strings and arrays in order', async () => {
    const outcome = await runSpecs([
      spec({ id: 'a', handle: () => ({ additionalContext: 'one' }) }),
      spec({ id: 'b', handle: () => ({ additionalContext: ['two', 'three'] }) }),
    ], input(), 1000)
    assert.equal(outcome.decision, 'allow')
    assert.deepEqual(outcome.additionalContext, ['one', 'two', 'three'])
  })

  it('deny is terminal: later ask/allow cannot upgrade it, but their context still lands', async () => {
    const outcome = await runSpecs([
      spec({ id: 'd', handle: () => ({ decision: 'deny', reason: 'first', feedback: 'fb' }) }),
      spec({ id: 'a', handle: () => ({ decision: 'ask', reason: 'second' }) }),
      spec({ id: 'b', handle: () => ({ decision: 'allow', additionalContext: 'late' }) }),
    ], input(), 1000)
    assert.equal(outcome.decision, 'deny')
    assert.equal(outcome.reason, 'first')
    assert.deepEqual(outcome.feedback, ['fb'])
    assert.deepEqual(outcome.additionalContext, ['late'])
  })

  it('ask wins when no deny is present and keeps its reason', async () => {
    const outcome = await runSpecs([
      spec({ id: 'a', handle: () => ({ decision: 'ask', reason: 'confirm?' }) }),
      spec({ id: 'b', handle: () => ({ decision: 'allow' }) }),
    ], input(), 1000)
    assert.equal(outcome.decision, 'ask')
    assert.equal(outcome.reason, 'confirm?')
  })

  it('skips specs for other events and non-matching subjects', async () => {
    let fired = 0
    const outcome = await runSpecs([
      spec({ id: 'wrong-event', event: 'PostToolUse', handle: () => { fired += 1; return undefined } }),
      spec({ id: 'wrong-name', matcher: /^Write$/, handle: () => { fired += 1; return { decision: 'deny' } } }),
      spec({ id: 'right', handle: () => { fired += 1; return undefined } }),
    ], input({ subject: 'Bash' }), 1000)
    assert.equal(fired, 1)
    assert.equal(outcome.decision, 'allow')
  })

  it('is fail-open: a throwing hook is recorded and the rest still run', async () => {
    const outcome = await runSpecs([
      spec({ id: 'boom', handle: () => { throw new Error('exploded') } }),
      spec({ id: 'after', handle: () => ({ additionalContext: 'still here' }) }),
    ], input(), 1000)
    assert.equal(outcome.decision, 'allow')
    assert.equal(outcome.errors.length, 1)
    assert.match(outcome.errors[0]!, /boom: exploded/)
    assert.deepEqual(outcome.additionalContext, ['still here'])
  })

  it('gives up on a hook that exceeds its timeout and keeps folding', async () => {
    const outcome = await runSpecs([
      spec({ id: 'stuck', handle: () => new Promise<undefined>(() => {}) }),
      spec({ id: 'after', handle: () => ({ additionalContext: 'later' }) }),
    ], input(), 20)
    assert.equal(outcome.decision, 'allow')
    assert.match(outcome.errors[0]!, /stuck.*timed out after 20ms/)
    assert.deepEqual(outcome.additionalContext, ['later'])
  })
})
