/**
 * Pure decision folding for native hooks — the exact point where the Claude
 * Code dialect's "run every matching hook, merge, then map" semantics lives.
 * No harness imports: everything here is testable without a runtime.
 * @module dsh-native-hooks/fold
 */

import type { HookInput, HookResult, HookSpec } from './types.ts'

/** Already-most-restrictive view of every matching hook's output. */
export interface FoldedOutcome {
  decision: 'allow' | 'deny' | 'ask'
  /** Deny/ask reason: the first one provided (deny beats ask on ties). */
  reason?: string
  /** Collected PostToolUse deny feedback texts, in hook order. */
  feedback: string[]
  /** Collected additionalContext texts, in hook order. */
  additionalContext: string[]
  /** Per-hook failures (fail-open): the caller logs these and continues. */
  errors: string[]
}

/**
 * Whether `spec` selects this event firing. Matcher subjects are the tool
 * name (tool events), the session source (SessionStart), or `''` (events that
 * ignore matchers). `g`-flagged regexes are tested state-free so a hook can
 * never corrupt matching for later firings.
 */
export function matchesSpec(spec: HookSpec, subject: string): boolean {
  if (spec.matcher === undefined) return true
  const source = spec.matcher.source
  const flags = spec.matcher.flags.replace('g', '')
  return new RegExp(source, flags).test(subject)
}

/** Run every matching spec serially in registration order and fold the results. */
export async function runSpecs(
  specs: readonly HookSpec[],
  input: HookInput,
  timeoutMs: number,
): Promise<FoldedOutcome> {
  const outcome: FoldedOutcome = { decision: 'allow', feedback: [], additionalContext: [], errors: [] }
  for (const spec of specs) {
    if (spec.event !== input.event || !matchesSpec(spec, input.subject)) continue
    let result: HookResult | undefined | void
    try {
      result = await withTimeout(Promise.resolve(spec.handle(input)), timeoutMs, spec.id)
    } catch (error) {
      outcome.errors.push(`${spec.id}: ${errorText(error)}`)
      continue
    }
    if (result === undefined || result === null) continue
    if (result.additionalContext !== undefined) {
      const contexts = result.additionalContext
      if (Array.isArray(contexts)) outcome.additionalContext.push(...contexts)
      else outcome.additionalContext.push(contexts)
    }
    if (result.decision === 'deny') {
      // Deny is terminal in the fold; later hooks still run (side effects and
      // extra context are honored) but can never upgrade the decision.
      outcome.decision = 'deny'
      outcome.reason ??= result.reason
      if (result.feedback !== undefined) outcome.feedback.push(result.feedback)
    } else if (result.decision === 'ask' && outcome.decision !== 'deny') {
      outcome.decision = 'ask'
      outcome.reason ??= result.reason
    }
  }
  return outcome
}

function withTimeout<T>(promise: Promise<T>, ms: number, id: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`hook "${id}" timed out after ${ms}ms`))
    }, ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/** Best-effort human-readable message from an arbitrary thrown value. */
export function errorText(error: unknown): string {
  try {
    if (error instanceof Error) return error.message
    if (typeof error === 'object' && error !== null && 'message' in error
      && typeof (error as { message?: unknown }).message === 'string') {
      return (error as { message: string }).message
    }
    return String(error)
  } catch {
    return '<unprintable thrown value>'
  }
}
