# opencode-autocontinue

OpenCode V2 插件：自动续跑「总任务未完成就被中断」的会话。模型报错、阶段空闲、网络抖动等非用户原因中断时，自动注入续跑消息，直到任务完成或触发停止条件。

## 效果示意

```text
/autocontinue on      → toast 标题 "Autocontinue" / 正文 "Watch enabled"，footer 出现 [AC ●]
/autocontinue status  → toast 标题 "Autocontinue" / 正文 "on watch · 0 injections"
/autocontinue off     → toast 标题 "Autocontinue" / 正文 "Watch disabled"，footer 指示消失，侧栏块隐藏

footer:  [AC ●] watching | [AC ✓] done | [AC ⏸] paused | [AC ⏹ N] stopped | [AC ⏹ N · watch timeout] stopped（带停止原因）
sidebar: ⏱ 3m 22s / 🔄 5 injections (2 this round) / 🎯 on watch
```

停止后 `status` 会多带一段原因：`stopped · 5 injections · watch timeout`。

## 关键特性

- **全非用户原因中断都处理**：模型报错（`bad_response_status_code` 等）、stage-complete 空闲、网络抖动、工具失败——不只两类
- **retry 钩子第一道防线**：命中 `errorPatterns` → 指数退避（2s→4s→… 封顶 60s），尽量在调用层恢复，不产生续跑消息
- **五道停止保障**：完成标记（`[任务完成]` 等）、注入上限 `maxConsecutive`（默认 20）、值守时段窗口（`startTime` ~ `endTime`）、墙钟上限 `watchTimeoutMs`（默认 24 小时）、验证轮次上限 `verifyMaxIterations`（默认 50）
- **排除项**：用户主动中止（`MessageAbortedError` 等）、标题含排除关键词（默认「测试」）、用户最近发过消息（默认宽限 15 秒）
- **默认续跑消息**：「继续执行。按既定计划推进；遇到问题先自查修复，勿中断整体任务。」（模板支持 `{time}` `{remaining}` 自定义）
- **每会话 `/autocontinue` 开关**：值守状态按会话持久化，随时查看状态
- **零侵入**：不值守的会话完全不受影响；只读事件 + 注入 prompt，不改会话、不删消息

## 工作机制

两类恢复路径，两层互补而非替代：

| 层 | 触发 | 动作 |
|---|---|---|
| retry 钩子 | 模型调用瞬时失败 | `retry: true` + 指数退避，调用层直接恢复 |
| 事件驱动注入 | `session.error` / `session.idle`（stage-complete） | 依次判定值守名单 / 排除项 / 时段窗口 / 节流 / 用户宽限期 / 非 busy，通过后注入续跑消息 |

判定链按上表顺序逐条过，任何一条不满足就不注入。注入优先走 `session.synthetic`（带来源标记），宿主不支持时回退 `session.prompt`。

注入带防重机制：单实例在途锁 + 双事件去重，绝不打断运行中的会话。

## 快速开始

前置：OpenCode ≥ V2，`opencode` CLI 已安装并已登录。

```sh
opencode plugin add github:dubuqiangu/opencode-autocontinue
```

装完**完整重启 opencode**（`opencode service restart` 或退出重开；`/reload` 不重载插件），再在会话内执行 `/autocontinue on`——footer 出现 `[AC ●]` 即已生效。

完整步骤（前置要求 / 验证清单 / 更新 / 卸载）见 [安装指南](docs/guides/install.md)。

## v0.5.3 起的行为变更

如果你从旧版本升级，以下默认值的改动会影响你的值守时长，升级前请看一眼：

- **墙钟上限有了默认值**（v0.5.2 引入）：`watchTimeoutMs` 默认由 `0`（无限）改为 `86400000`（24 小时）。想继续无限值守，显式写 `"watchTimeoutMs": 0`。
- **验证轮次上限有了默认值**（v0.5.2 引入）：`verifyMaxIterations` 默认由 `0`（无限）改为 `50`。同上，显式写 `0` 仍表示无限。
- **停止原因可观测**：停止时 footer 与 `status` 会显示原因短语。v0.5.2 引入 7 种，v0.5.3 增至 8 种（新增 `title excluded`）：`window closed` / `watch timeout` / `injection cap` / `verify limit` / `interrupted while idle` / `stopped by user` / `abort sentinel` / `title excluded`。
- **挫败感触发**（v0.5.2 引入，opt-in，默认关闭）：配置 `frustrationTriggers` 后，命中时把 `frustrationMessage` 提醒句追加到**下一次**注入末尾；`frustrationTriggers` 默认为空数组，等于关闭。

