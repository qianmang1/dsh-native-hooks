# dsh-native-hooks

DeepSeek Harness 的**原生（进程内）hooks 框架**：一个注册表插件挂载全部 7 条生命周期拦截点，hook 作者只需要写一个约定式导出的 JS 模块，或从另一个插件调用 `ctx.nativeHooks.register()`。功能对标官方的 `@deepseek-ai/dsh-hooks-claude-code` 桥接器，但钩子**不经 shell、不走 JSON-RPC**——同进程、类型化、零依赖。

> 适用 DSH `>=0.2.0-rc.1`（扩展点已对照 `dsh-v0.2.0-rc.2` 逐一核实）。

## 与 Claude Code 桥接器的事件对照

| Claude Code 事件 | 本框架事件 | harness 扩展点 | deny 语义 |
|---|---|---|---|
| `SessionStart` | `SessionStart` | `agent/created` | —（可注入上下文） |
| `UserPromptSubmit` | `UserPromptSubmit` | `agent/pre-step` | 拒绝本轮 step |
| `PreToolUse` | `PreToolUse` | `tools/pre-execute` | 拒绝工具调用（可 `ask` 走审批） |
| `PostToolUse` | `PostToolUse` | `tools/post-execute` | 把结果改写为模型可见的错误反馈 |
| `Stop` | `Stop` | `agent/turn-stopping` | `agent.steer()` 强制再跑一轮 |
| `SubagentStart` | `SubagentStart` | `subagent/start` | —（可向子 agent 注入上下文） |
| `SubagentStop` | `SubagentStop` | `subagent/end` | 仅观测 |

决策折叠与桥接器一致：deny 是终局（`deny > ask > allow`），同事件多 hook 按注册顺序串行，失败/超时的 hook **fail-open** 并记录告警。

## 接入新 hook 的三条路

### ① 目录投放（推荐，agent 友好）

把一个 `.mjs` 文件丢进 `~/.dsh/native-hooks/`（`$DSH_HOME` 下）即可，**不改任何 YAML**：

```js
// ~/.dsh/native-hooks/no-rm-rf.mjs
export default {
  id: 'no-rm-rf',
  event: 'PreToolUse',
  matcher: /^Bash$/,                       // 可选：按工具名过滤
  handle: async (input) => {
    const command = String(input.toolInput?.command ?? '')
    if (/rm\s+-rf\s+\//.test(command)) {
      return { decision: 'deny', reason: '拒绝递归删除根目录' }
    }
  },
}
```

目录由配置项 `dirs` 控制（默认 `[$DSH_HOME/native-hooks]`），可加多个。

### ② 声明式 modules

在 profile 里 native-hooks 条目的 `config.modules` 精确指定模块路径（支持绝对路径、`~/…`、`file:` URL、相对 `$DSH_HOME` 的路径）。

### ③ 插件 API（类型最完整）

```ts
export const name = 'my-hook'
export const inject = ['nativeHooks']
export function apply(ctx) {
  ctx.nativeHooks.register({ id: 'my-hook', event: 'PostToolUse', handle: async (input) => { /* … */ } })
}
```

重复 `id` 会替换旧 spec（带告警）；`register` 返回注销函数。畸形 spec 会同步抛错，作者插件加载即失败，不会静默失效。

### 让 agent 帮你写

插件经 `ctx.skills` 注册了 `native-hooks-development` skill——在 DSH 会话里直接说"帮我写一个拦截 XXX 的 hook"，agent 会按契约产出模块并投放到发现目录。

## HookSpec / HookResult 契约

```ts
interface HookSpec {
  id: string                    // 必填，全局唯一
  event: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse'
       | 'PostToolUse' | 'Stop' | 'SubagentStart' | 'SubagentStop'
  matcher?: RegExp              // 按事件 subject 过滤（工具事件=工具名；SessionStart=启动来源；其余忽略）
  handle: (input: HookInput) => HookResult | undefined | Promise<…>
}

interface HookInput {
  event; subject
  toolName?; toolInput?         // 工具事件：名字 + 参数对象
  toolResponse?                 // PostToolUse：文本化的结果
  turn?; signal                 // 轮次与中止信号（长循环请尊重 signal.aborted）
  raw: unknown                  // harness 原始载荷（ToolExecution 等，深度集成用）
}

interface HookResult {
  decision?: 'allow' | 'deny' | 'ask'
  reason?: string               // deny/ask 理由
  feedback?: string             // PostToolUse deny 的模型可见纠正反馈
  additionalContext?: string | string[]   // 注入模型上下文
}
```

返回 `undefined` 表示"无意见"。`ask` 仅 PreToolUse 有效（经审批 seam；审批服务缺失时自动降级为 deny）。

## 配置

```yaml
- id: native-hooks
  name: dsh-native-hooks
  config:
    dirs: []                    # 额外发现目录；默认已含 $DSH_HOME/native-hooks
    modules: []                 # 显式模块清单
    disabledHooks: []           # 关闭内置钩子（如 cordis-patch-guard）
    timeoutMs: 10000            # 单个 hook handle 的预算
```

## 内置钩子：cordis-patch-guard

对任何落在 `cordis.patch.yml` 上的 Edit/Write/MultiEdit，用**与启动完全相同的解析方言**（js-yaml `JSON_SCHEMA` + `!!js` tag、顶层数组、映射条目）立即重新解析；解析失败即把结果改写为模型可见的错误反馈（含行号与修复提示：Windows 路径要么不加引号，要么双引号内双反斜杠）。这把"写坏 patch 文件 → 下次插件更新 trial 才爆炸"的问题提前到了编辑当场。

已知限制：`\n`、`\P` 等**合法** YAML 转义不会抛错，但会把双引号里的 Windows 路径静默破坏成带换行的值——这类"能启动但值坏了"的场景不在 v1 拦截范围，请按提示的两种写法书写路径。

## 挂载

```bash
# profile package.json
"dsh-native-hooks": "github:qianmang1/dsh-native-hooks#v0.1.0"
# 并加入 dsh.profile.bundles 列表（其 dsh.bundle.patch 会自动插入加载行）
```

桌面端也可在「设置 → 插件」里安装。预构建的 `lib/index.js` 已提交，安装时无需构建脚本。

## 已知取舍

- `SessionStart`/`SubagentStart` 的 `turn` 未填充（桥接器经 sessionProjections 提供）。
- 桥接器会写 `hook/invoked`/`hook/result` 会话事件；本框架 v1 以 `ctx.logger` 记录。
- 超时的进程内 hook 无法被杀死，只能放弃其结果（fail-open）。
- hook 模块在 harness 主进程内执行——只投放你信任的文件。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsdown → lib/index.js（提交）
npm test            # node --test（37 个用例）
```

English: see [README_EN.md](README_EN.md). License: MIT.
