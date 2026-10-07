# dsh-native-hooks

A **native (in-process) hooks framework** for DeepSeek Harness: one registry plugin mounts all seven lifecycle interception points, and hook authors only write a conventionally-exported JS module — or call `ctx.nativeHooks.register()` from another plugin. Functionally on par with the official `@deepseek-ai/dsh-hooks-claude-code` bridge, but hooks run **in-process, typed, and shell-free** with zero runtime dependencies.

> Targets DSH `>=0.2.0-rc.1` (extension points verified against tag `dsh-v0.2.0-rc.2`).

## Event mapping vs the Claude Code bridge

| Claude Code event | This framework | Harness extension point | Deny semantics |
|---|---|---|---|
| `SessionStart` | `SessionStart` | `agent/created` | — (context injection) |
| `UserPromptSubmit` | `UserPromptSubmit` | `agent/pre-step` | rejects the step |
| `PreToolUse` | `PreToolUse` | `tools/pre-execute` | denies the call (`ask` rides approval) |
| `PostToolUse` | `PostToolUse` | `tools/post-execute` | rewrites the result into model-visible feedback |
| `Stop` | `Stop` | `agent/turn-stopping` | `agent.steer()` forces one more turn |
| `SubagentStart` | `SubagentStart` | `subagent/start` | — (context to the child) |
| `SubagentStop` | `SubagentStop` | `subagent/end` | observe-only |

Folding matches the bridge: deny is terminal (`deny > ask > allow`), hooks run serially in registration order, and a failing/timed-out hook is fail-open with a warning.

## Three ways to add a hook

### ① Drop a file (recommended, agent-friendly)

Drop a `.mjs` file into `~/.dsh/native-hooks/` (under `$DSH_HOME`) — no YAML edits, no restart: the plugin watches that dir:

```js
// ~/.dsh/native-hooks/no-rm-rf.mjs
export default {
  id: 'no-rm-rf',
  event: 'PreToolUse',
  matcher: /^Bash$/,
  handle: async (input) => {
    const command = String(input.toolInput?.command ?? '')
    if (/rm\s+-rf\s+\//.test(command)) {
      return { decision: 'deny', reason: 'refusing recursive root deletion' }
    }
  },
}
```

Discovery dirs are the drop-in dir `$DSH_HOME/native-hooks` (config `dropInDir`, default `true`; `false` disables it) followed by the extra dirs listed in `dirs`. An empty `dirs` is NOT how you disable discovery: schemastery fills an unset array with `[]`, so `dropInDir: false` is the only way to say it.

Adds, edits, and deletes fold into the registry **immediately** — editing a file re-imports it and replaces its spec, deleting it unregisters. Commenting a whole file out means "intentionally disabled" and is skipped silently. `watchEnabled: false` restores scan-once-at-startup; `watchDebounceMs` (default 150) tunes the coalescing window.

### ② Declarative `modules`

List exact module paths in the profile's `config.modules` (absolute, `~/…`, `file:` URLs, or relative to `$DSH_HOME`).

### ③ Plugin API (fully typed)

```ts
export const name = 'my-hook'
export const inject = ['nativeHooks']
export function apply(ctx) {
  ctx.nativeHooks.register({ id: 'my-hook', event: 'PostToolUse', handle: async (input) => { /* … */ } })
}
```

Re-registering an `id` replaces the previous spec (warned); `register` returns an unregister function; malformed specs throw synchronously.

### Let an agent write it

The plugin publishes a `native-hooks-development` skill through `ctx.skills` — in a DSH session, just ask "write me a hook that intercepts X" and the agent produces a conforming module into the discovery dir.

## Contract

```ts
interface HookSpec {
  id: string
  event: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse'
       | 'PostToolUse' | 'Stop' | 'SubagentStart' | 'SubagentStop'
  matcher?: RegExp
  handle: (input: HookInput) => HookResult | undefined | Promise<…>
}

interface HookInput {
  event; subject
  toolName?; toolInput?
  toolResponse?
  turn?; signal
  raw: unknown        // the typed harness payload (ToolExecution, …)
}

interface HookResult {
  decision?: 'allow' | 'deny' | 'ask'
  reason?: string
  feedback?: string   // PostToolUse deny feedback (model-visible)
  additionalContext?: string | string[]
}
```

Returning `undefined` means "no opinion". `ask` applies to PreToolUse only (via the approval seam; degrades to deny when absent).

## Built-in hooks

- **cordis-patch-guard**: ANY file-tool call landing on a `cordis.patch.yml` (tool-name agnostic: DSH `edit`/`write`/`str_replace_editor`, Claude Code `Edit`/`Write`, … — anything whose arguments carry a path to the file) is re-parsed immediately with the **exact dialect the boot uses** (js-yaml `JSON_SCHEMA` + the `!!js` tag, top-level array, mapping entries). A parse failure denies the result with an actionable message (line numbers plus the fix: Windows paths either unquoted or double-backslash inside double quotes). Reads are never blocked — the diagnostic rides along as non-blocking context so the agent can still see and repair the file. This moves "broken patch file → explodes at the next market trial boot" to edit time.
- **release-gate**: intercepts `git tag` (creation) inside a dsh plugin package and audits first (L1 patch parse + L2 package.json dsh-metadata audit + artifact smoke load; `--profile` adds the L3 composition check). Error-level findings deny the tag with the full report — the forced "diagnose after dev, before tag" step. CLI equivalent: `npm run release-check` (`scripts/release-check.mjs` is copy-paste reusable in other plugin repos). The gate keys on errors only; composition warnings (including the host-provided unknown-orphans class) never block a release.

Known limitation: **valid** YAML escapes such as `\n` or `\P` do not throw, but silently corrupt double-quoted Windows paths (they become newline/separator characters). That "boots but the value is broken" class is out of scope for v1 — write paths unquoted or with double backslashes.

## Mounting

```bash
# profile package.json
"dsh-native-hooks": "github:qianmang1/dsh-native-hooks#v0.3.0"
# then append to dsh.profile.bundles (the dsh.bundle.patch inserts the loader row)
```

`lib/` is not committed: git installs build it via `prepack` (tsdown); use `npm run build` in-tree.

## Trade-offs

- `turn` is not populated for `SessionStart`/`SubagentStart` (the bridge uses sessionProjections).
- The bridge appends `hook/invoked`/`hook/result` session events; v1 logs via `ctx.logger`.
- A timed-out in-process hook cannot be killed — its result is abandoned (fail-open).
- Hook modules execute inside the harness main process — only drop files you trust.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test        # 55 cases
```

中文文档：[README.md](README.md)。License: MIT.
