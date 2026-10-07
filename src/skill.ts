/**
 * Publishes the `native-hooks-development` skill through `ctx.skills` so any
 * DSH agent session can author a new hook on request: the skill carries the
 * HookSpec contract, a copy-paste module template, and a self-check list.
 * Registration is opportunistic — a host without the skills service just gets
 * the README (the same content ships as `skill/native-hooks-development.md`).
 *
 * The provider surface mirrors `@deepseek-ai/dsh-skill`'s validation exactly:
 * candidates need a finite `rank`, a `provider` field equal to the registered
 * provider name, string `source`; `get()` must return the full definition
 * (`content` included).
 * @module dsh-native-hooks/skill
 */

import type { SkillServiceSurface } from './types.ts'

export const SKILL_NAME = 'native-hooks-development'
export const SKILL_PROVIDER = 'native-hooks'
/** Lower ranks win duplicate names; sitting above the runtime layer (250)
 * lets a user's own same-name skill shadow this helper. */
export const SKILL_RANK = 400

const SKILL_BODY = `---
name: native-hooks-development
description: 为 dsh-native-hooks 框架编写一个新的进程内 agent 钩子（HookSpec 模块）。当用户要求"加一个 hook / 拦截某个工具 / 在会话开始时注入上下文"时使用。
whenToUse: 用户想新增一个 agent 钩子（工具拦截、上下文注入、危险命令防护等），且安装了 dsh-native-hooks 插件。
---

# 为 dsh-native-hooks 编写新钩子

一个钩子 = 一个默认导出 HookSpec 的 \`*.mjs\` 文件。三种接入方式里，优先用**目录投放**：把文件放进
\`~/.dsh/native-hooks/\`（\$DSH_HOME 下），不改任何 YAML。

## HookSpec 契约

\`\`\`js
// ~/.dsh/native-hooks/no-rm-rf.mjs
export default {
  id: 'no-rm-rf',            // 必填，全局唯一；重注册会替换旧 spec
  event: 'PreToolUse',       // SessionStart | UserPromptSubmit | PreToolUse | PostToolUse | Stop | SubagentStart | SubagentStop
  matcher: /^Bash$/,         // 可选：按事件 subject 过滤（工具事件=工具名；SessionStart=启动来源；其余忽略）
  handle: async (input) => { // 返回 HookResult 或 undefined（= 无意见，放行）
    const command = String(input.toolInput?.command ?? '')
    if (/rm\\s+-rf\\s+\\//.test(command)) {
      return { decision: 'deny', reason: '拒绝执行递归删除根目录的命令' }
    }
  },
}
\`\`\`

## input 字段

- \`event\` / \`subject\`：事件名与匹配主语
- \`toolName\` / \`toolInput\`：工具事件的名字与参数对象（如 \`{ file_path, old_string }\`）
- \`toolResponse\`：PostToolUse 的文本化结果
- \`turn\` / \`signal\`：轮次与中止信号（长循环里要尊重 \`signal.aborted\`）
- \`raw\`：harness 原始载荷（深度集成用；PreToolUse 是 ToolExecution）

## 返回值 HookResult

- \`{ decision: 'deny', reason }\`：PreToolUse 拒绝调用；PostToolUse 把结果变成模型可见的错误反馈（可加 \`feedback\`）；UserPromptSubmit 拒绝本轮；Stop 强制再跑一轮
- \`{ decision: 'ask', reason }\`：仅 PreToolUse 有效，走审批
- \`{ additionalContext }\`：注入模型上下文（SessionStart / UserPromptSubmit / PostToolUse / SubagentStart）
- 返回 \`undefined\`：无意见

## 自检清单

1. \`id\` 唯一且稳定；2. \`event\` 拼写正确；3. \`matcher\` 不要用 \`g\` 标志；4. \`handle\` 快速返回（超过 timeoutMs 会被放弃并告警，fail-open）；
5. 决策语义：deny 是终局，后注册的钩子不能升级它；6. 写完放到 \`~/.dsh/native-hooks/<id>.mjs\`，重启（或触发了 hmr 的配置变更）后看 dsh 日志确认没有加载报错；
7. 编辑任何 \`cordis.patch.yml\` 后跑一次市场诊断页——内置的 cordis-patch-guard 钩子也会在每次 Edit/Write 后自动校验。
`

const SKILL_SUMMARY_FIELDS = {
  name: SKILL_NAME,
  description: '为 dsh-native-hooks 编写新的进程内 agent 钩子（HookSpec 模块）：工具拦截、上下文注入、危险命令防护。',
  whenToUse: '用户要求新增 agent hook / 拦截工具调用 / 会话启动注入上下文，且环境装有 dsh-native-hooks。',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'custom' as const,
  provider: SKILL_PROVIDER,
  rank: SKILL_RANK,
}

/** Register the authoring skill when the host exposes a skills service. */
export function registerSkill(ctx: {
  get?(key: string): unknown
  logger?: { warn?(message: string): unknown }
}, source: string): void {
  // Opportunistic access (ctx.get) — a host without the skills service simply
  // skips the skill; declaring `inject: ['skills']` would make the whole
  // registry fail to mount there.
  const skills = ctx.get?.('skills') as SkillServiceSurface | undefined
  if (typeof skills?.registerProvider !== 'function') return
  try {
    skills.registerProvider(() => ({
      name: SKILL_PROVIDER,
      async list() {
        return [{ ...SKILL_SUMMARY_FIELDS, source: `custom#${source}` }]
      },
      async get(candidate: { name: string }) {
        if (candidate?.name !== SKILL_NAME) return undefined
        return { ...SKILL_SUMMARY_FIELDS, content: SKILL_BODY }
      },
    }))
  } catch (error) {
    ctx.logger?.warn?.(`native-hooks: skill registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The skill body, also written to `skill/native-hooks-development.md` at packaging time. */
export const skillMarkdown = SKILL_BODY
