/**
 * dsh-native-hooks — a native, in-process hooks registry for DeepSeek Harness.
 *
 * One plugin owns every registration: it provides the `ctx.nativeHooks`
 * service and mounts the seven lifecycle listeners (the same surface as the
 * Claude Code bridge) exactly once. Hook authors never touch waterfall APIs —
 * they default-export a `HookSpec` from a dropped `~/.dsh/native-hooks/*.mjs`
 * file, list it in `modules`, or call `ctx.nativeHooks.register()` from
 * another plugin; all three paths converge in the same fold.
 *
 * Decision semantics mirror `@deepseek-ai/dsh-hooks-claude-code`: deny is
 * terminal (deny > ask > allow), ask rides the approval seam, a blocking Stop
 * steers one more turn, and additional contexts prepend onto the downstream
 * decision. A failing or timed-out hook is fail-open and logged.
 * @module dsh-native-hooks
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import type { PostToolDecision, PreToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { discoverHooks, resolveDiscoveryDirs, resolveDshHome } from './discover.ts'
import { errorText, runSpecs } from './fold.ts'
import { cordisPatchGuard } from './hooks/patch-guard.ts'
import { releaseGate } from './hooks/release-gate.ts'
import { registerSkill } from './skill.ts'
import { NativeHooksService } from './service.ts'
import { startWatch } from './watch.ts'
import type { FoldedOutcome } from './fold.ts'
import type { HookSpec } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'native-hooks': { kind: 'native-hooks' } & ContextFormed
  }
}

const CONTEXT_SOURCE = { kind: 'native-hooks' } as const
const SUBAGENT_TYPE = 'general-purpose'

export const name = 'native-hooks'

export interface Config {
  /** Discovery dirs; absent means the default `$DSH_HOME/native-hooks`, an explicit `[]` means none. */
  dirs?: string[]
  /** Explicit hook module paths: absolute, `~/…`, `file:` URLs, or DSH-home-relative. */
  modules?: string[]
  /** Built-in hook ids to skip (currently only `cordis-patch-guard`). */
  disabledHooks?: string[]
  /** Per-hook `handle` budget in ms; a hook that exceeds it fails open with a warning. */
  timeoutMs?: number
  /** Fold added/edited/deleted discovery modules into the registry without a plugin reload. */
  watchEnabled?: boolean
  /** Coalescing window for the discovery watcher, in ms. */
  watchDebounceMs?: number
}

export const Config: z<Config> = z.object({
  dirs: z.array(z.string()),
  modules: z.array(z.string()).default([]),
  disabledHooks: z.array(z.string()).default([]),
  timeoutMs: z.number().default(10_000),
  watchEnabled: z.boolean().default(true),
  watchDebounceMs: z.number().default(150),
})

