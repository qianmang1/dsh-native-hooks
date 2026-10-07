/**
 * Hook contract shared by every authoring path (built-in hooks, dropped
 * `~/.dsh/native-hooks/*.mjs` modules, config-declared modules, and
 * `ctx.nativeHooks.register()` callers).
 *
 * The shape deliberately mirrors the Claude Code hook dialect — same seven
 * events, same matcher-by-tool-name idea, same allow/deny/ask decisions — so
 * knowledge and modules port, while `raw` keeps the full typed harness payload
 * available for deep integrations.
 * @module dsh-native-hooks/types
 */

/** All lifecycle points a hook can attach to (Claude Code dialect names). */
export type HookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'

export const HOOK_EVENTS: readonly HookEvent[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
]

export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value)
}

/**
 * Normalized input handed to every matching hook. `subject` is the event's
 * matcher subject (tool name for tool events, session source for
 * SessionStart, `''` for events that ignore matchers); `raw` carries the
 * harness payload the point received.
 */
export interface HookInput {
  event: HookEvent
  subject: string
  toolName?: string
  toolInput?: unknown
  /** Text-flattened tool result content (PostToolUse only). */
  toolResponse?: string
  turn?: number
  signal: AbortSignal
  raw: unknown
}

/**
 * What a hook returns. `undefined`/void means "no opinion" (the hook ran for
 * side effects only). Deny is terminal per event: PreToolUse denies the call,
 * PostToolUse turns the result into model-visible feedback, UserPromptSubmit
 * rejects the step, Stop steers one more turn.
 */
export interface HookResult {
  decision?: 'allow' | 'deny' | 'ask'
  /** Why the decision was made; surfaces as deny reason / ask reason. */
  reason?: string
  /** Model-visible corrective text for a PostToolUse deny. */
  feedback?: string
  /** Model context to inject (SessionStart, UserPromptSubmit, PostToolUse, SubagentStart). */
  additionalContext?: string | string[]
}

/**
 * One registrable hook. A dropped module's default export (or named `hook`
 * export) must satisfy this interface; plugin authors get the same type from
 * `ctx.nativeHooks.register`.
 */
export interface HookSpec {
  /** Unique id within the registry; re-registering an id replaces the spec. */
  id: string
  event: HookEvent
  /** Optional case-sensitive filter on the event's matcher subject. */
  matcher?: RegExp
  handle: (input: HookInput) => HookResult | undefined | void | Promise<HookResult | undefined | void>
  /** Provenance label for logs (`builtin:cordis-patch-guard`, a file path, a plugin name). */
  source?: string
}

/** Structural surface of `ctx.skills` used to publish the authoring skill.
 * Field requirements mirror `@deepseek-ai/dsh-skill`'s `validateCandidate` /
 * `validateDefinition`: candidates carry a finite `rank` and a `provider`
 * equal to the registered provider name; `get()` returns the full definition. */
export interface SkillSummaryEntry {
  name: string
  description: string
  whenToUse?: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  source: string
  provider: string
  rank: number
}

export interface SkillServiceSurface {
  registerProvider(create: (control: {
    signal: { aborted: boolean; addEventListener(type: string, fn: () => void, opts?: unknown): void }
    invalidate(): void
  }) => {
    name: string
    list(options?: unknown): Promise<SkillSummaryEntry[] | { candidates: unknown[]; complete: boolean }>
    get(candidate: { name: string }, options?: unknown): Promise<(SkillSummaryEntry & { content: string }) | undefined>
  }): unknown
}
