import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { diagnosticsSkillMarkdown, registerSkill, skillMarkdown, SKILL_DIAGNOSTICS_NAME, SKILL_NAME, SKILL_PROVIDER } from '../src/skill.ts'
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
  it('publishes both skills, each satisfying the skill registry validation', async () => {
    const provider = captureProvider()
    assert.equal(provider.name, SKILL_PROVIDER)
    const candidates = await provider.list()
    assert.ok(Array.isArray(candidates), 'list must return an array')
    assert.deepEqual(candidates.map((entry) => entry.name).sort(), [SKILL_DIAGNOSTICS_NAME, SKILL_NAME])
    for (const candidate of candidates) {
      validateCandidate(candidate, SKILL_PROVIDER)
      assert.equal(candidate.rank, 400)
    }
  })

  it('returns the full definition (content included) from get() for each name', async () => {
    const provider = captureProvider()
    const hooksDefinition = await provider.get({ name: SKILL_NAME })
    assert.ok(hooksDefinition, 'get must return the native-hooks-development definition')
    validateCandidate(hooksDefinition!, SKILL_PROVIDER)
    assert.equal(hooksDefinition!.content, skillMarkdown)
    assert.ok(hooksDefinition!.content.includes('HookSpec'))

    const diagnosticsDefinition = await provider.get({ name: SKILL_DIAGNOSTICS_NAME })
    assert.ok(diagnosticsDefinition, 'get must return the dsh-plugin-diagnostics definition')
    validateCandidate(diagnosticsDefinition!, SKILL_PROVIDER)
    assert.equal(diagnosticsDefinition!.content, diagnosticsSkillMarkdown)
    assert.ok(diagnosticsDefinition!.content.includes('analyzeProfile'))

    assert.equal(await provider.get({ name: 'other' }), undefined)
  })

  it('is a no-op without a skills service (fail-open)', () => {
    assert.doesNotThrow(() => { registerSkill({}, 'test-source') })
    assert.doesNotThrow(() => { registerSkill({ get: () => undefined }, 'test-source') })
  })
})