export function apply(ctx: Context, config: Config): void {
  const timeoutMs = config.timeoutMs ?? 10_000
  const dshHome = resolveDshHome()
  // One dirs list for both halves: the startup scan and the live watcher must
  // never disagree about where hooks live.
  const dirs = resolveDiscoveryDirs(config.dirs, dshHome)
  const service = new NativeHooksService(ctx)

  // Built-ins first so a same-id external spec replaces them deliberately.
  if (!config.disabledHooks?.includes(cordisPatchGuard.id)) service.register(cordisPatchGuard)
  if (!config.disabledHooks?.includes(releaseGate.id)) service.register(releaseGate)

  // Emit-shaped points run detached, so their chains are tracked and drained
  // before the plugin's fiber disposes (same discipline as the bridge).
  const detached = createDetachedRuns()
  ctx.effect(() => () => { void detached.drain() }, 'native-hooks: drain detached hook runs')

  // Discovery is async (dynamic imports) while `apply` stays sync: the
  // listeners read `service.list()` at call time, so specs that land a moment
  // later still fire. Problems never take down the boot.
  void discoverHooks(dirs, config.modules ?? [], dshHome)
    .then((report) => {
      for (const problem of report.problems) ctx.logger.warn(`native-hooks: ${problem}`)
      for (const spec of report.specs) {
        if (config.disabledHooks?.includes(spec.id)) continue
        service.register(spec)
      }
      const skipped = config.disabledHooks
        ? report.specs.filter((spec) => config.disabledHooks?.includes(spec.id)).length
        : 0
      if (report.specs.length > 0 || report.inert.length > 0) {
        ctx.logger.info(
          `native-hooks: loaded ${report.specs.length - skipped} hook module(s)` +
          (report.inert.length > 0 ? `, skipped ${report.inert.length} inert file(s)` : ''),
        )
      }
    })
    .catch((error: unknown) => {
      ctx.logger.warn(`native-hooks: discovery failed: ${errorText(error)}`)
    })

  // A dropped file is live without a plugin reload; `watchEnabled: false`
  // restores the startup-scan-only behavior.
  if (config.watchEnabled !== false) {
    const stopWatch = startWatch(service, {
      dirs,
      debounceMs: config.watchDebounceMs ?? 150,
      disabledHooks: config.disabledHooks ?? [],
      logger: ctx.logger,
    })
    ctx.effect(() => stopWatch, 'native-hooks: watch discovery dirs')
  }

  registerSkill(ctx, 'dsh-native-hooks')

  const specsFor = (event: HookSpec['event']): readonly HookSpec[] =>
    service.list().filter((spec) => spec.event === event)

  // --- SessionStart → agent.inject(additionalContext). Matcher subject is the
  // session source ('startup' | 'resume' | 'clear' | 'compact'). ---
  ctx.on('agent/created', async ({ agent, source, signal }) => {
    const specs = specsFor('SessionStart')
    if (specs.length === 0) return
    const owner = signal === undefined ? detached.signal : AbortSignal.any([signal, detached.signal])
    const run = runSpecs(specs, { event: 'SessionStart', subject: source, signal: owner, raw: { agent, source } }, timeoutMs)
      .then((outcome) => {
        logOutcome(ctx, outcome)
        const message = contextFrom(outcome)
        if (message !== undefined) agent.inject(message)
      })
      .catch((error: unknown) => {
        ctx.logger.warn(`native-hooks: SessionStart hook failed: ${errorText(error)}`)
      })
    detached.track(run)
    await run
  })

  // --- UserPromptSubmit → PreStepDecision. Deny rejects the step; context
  // prepends onto a downstream enter. No matcher subject. ---
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    const specs = specsFor('UserPromptSubmit')
    if (messages.length === 0 || specs.length === 0) return next()
    const prompt = textOfBlocks(messages.flatMap((message) => message.content))
    const outcome = await runSpecs(
      specs,
      { event: 'UserPromptSubmit', subject: '', turn, signal, raw: { agent, prompt, messages } },
      timeoutMs,
    )
    logOutcome(ctx, outcome)
    if (outcome.decision === 'deny') return { kind: 'reject' }
    const downstream = await next()
    const ours = contextFrom(outcome)
    if (ours !== undefined && downstream.kind === 'enter') {
      return { ...downstream, messages: [ours, ...downstream.messages] }
    }
    return downstream
  })

  // --- PreToolUse → PreToolDecision. Deny/ask short-circuit; ask rides the
  // approval seam (absent service degrades to deny inside the registry). ---
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const specs = specsFor('PreToolUse')
    if (specs.length === 0) return next()
    const outcome = await runSpecs(
      specs,
      {
        event: 'PreToolUse', subject: exec.name, toolName: exec.name, toolInput: exec.arguments,
        signal: exec.signal, raw: exec,
      },
      timeoutMs,
    )
    logOutcome(ctx, outcome)
    if (outcome.decision === 'deny') {
      return { kind: 'deny', reason: outcome.reason ?? outcome.feedback[0] ?? 'blocked by native hook' }
    }
    if (outcome.decision === 'ask') return { kind: 'ask', reason: outcome.reason }
    return next()
  })

  // --- PostToolUse → PostToolDecision. A deny turns corrective feedback into
  // the model-visible result; context prepends onto accept AND block. ---
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const specs = specsFor('PostToolUse')
    if (specs.length === 0) return next()
    const outcome = await runSpecs(
      specs,
      {
        event: 'PostToolUse', subject: exec.name, toolName: exec.name, toolInput: exec.arguments,
        toolResponse: textOfBlocks(result?.content), signal: exec.signal, raw: { exec, result },
      },
      timeoutMs,
    )
    logOutcome(ctx, outcome)
    if (outcome.decision === 'deny') {
      const text = outcome.feedback.length > 0
        ? outcome.feedback.join('\n\n')
        : outcome.reason ?? 'blocked by native hook'
      const base: PostToolDecision = { kind: 'block', feedback: [{ type: 'text', text }] }
      const ours = contextFrom(outcome)
      return ours === undefined ? base : { ...base, additionalContexts: [ours] }
    }
    const downstream = await next()
    const ours = contextFrom(outcome)
    if (ours === undefined) return downstream
    return { ...downstream, additionalContexts: [ours, ...downstream.additionalContexts ?? []] }
  })

  // --- Stop → steering. A deny forces one more turn via agent.steer; there
  // is no decision return on this serial point. ---
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const specs = specsFor('Stop')
    if (specs.length === 0) return
    const outcome = await runSpecs(specs, { event: 'Stop', subject: '', turn, signal, raw: { agent, turn } }, timeoutMs)
    logOutcome(ctx, outcome)
    if (outcome.decision === 'deny') {
      const text = outcome.reason ?? outcome.feedback[0] ?? 'continue: blocked by native Stop hook'
      agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: CONTEXT_SOURCE }))
    }
  })

  // --- SubagentStart may inject child context; SubagentStop only observes.
  // The child is resolved live and retained through its paired end. ---
  const subagentChildren = new Map<SubagentRunId, { inject(message: UserMessage): void }>()
  ctx.on('subagent/start', (info) => {
    const child = resolveAgent(ctx, info.id)
    if (child !== undefined) subagentChildren.set(info.runId, child)
    const specs = specsFor('SubagentStart')
    if (specs.length === 0) return
    const run = runSpecs(
      specs,
      { event: 'SubagentStart', subject: SUBAGENT_TYPE, signal: detached.signal, raw: { info, agent: child } },
      timeoutMs,
    )
      .then((outcome) => {
        logOutcome(ctx, outcome)
        const message = contextFrom(outcome)
        if (message !== undefined && child !== undefined) child.inject(message)
      })
      .catch((error: unknown) => {
        ctx.logger.warn(`native-hooks: SubagentStart hook failed: ${errorText(error)}`)
      })
    detached.track(run)
  })
  ctx.on('subagent/end', (info) => {
    const child = subagentChildren.get(info.runId)
    subagentChildren.delete(info.runId)
    const specs = specsFor('SubagentStop')
    if (specs.length === 0) return
    detached.track(
      runSpecs(
        specs,
        { event: 'SubagentStop', subject: SUBAGENT_TYPE, signal: detached.signal, raw: { info, agent: child } },
        timeoutMs,
      ).then((outcome) => logOutcome(ctx, outcome)).catch(() => {}),
    )
  })
}