v0.5.3 起，墙钟预算**按轮次计量**：真实用户消息开启新一轮时，24 小时预算重新计算，不再从首次值守起一直累加。

完整版本变更见 [变更记录](docs/decisions/changelog.md)。

## 更新 / 卸载

```sh
opencode plugin update github:dubuqiangu/opencode-autocontinue   # 更新（建议在 ~ 下执行；plugin list 显示的 commit 可能落后 update 一拍，再执行一次 update/list 对齐）
opencode plugin remove github:dubuqiangu/opencode-autocontinue   # 卸载
```

> **更新后必须完整重启 TUI**（`/reload` 不会重载插件）。

## 功能一览

| 功能 | 入口 | 说明 |
|---|---|---|
| footer 状态指示 | 自动 | `[AC ●]` watching / `[AC ✓]` done / `[AC ⏸]` paused / `[AC ⏹ N]` stopped / `[AC ⏹ N · <原因>]` stopped（[docs/features/footer.md](docs/features/footer.md)） |
| 侧边栏 Watch 块 | 自动 | `⏱ 时长 / 🔄 N injections / 🎯 状态标签`，另附 `🚫 N rejections` / `🛠 N tool failures`（[docs/features/footer.md](docs/features/footer.md)） |
| slash 命令 | `/autocontinue on\|off\|status` | 每会话值守开关（[docs/features/commands.md](docs/features/commands.md)） |
| 自动续跑引擎 | 自动 | retry 第一道防线 + 事件驱动注入，含全部停止条件（[docs/features/engine.md](docs/features/engine.md)） |
| 配置系统 | 配置文件 | 全局 + 项目覆盖，deep merge，BOM 容错 JSONC（[docs/features/config.md](docs/features/config.md)） |

## 文档

完整文档在 [docs/](docs/) 下分类组织，[docs/README.md](docs/README.md) 是总入口：

- **使用**：[安装指南](docs/guides/install.md)、[命令](docs/features/commands.md)、[footer 指示](docs/features/footer.md)、[引擎](docs/features/engine.md)、[配置](docs/features/config.md)
- **设计意图**：[DESIGN.md](DESIGN.md)（为什么这么设计，与当前实现如何对应）
- **架构**：[架构总览](docs/architecture/overview.md)、[事件与状态](docs/architecture/events-and-state.md)、[模块布局](docs/architecture/module-layout.md)、[决策与裁定索引](docs/architecture/provenance-and-loop.md)、[现行机制规格](docs/architecture/loop-mechanisms.md)、[取证与历史轮次](docs/architecture/loop-evidence.md)、[运行时经验](docs/architecture/runtime-lessons.md)
- **决策**：[已知问题](docs/decisions/known-issues.md)、[路线图](docs/decisions/roadmap.md)、[变更记录](docs/decisions/changelog.md)、[任务清单](tasks.md)

## 配置

全局配置：`~/.config/opencode/opencode-autocontinue.jsonc`；项目 `.opencode/opencode-autocontinue.jsonc` 内覆盖（deep merge，优先级更高）。BOM 容错 JSONC 解析（支持注释/尾逗号/单引号字符串），坏文件回退默认值。

常用键：`enabled`（总开关）、`message`（续跑消息模板）、`startTime` / `endTime`（值守时段，支持跨午夜窗口如 22:00→08:30）、`maxConsecutive`（注入上限，默认 20）、`watchTimeoutMs`（墙钟上限，默认 24 小时，写 `0` 为无限）、`verifyMaxIterations`（验证轮次上限，默认 50，写 `0` 为无限）、`completionMarkers`（完成标记，空数组=不检测）、`excludeTitleKeywords`、`userGraceMs`（默认 15000，即 15 秒）、`frustrationTriggers` / `frustrationMessage`（挫败感触发，默认关闭）。`OC_AUTOCONTINUE=0` 环境变量可整体禁用。

完整配置项见 [docs/features/config.md](docs/features/config.md)。

## 开发

- **server 侧源码由 OpenCode 运行时直接解析**，不需要构建；改动 `src/` 下的 server 模块直接生效。
- **TUI 侧必须构建**：`exports["./tui"]` 指向预构建的 `dist/tui.js`，改了 `src/tui.tsx` 不跑 `npm run build:tui` 就什么都不会生效。
- 语法快检：`node --experimental-strip-types --check src/<file>.ts`
- 单测：`npm test`（等价于 `node --experimental-strip-types --test "test/*.test.ts"`，覆盖全部 15 个测试文件、366 个用例，跑完自行退出，不需要 `--test-force-exit`）
- TUI 打包：`npm run build:tui`（esbuild，`src/tui.tsx` → `dist/tui.js`）

## 许可

MIT License
