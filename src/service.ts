/**
 * The `ctx.nativeHooks` service: the single registry every hook — built-in,
 * discovered, or registered by another plugin — flows through. Listeners the
 * core plugin mounted read `list()` at call time, so specs registered after
 * boot (another plugin's `apply`, a late discovery) still fire.
 * @module dsh-native-hooks/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { HOOK_EVENTS, isHookEvent, type HookSpec } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    nativeHooks: NativeHooksService
  }
}

export class NativeHooksService extends Service {
  private readonly specs = new Map<string, HookSpec>()

  constructor(ctx: Context) {
    super(ctx, 'nativeHooks')
  }

  /**
   * Register one hook spec; returns the unregister function. Re-registering
   * an existing id replaces the previous spec (warns once per replacement).
   * Throws synchronously on a malformed spec so the authoring plugin fails
   * loud instead of silently never firing.
   */
  register(spec: HookSpec): () => void {
    const problem = validateSpec(spec)
    if (problem !== null) throw new TypeError(`nativeHooks.register: ${problem}`)
    if (this.specs.has(spec.id)) {
      this.ctx?.logger?.warn?.(`native-hooks: hook "${spec.id}" re-registered — replacing the previous spec`)
    }
    this.specs.set(spec.id, spec)
    return () => {
      if (this.specs.get(spec.id) === spec) this.specs.delete(spec.id)
    }
  }

  /** Registration order snapshot; listeners fold over this. */
  list(): readonly HookSpec[] {
    return [...this.specs.values()]
  }

  has(id: string): boolean {
    return this.specs.has(id)
  }
}

/** Public validation shared with the module discovery path. */
export function validateSpec(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'spec must be an object'
  const spec = value as Partial<HookSpec>
  if (typeof spec.id !== 'string' || spec.id.length === 0) return 'spec.id must be a non-empty string'
  if (!isHookEvent(spec.event)) {
    return `spec.event must be one of ${HOOK_EVENTS.join(' | ')} (got ${String(spec.event)})`
  }
  if (typeof spec.handle !== 'function') return 'spec.handle must be a function'
  if (spec.matcher !== undefined && !(spec.matcher instanceof RegExp)) {
    return 'spec.matcher must be a RegExp when present'
  }
  return null
}
