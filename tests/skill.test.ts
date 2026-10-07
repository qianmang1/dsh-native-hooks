import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { registerSkill, skillMarkdown, SKILL_NAME, SKILL_PROVIDER } from '../src/skill.ts'
import type { SkillServiceSurface } from '../src/types.ts'

type ProviderObject = ReturnType<Parameters<SkillServiceSurface['registerProvider']>[0]>

/** Mirrors @deepseek-ai/dsh-skill's validateCandidate so a regression here
 * fails in CI instead of in the user's running desktop app. */
function validateCandidate(candidate: { name: string; description: string; whenToUse?: string; invocation: { modelInvocable: boolean; userInvocable: boolean }; source: string; provider: string; rank: number }, providerName: string): void {
  assert.equal(typeof candidate.name, 'string')
  assert.match(candidate.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.equal(typeof candidate.description, 'string')
  assert.ok(candidate.description.length > 0)
  assert.equal(typeof candidate.invocation?.modelInvocable, 'boolean')
  assert.equal(typeof candidate.invocation?.userInvocable, 'boolean')
  assert.equal(typeof candidate.source, 'string')
  assert.equal(typeof candidate.rank, 'number')
  assert.ok(Number.isFinite(candidate.rank))
  assert.equal(typeof candidate.provider, 'string')
  assert.equal(candidate.provider, providerName, 'provider must equal the registered provider name')
}

function captureProvider(): ProviderObject {
  let provider: ProviderObject | undefined
  const skills: SkillServiceSurface = {
    registerProvider: (create) => {
      provider = create({ signal: { aborted: false, addEventListener() {} }, invalidate() {} })
      return undefined
    },
  }
  registerSkill({ get: (key) => (key === 'skills' ? skills : undefined) }, 'test-source')
  assert.ok(provider, 'registerProvider must be called')
  return provider!
}

describe('registerSkill contract', () => {
  it('publishes a candidate that satisfies the skill registry validation', async () => {
    const provider = captureProvider()
    assert.equal(provider.name, SKILL_PROVIDER)
    const candidates = await provider.list()
    assert.ok(Array.isArray(candidates), 'list must return an array')
    assert.equal(candidates.length, 1)
    validateCandidate(candidates[0]!, SKILL_PROVIDER)
    assert.equal(candidates[0]!.name, SKILL_NAME)
  })

  it('returns the full definition (content included) from get()', async () => {
    const provider = captureProvider()
    const definition = await provider.get({ name: SKILL_NAME })
    assert.ok(definition, 'get must return the definition for our skill')
    validateCandidate(definition!, SKILL_PROVIDER)
    assert.equal(definition!.content, skillMarkdown)
    assert.ok(definition!.content.includes('HookSpec'))
    assert.equal(await provider.get({ name: 'other' }), undefined)
  })

  it('is a no-op without a skills service (fail-open)', () => {
    assert.doesNotThrow(() => { registerSkill({}, 'test-source') })
    assert.doesNotThrow(() => { registerSkill({ get: () => undefined }, 'test-source') })
  })
})
