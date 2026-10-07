/**
 * Skills published through `ctx.skills` by the plugin itself, so they follow
 * the plugin's install footprint: every session in a profile with
 * dsh-native-hooks mounted sees them, whatever preset it runs, and the
 * content updates with plugin releases (no preset-side copy to drift).
 *
 * The provider surface mirrors `@deepseek-ai/dsh-skill`'s validation exactly:
 * candidates need a finite `rank`, a `provider` field equal to the registered
 * provider name, string `source`; `get()` must return the full definition
 * (`content` included).
 * @module dsh-native-hooks/skill
 */

import type { SkillServiceSurface } from './types.ts'

export const SKILL_NAME = 'native-hooks-development'
export const SKILL_DIAGNOSTICS_NAME = 'dsh-plugin-diagnostics'
export const SKILL_PROVIDER = 'native-hooks'
/** Lower ranks win duplicate names; sitting above the runtime layer (250)
 * lets a user-authored same-name skill shadow these helpers. */
export const SKILL_RANK = 400

const NATIVE_HOOKS_BODY = `---
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
    if (/rm\\\\s+-rf\\\\s+\\\\//.test(command)) {
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
5. 决策语义：deny 是终局，后注册的钩子不能升级它；6. 写完放到 \`~/.dsh/native-hooks/<id>.mjs\`，重启（或触发了 hmr 的配置变更）后看 dsh 日志确认没有加载报错；**整个文件注释掉（无任何导出）= 有意停用，发现器静默跳过不报错**——示例模板就用这种方式闲置；
7. 编辑任何 \`cordis.patch.yml\` 后跑一次市场诊断页——内置的 cordis-patch-guard 钩子也会在每次文件工具调用后自动校验。
`

const DIAGNOSTICS_BODY = `---
name: dsh-plugin-diagnostics
description: 验证或诊断开发中的 dsh 插件/bundle/工具是否符合官方开发需求——审计 package.json 的 dsh 元数据、校验 cordis.patch.yml / cordis.yml 能否被启动解析、跑 profile 组合体检（analyzeProfile）、冒烟加载构建产物，或判定一个发现是否属于 boot-breaking。安装或市场 trial 之前使用。
whenToUse: 插件/bundle 开发的发布前预检；安装失败或 trial 回滚后的归因；怀疑某个配置文件写坏时。
---

# dsh-plugin-diagnostics

发布前的预检纪律：**先诊断，再安装**。一个插件在通过 L1–L3 之前不要进 \`dsh plugin\` 安装或市场更新——市场的 trial 会拦，但每次失败都浪费一轮。

三层诊断，逐层做。命令里的锚点路径按目标 profile 调整（下文以 desktop 为例）。

## L1 · 单文件解析（boot-parity）

任何 \`cordis.patch.yml\` / \`cordis.yml\` 被改过之后，先验证它能被启动解析器接受（一条命令）：

\`\`\`bash
node -e "import('file:///C:/Users/Y/.dsh/profiles/desktop/node_modules/dshmarket/lib/check.js').then(m => { const r = m.parsePatchFile(process.argv[1]); console.log(r ? 'OK: ' + r.length + ' entries' : 'INVALID: not a valid entry list'); })" <目标文件>
\`\`\`

无 dshmarket 的 profile 用本插件导出的 \`patchProblem\`（读文件→传文本，返回字符串=问题，null=通过）。判定：\`INVALID\` 是 **error**（boot 会炸），必须修。Windows 路径两种合法写法：不加引号，或双引号内双反斜杠；\`\\n\`/\`\\P\` 等是合法转义但会静默破坏路径，禁止用于路径。

## L2 · 单包预检（官方开发需求清单）

对**正在开发的插件目录**逐项核对。判据来自官方宿主（check.ts 的 boot-blocking 判定）与已发布插件（dsh-tool-dua-storage 模式）：

**package.json（error 级）**
- \`type: "module"\`；\`main\` / \`exports["."]"\` 指向的文件**在磁盘上存在**（提交预构建 \`lib/index.js\`，git 安装才能免构建）
- bundle 包声明 \`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }\`，且该文件存在并能过 L1——宿主原话："bundle declares no dsh.bundle.patch — the profile will fail to boot"
- \`@deepseek-ai/*\` 一律 \`peerDependencies: "*"\`，**绝不**放进 dependencies（宿主运行时提供）
- \`engines\` 或 \`dsh.engines.dsh\` 标明宿主版本下界（当前宿主 0.2.0-rc.2）

**仓库规范（warning 级）**
- \`files\` 含 \`lib\`、\`cordis.patch.yml\`、\`README.md\`、\`LICENSE\`；\`src\` 随包发布便于审查
- LICENSE（MIT）、README、\`repository.url\` 指向真实仓库
- \`npm test\` / \`npm run typecheck\` 定义且通过；测试不依赖网络与真实宿主

**冒烟加载（error 级）**

\`\`\`bash
node -e "import('file:///<插件目录>/lib/index.js').then(m => console.log('loaded:', m.name ?? Object.keys(m).length + ' exports')).catch(e => { console.error('LOAD FAIL:', e.message); process.exit(1) })"
\`\`\`

区分两类失败：\`Cannot find package '@deepseek-ai/…'\` 是**脱离宿主环境**的正常现象（peer 由宿主提供），不算包坏；语法错误、顶层崩溃、缺少 \`apply\` 导出才是包坏。

## L3 · profile 组合体检（与启动同源，一条命令）

\`\`\`bash
node -e "import('file:///C:/Users/Y/.dsh/profiles/desktop/node_modules/dshmarket/lib/check.js').then(m => console.log(JSON.stringify(m.analyzeProfile('C:/Users/Y/.dsh/profiles/desktop'), null, 2)))"
\`\`\`

报告字段处置表：

| 字段 | 含义 | 处置 |
|---|---|---|
| \`summary.ok / errors / warnings\` | 总判定 | errors 必须清零再安装 |
| \`duplicates\` | 重复 loader 条目 id | boot 会炸；合并或禁用一行 |
| \`orphans\` | 补丁指向不存在的行 | 删该补丁行，或补上目标 |
| \`bundles[].error / parseError\` | 包缺失 / 声明的补丁缺失或非法 | 回 L1/L2 修包 |
| \`peerMismatches\` / \`multiVersion\` | peer 不满足 / 同包多版本 | 对齐版本 |
| \`orderConflicts\` + \`suggestedOrder\` | before/after 规则冲突；LOOT 式建议顺序 | 冲突时采纳建议顺序或手动调停 |
| \`residuals\` | 中断安装的残留目录 | 清理前与用户确认 |

## L4 · 发布门禁（打 tag 前）

dsh-native-hooks 内置 \`release-gate\` 钩子：PreToolUse 拦截 dsh 包目录里的 \`git tag\`（创建），先自动跑 L1+L2（dshmarket 可达时含 L3），失败即拒绝并给出完整报告。也可以在仓库里显式执行 \`npm run release-check\`（把 scripts/release-check.mjs 复制到其他插件仓库即可复用，\`--profile <dir>\` 追加 L3）。门禁只拦 error；warning（含组合体检的 unknown 类 orphan）不阻塞发版。

## 边界与配合

- desktop profile **不能用** \`dsh --dump-config\`（CLI 拒绝保留 profile）；L3 是它在命令行的等价物。
- 官方 \`@deepseek-ai\` 包在 Electron 归档内，报告里相关项为 unknown/unresolved——不是错误，不要"修"它。
- 诊断只回答"组合能否启动 + 是否符合规范"；运行期行为要在真实会话里验证。
- 路由：**修组合/写预设** → editing-cordis-compositions；**发布安装/接 MCP** → cordis-plugin-development；**生成新插件** → dsh-hermes-plugin；本技能只负责"验证"。
- 市场诊断页（/dsh-market/check）与本技能 L3 同源，可交叉确认；更新时的自动 trial 是同一机制的强制版。
`

