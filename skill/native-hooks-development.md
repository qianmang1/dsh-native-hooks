---
name: native-hooks-development
description: 为 dsh-native-hooks 框架编写一个新的进程内 agent 钩子（HookSpec 模块）。当用户要求"加一个 hook / 拦截某个工具 / 在会话开始时注入上下文"时使用。
whenToUse: 用户想新增一个 agent 钩子（工具拦截、上下文注入、危险命令防护等），且安装了 dsh-native-hooks 插件。
---

# 为 dsh-native-hooks 编写新钩子

一个钩子 = 一个默认导出 HookSpec 的 `*.mjs` 文件。三种接入方式里，优先用**目录投放**：把文件放进
`~/.dsh/native-hooks/`（$DSH_HOME 下），不改任何 YAML。

## HookSpec 契约

```js
// ~/.dsh/native-hooks/no-rm-rf.mjs
export default {
  id: 'no-rm-rf',            // 必填，全局唯一；重注册会替换旧 spec
  event: 'PreToolUse',       // SessionStart | UserPromptSubmit | PreToolUse | PostToolUse | Stop | SubagentStart | SubagentStop
  matcher: /^Bash$/,         // 可选：按事件 subject 过滤（工具事件=工具名；SessionStart=启动来源；其余忽略）
  handle: async (input) => { // 返回 HookResult 或 undefined（= 无意见，放行）
    const command = String(input.toolInput?.command ?? '')
    if (/rm\s+-rf\s+\//.test(command)) {
      return { decision: 'deny', reason: '拒绝执行递归删除根目录的命令' }
    }
  },
}
```

## input 字段

- `event` / `subject`：事件名与匹配主语
- `toolName` / `toolInput`：工具事件的名字与参数对象（如 `{ file_path, old_string }`）
- `toolResponse`：PostToolUse 的文本化结果
- `turn` / `signal`：轮次与中止信号（长循环里要尊重 `signal.aborted`）
- `raw`：harness 原始载荷（深度集成用；PreToolUse 是 ToolExecution）

## 返回值 HookResult

- `{ decision: 'deny', reason }`：PreToolUse 拒绝调用；PostToolUse 把结果变成模型可见的错误反馈（可加 `feedback`）；UserPromptSubmit 拒绝本轮；Stop 强制再跑一轮
- `{ decision: 'ask', reason }`：仅 PreToolUse 有效，走审批
- `{ additionalContext }`：注入模型上下文（SessionStart / UserPromptSubmit / PostToolUse / SubagentStart）
- 返回 `undefined`：无意见

## 自检清单

1. `id` 唯一且稳定；2. `event` 拼写正确；3. `matcher` 不要用 `g` 标志；4. `handle` 快速返回（超过 timeoutMs 会被放弃并告警，fail-open）；
5. 决策语义：deny 是终局，后注册的钩子不能升级它；6. 写完放到 `~/.dsh/native-hooks/<id>.mjs`，重启（或触发了 hmr 的配置变更）后看 dsh 日志确认没有加载报错；
7. 编辑任何 `cordis.patch.yml` 后跑一次市场诊断页——内置的 cordis-patch-guard 钩子也会在每次 Edit/Write 后自动校验。
