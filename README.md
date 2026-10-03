# opencode-autocontinue

OpenCode V2 插件：自动续跑「总任务未完成就被中断」的会话。模型报错、阶段空闲、网络抖动等非用户原因中断时，自动注入续跑消息，直到任务完成或触发停止条件。

## 效果示意

```text
/autocontinue on      → toast「值守已开启」 + footer [AC ●] + 侧边栏「值守 ⏱ …」
/autocontinue status  → 值守中 · watching · 已续跑 0 次
/autocontinue off     → footer 指示消失、侧边栏块隐藏

footer:  [AC ●] 值守中 | [AC ✓] 完成 | [AC ⏸ N] 停止(已续跑 N 次)
侧边栏:  值守 ─ ⏱ 3m 22s / 🔁 5 次续跑 / 🎯 watching
```

## 关键特性

- **全非用户原因中断都处理**：模型报错（`bad_response_status_code` 等）、stage-complete 空闲、网络抖动、工具失败——不只两类
- **retry 钩子第一道防线**：命中 `errorPatterns` → 指数退避（2s→4s→… 封顶 60s），尽量在调用层恢复，不产生续跑消息
- **三重停止保障**：完成标记（`[任务完成]` 等）、最大连续续跑上限（默认 20）、值守时段窗口（`startTime` ~ `endTime`）
- **排除项**：用户主动中止（`MessageAbortedError` 等）、标题含排除关键词（默认「测试」）、用户最近发过消息（默认宽限 5 分钟）
- **自定义续跑消息**：模板支持 `{time}` `{remaining}`，默认「继续执行。审视已完成的功能是否存在bug，未实现的功能是否有安排好的执行计划」
- **每会话 `/autocontinue` 开关**：值守状态按会话持久化，随时查看状态
- **零侵入**：不值守的会话完全不受影响；只读事件 + 注入 prompt，不改会话、不删消息

## 工作机制

两类恢复路径，两层互补而非替代：

| 层 | 触发 | 动作 |
|---|---|---|
| retry 钩子 | 模型调用瞬时失败 | `retry: true` + 指数退避，调用层直接恢复 |
| 事件驱动注入 | `session.error` / `session.idle`（stage-complete） | 依次判定值守名单 / 排除项 / 时段窗口 / 节流 / 用户宽限期 / 非 busy，通过后 `session.prompt` 注入续跑消息 |

注入带防重机制：单实例在途锁 + 双事件去重，绝不打断运行中的会话。

## 快速开始

```sh
opencode plugin add github:dubuqiangu/opencode-autocontinue
```

装完只剩一步：**重启 opencode**（`opencode service restart` 或退出重开；重启会打断当前会话，需你点头同意才执行）。

然后任意会话 `/autocontinue on` 即开启值守。

## 更新 / 卸载

```sh
opencode plugin update github:dubuqiangu/opencode-autocontinue   # 更新（建议在 ~ 下执行；plugin list 显示的 commit 可能落后 update 一拍，再执行一次 update/list 对齐）
opencode plugin remove github:dubuqiangu/opencode-autocontinue   # 卸载
```

> **更新后必须完整重启 TUI**（`/reload` 不会重载插件）。

## 功能一览

| 功能 | 入口 | 说明 |
|---|---|---|
| footer 状态指示 | 自动 | `[AC ●]` 值守中 / `[AC ✓]` 完成 / `[AC ⏸ N]` 停止（[docs/features/footer.md](docs/features/footer.md)） |
| 侧边栏「值守」块 | 自动 | `⏱ 值守时长 / 🔁 续跑次数 / 🎯 状态`（[docs/features/footer.md](docs/features/footer.md)） |
| slash 命令 | `/autocontinue on\|off\|status` | 每会话值守开关（[docs/features/commands.md](docs/features/commands.md)） |
| 自动续跑引擎 | 自动 | retry 第一道防线 + 事件驱动注入，含全部停止条件（[docs/features/engine.md](docs/features/engine.md)） |
| 配置系统 | 配置文件 | 全局 + 项目覆盖，deep merge，BOM 容错 JSONC（[docs/features/config.md](docs/features/config.md)） |

## 文档

完整文档在 [docs/](docs/) 下分类组织，[docs/README.md](docs/README.md) 是总入口：

- **使用**：[安装指南](docs/guides/install.md)、[命令](docs/features/commands.md)、[footer 指示](docs/features/footer.md)、[引擎](docs/features/engine.md)、[配置](docs/features/config.md)
- **架构**：[架构总览](docs/architecture/overview.md)、[事件与状态](docs/architecture/events-and-state.md)、[模块布局](docs/architecture/module-layout.md)、[运行时经验](docs/architecture/runtime-lessons.md)
- **决策**：[已知问题](docs/decisions/known-issues.md)、[路线图](docs/decisions/roadmap.md)、[变更记录](docs/decisions/changelog.md)

## 配置

全局配置：`~/.config/opencode/opencode-autocontinue.jsonc`；项目 `.opencode/opencode-autocontinue.jsonc` 内覆盖（deep merge，优先级更高）。BOM 容错 JSONC 解析（支持注释/尾逗号/单引号字符串），坏文件回退默认值。

常用键：`enabled`（总开关）、`message`（续跑消息模板）、`startTime` / `endTime`（值守时段，支持跨午夜窗口如 22:00→08:30）、`maxConsecutive`（最大连续续跑）、`completionMarkers`（完成标记，空数组=不检测）、`excludeTitleKeywords`、`userGraceMs`。`OC_AUTOCONTINUE=0` 环境变量可整体禁用。

完整配置项见 [docs/features/config.md](docs/features/config.md)。

## 开发

- 源码经 OpenCode 运行时解析，无需构建
- 语法校验：`esbuild`
- 单测：`node --test`

## 许可

MIT License