interface PublishedSkill {
  summary: {
    name: string
    description: string
    whenToUse?: string
    invocation: { modelInvocable: boolean; userInvocable: boolean }
    source: string
    provider: string
    rank: number
  }
  content: string
}

const PUBLISHED: PublishedSkill[] = [
  {
    summary: {
      name: SKILL_NAME,
      description: '为 dsh-native-hooks 编写新的进程内 agent 钩子（HookSpec 模块）：工具拦截、上下文注入、危险命令防护。',
      whenToUse: '用户要求新增 agent hook / 拦截工具调用 / 会话启动注入上下文，且环境装有 dsh-native-hooks。',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'custom',
      provider: SKILL_PROVIDER,
      rank: SKILL_RANK,
    },
    content: NATIVE_HOOKS_BODY,
  },
  {
    summary: {
      name: SKILL_DIAGNOSTICS_NAME,
      description: '验证或诊断开发中的 dsh 插件/bundle/工具是否符合官方开发需求：package.json 审计、entry-list 解析、profile 组合体检、冒烟加载。安装或市场 trial 之前使用。',
      whenToUse: '插件/bundle 发布前预检；安装失败或 trial 回滚后的归因；怀疑配置文件写坏。',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'custom',
      provider: SKILL_PROVIDER,
      rank: SKILL_RANK,
    },
    content: DIAGNOSTICS_BODY,
  },
]

/** Register both skills when the host exposes a skills service. */
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
        return PUBLISHED.map(({ summary }) => ({ ...summary, source: `${summary.source}#${source}` }))
      },
      async get(candidate: { name: string }) {
        const skill = PUBLISHED.find(({ summary }) => summary.name === candidate?.name)
        return skill === undefined ? undefined : { ...skill.summary, content: skill.content }
      },
    }))
  } catch (error) {
    ctx.logger?.warn?.(`native-hooks: skill registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Skill bodies, also written to `skill/` at packaging time (single source of truth). */
export const skillMarkdown = NATIVE_HOOKS_BODY
export const diagnosticsSkillMarkdown = DIAGNOSTICS_BODY
