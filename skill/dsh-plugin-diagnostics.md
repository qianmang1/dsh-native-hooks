---
name: dsh-plugin-diagnostics
description: 验证或诊断开发中的 dsh 插件/bundle/工具是否符合官方开发需求——审计 package.json 的 dsh 元数据、校验 cordis.patch.yml / cordis.yml 能否被启动解析、跑 profile 组合体检（analyzeProfile）、冒烟加载构建产物，或判定一个发现是否属于 boot-breaking。安装或市场 trial 之前使用。
whenToUse: 插件/bundle 开发的发布前预检；安装失败或 trial 回滚后的归因；怀疑某个配置文件写坏时。
---

# dsh-plugin-diagnostics

发布前的预检纪律：**先诊断，再安装**。一个插件在通过 L1–L3 之前不要进 `dsh plugin` 安装或市场更新——市场的 trial 会拦，但每次失败都浪费一轮。

三层诊断，逐层做。命令里的锚点路径按目标 profile 调整（下文以 desktop 为例）。

## L1 · 单文件解析（boot-parity）

任何 `cordis.patch.yml` / `cordis.yml` 被改过之后，先验证它能被启动解析器接受（一条命令）：

```bash
node -e "import('file:///C:/Users/Y/.dsh/profiles/desktop/node_modules/dshmarket/lib/check.js').then(m => { const r = m.parsePatchFile(process.argv[1]); console.log(r ? 'OK: ' + r.length + ' entries' : 'INVALID: not a valid entry list'); })" <目标文件>
```

无 dshmarket 的 profile 用本插件导出的 `patchProblem`（读文件→传文本，返回字符串=问题，null=通过）。判定：`INVALID` 是 **error**（boot 会炸），必须修。Windows 路径两种合法写法：不加引号，或双引号内双反斜杠；`\n`/`\P` 等是合法转义但会静默破坏路径，禁止用于路径。

## L2 · 单包预检（官方开发需求清单）

对**正在开发的插件目录**逐项核对。判据来自官方宿主（check.ts 的 boot-blocking 判定）与已发布插件（dsh-tool-dua-storage 模式）：

**package.json（error 级）**
- `type: "module"`；`main` / `exports["."]"` 指向的文件**在磁盘上存在**（提交预构建 `lib/index.js`，git 安装才能免构建）
- bundle 包声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，且该文件存在并能过 L1——宿主原话："bundle declares no dsh.bundle.patch — the profile will fail to boot"
- `@deepseek-ai/*` 一律 `peerDependencies: "*"`，**绝不**放进 dependencies（宿主运行时提供）
- `engines` 或 `dsh.engines.dsh` 标明宿主版本下界（当前宿主 0.2.0-rc.2）

**仓库规范（warning 级）**
- `files` 含 `lib`、`cordis.patch.yml`、`README.md`、`LICENSE`；`src` 随包发布便于审查
- LICENSE（MIT）、README、`repository.url` 指向真实仓库
- `npm test` / `npm run typecheck` 定义且通过；测试不依赖网络与真实宿主

**冒烟加载（error 级）**

```bash
node -e "import('file:///<插件目录>/lib/index.js').then(m => console.log('loaded:', m.name ?? Object.keys(m).length + ' exports')).catch(e => { console.error('LOAD FAIL:', e.message); process.exit(1) })"
```

区分两类失败：`Cannot find package '@deepseek-ai/…'` 是**脱离宿主环境**的正常现象（peer 由宿主提供），不算包坏；语法错误、顶层崩溃、缺少 `apply` 导出才是包坏。

## L3 · profile 组合体检（与启动同源，一条命令）

```bash
node -e "import('file:///C:/Users/Y/.dsh/profiles/desktop/node_modules/dshmarket/lib/check.js').then(m => console.log(JSON.stringify(m.analyzeProfile('C:/Users/Y/.dsh/profiles/desktop'), null, 2)))"
```

报告字段处置表：

| 字段 | 含义 | 处置 |
|---|---|---|
| `summary.ok / errors / warnings` | 总判定 | errors 必须清零再安装 |
| `duplicates` | 重复 loader 条目 id | boot 会炸；合并或禁用一行 |
| `orphans` | 补丁指向不存在的行 | 删该补丁行，或补上目标 |
| `bundles[].error / parseError` | 包缺失 / 声明的补丁缺失或非法 | 回 L1/L2 修包 |
| `peerMismatches` / `multiVersion` | peer 不满足 / 同包多版本 | 对齐版本 |
| `orderConflicts` + `suggestedOrder` | before/after 规则冲突；LOOT 式建议顺序 | 冲突时采纳建议顺序或手动调停 |
| `residuals` | 中断安装的残留目录 | 清理前与用户确认 |

## 边界与配合

- desktop profile **不能用** `dsh --dump-config`（CLI 拒绝保留 profile）；L3 是它在命令行的等价物。
- 官方 `@deepseek-ai` 包在 Electron 归档内，报告里相关项为 unknown/unresolved——不是错误，不要"修"它。
- 诊断只回答"组合能否启动 + 是否符合规范"；运行期行为要在真实会话里验证。
- 路由：**修组合/写预设** → editing-cordis-compositions；**发布安装/接 MCP** → cordis-plugin-development；**生成新插件** → dsh-hermes-plugin；本技能只负责"验证"。
- 市场诊断页（/dsh-market/check）与本技能 L3 同源，可交叉确认；更新时的自动 trial 是同一机制的强制版。