/** Build one model-context message from a folded outcome, or undefined. */
function contextFrom(outcome: FoldedOutcome): ReturnType<typeof createUserMessage> | undefined {
  if (outcome.additionalContext.length === 0) return undefined
  const content: ContentBlock[] = outcome.additionalContext.map((text) => ({ type: 'text', text }))
  return createUserMessage({ content, source: CONTEXT_SOURCE })
}

/** Warn once per firing about fail-open hook errors. */
function logOutcome(ctx: Context, outcome: FoldedOutcome): void {
  for (const error of outcome.errors) ctx.logger.warn(`native-hooks: ${error}`)
}

/** Flatten content blocks to text (the PostToolUse `toolResponse` view). */
function textOfBlocks(blocks: readonly ContentBlock[] | undefined): string | undefined {
  if (blocks === undefined) return undefined
  const text = blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return text.length > 0 ? text : undefined
}

/** The live subagent's Agent handle, opportunistically (may be absent). */
function resolveAgent(ctx: Context, id: unknown): { inject(message: UserMessage): void } | undefined {
  const agents = (ctx as { get(key: string): unknown }).get('agents') as
    | { get(id: unknown): unknown }
    | undefined
  const child = agents?.get(id)
  return isInjectable(child) ? child : undefined
}

function isInjectable(value: unknown): value is { inject(message: UserMessage): void } {
  return typeof value === 'object' && value !== null && typeof (value as { inject?: unknown }).inject === 'function'
}

/** Tracked detached runs: disposal aborts and drains before quiescence. */
interface DetachedRuns {
  signal: AbortSignal
  track<T>(run: Promise<T>): Promise<T>
  drain(): Promise<void>
}

function createDetachedRuns(): DetachedRuns {
  const controller = new AbortController()
  const pending = new Set<Promise<unknown>>()
  return {
    signal: controller.signal,
    track<T>(run: Promise<T>): Promise<T> {
      const tracked = run.finally(() => { pending.delete(tracked) })
      pending.add(tracked)
      return run
    },
    async drain(): Promise<void> {
      controller.abort()
      await Promise.allSettled([...pending])
    },
  }
}

export { NativeHooksService, validateSpec } from './service.ts'
export { skillMarkdown, SKILL_NAME } from './skill.ts'
export { parsePatchText, patchProblem } from './hooks/patch-guard.ts'
export { auditPackage } from './lib/release-audit.ts'
export type { AuditFinding, AuditOptions, AuditResult } from './lib/release-audit.ts'
export type { HookEvent, HookInput, HookResult, HookSpec } from './types.ts'
export type { FoldedOutcome } from './fold.ts'

// Re-export the built-in hook specs so authors can fork them as starting points.
export { cordisPatchGuard } from './hooks/patch-guard.ts'
export { releaseGate } from './hooks/release-gate.ts'
