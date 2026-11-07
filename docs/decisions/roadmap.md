# 未来扩展与未实现记录

> 事实基线：owner `dubuqiangu`，插件 id `github:dubuqiangu/opencode-autocontinue`。
> 已发布版本 v0.5.3（commit `ece2e56`），本轮修复后为 **v0.5.4**。

## 已实现（按版本）

| 版本 | 关键特性 |
|---|---|
| v0.2.0 起 | retry hook 作为续跑的第一道防线：命中 `errorPatterns` 即改写为可重试并指数退避，retry 层救不回才落到会话级续跑兜底。 |
| v0.2.0 | TUI 状态层改为每会话独立状态表，footer 状态指示 + 右侧栏 `Watch` 块，多会话同时值守互不覆盖。 |
| v0.3.0 | 统一注入管线：resume 与保活心跳合并为单一 `maybeInject` 入口，注入计数统一为 `injections`。 |
| v0.3.0 | 完成确认两段式：完成标记命中后注入 `finalCheckMessage` 进入 `confirming` 复查轮，再次命中才判 `done`。 |
| 首版起 | 跨午夜值守窗口：跨天窗口自动滚动到次日，`22:00→08:30` 在 23:00 开启不会立即停止。 |
| v0.4.0 | 注入溯源：优先 `session.synthetic` 并带 `metadata.origin="opencode-autocontinue"`，回退 `prompt` + `metadata`，防止插件注入回流被误判为真实用户消息。 |
| v0.4.0 | 验证驱动续跑 Loop（opt-in，`verifyCommand`）：完成不再只信模型自报，按独立命令 exit code 判定，失败则升级提示并续跑。 |
| v0.5.0 | abort/pause 哨兵与 `paused` 状态：`<loop-abort>` / `<loop-pause>` 成对标签，判定顺序 abort → pause → done。 |
| v0.5.0 | 升级式续跑提示与轮次压力梯：基础 `message` + 6 档压力梯（3/7/15/30/50）+ 拒绝数阈值追加提示。 |
| v0.5.0 | 工具失败观测计数器 `observeToolFailures`（opt-in，仅观测，不参与完成/停止判定）。 |
| v0.5.1 | 跨午夜起点闸 `startGateClosed`：次日 `00:00..startTime` 之间窗口仍视为开启。 |
| v0.5.1 | 验证前 TOCTOU 修复：`runVerifyGate` 在创建验证 controller 前重取快照复检，避免陈旧验证结果被当新轮。 |
| v0.5.1 | 配置健壮性：非有限数值（`NaN` / `±Infinity`）一律回退默认，JSONC 改为字符串感知的尾逗号解析。 |
| v0.5.2 | 挫败感触发（opt-in，默认关闭）：命中真实用户抱怨后把一句质量不满提醒追加到下一次注入末尾，不新开一轮。 |
| v0.5.2 | 无人值守护栏默认上界：`watchTimeoutMs` 默认 24h、`verifyMaxIterations` 默认 50（显式 `0` 仍 = 无限）。 |
| v0.5.2 | `stopReason` 停止原因可观测：7 值贯通 `WatchState` → `markStopped` → 事件/RPC schema → footer 与 `/autocontinue status` toast。 |
| v0.5.3 | `maxConsecutive` 负值回退默认 20（`0` 仍表示不限）：此前负值会让上限判定失效，注入次数不再受限。 |
| v0.5.3 | 墙钟预算 `watchTimeoutMs` 改为按轮次计量：真实用户消息开启新一轮即重算，新增内部字段 `roundSince`，`since` 语义不变（仍供侧栏 ⏱ 时长）。 |
| v0.5.3 | 新增第 8 个停止原因 `title-excluded`（界面短语 `title excluded`），标题命中排除关键词不再是无原因的裸停止。 |
| v0.5.3 | 停止原因收敛为单一真源（8 值）并加测试守卫，杜绝枚举字面量各写一份而漂移。 |
| v0.5.3 | 测试定时器泄漏修复，`npm test` 跑完自行退出，不再需要 `--test-force-exit`。 |
| v0.5.3 | 文档层结构化与事实校正：入口页、安装命令占位符、断链修复、changelog 重构、设计稿拆分三份。 |
| v0.5.4 | 全局配置路径可注入：`loadConfig` 新增可选的 `LoadConfigOptions`，不传时行为与 v0.5.3 完全一致。 |
| v0.5.4 | 测试夹具去重：`test/server.test.ts` 改用共享夹具 `test/support/harness.ts`，仓库内不再有第二份实现。 |
| v0.5.4 | 测试断言改为与配置常量比对，不再把默认续跑消息的中文文案硬编码在测试里。 |

## 真机待办

以下三项**仍未做实机验证**（单测与静态守卫已覆盖，但缺真机确认）：

| 项 | 说明 |
|---|---|
| 跨午夜窗口 | `startGateClosed` 在真实跨午夜会话中的滚动与注入行为。 |
| 验证 TOCTOU | 验证命令执行期间真实用户消息插入时，陈旧结果是否被正确丢弃。 |
| stopReason 显示效果 | footer `[AC ⏹ N · <phrase>]` 与 `/autocontinue status` toast 的实际渲染效果。 |

任务明细见 [任务清单](../../tasks.md)。

## 本轮 v0.5.4（2026-11-08 发布）

1. 全局配置路径可注入：`loadConfig` 新增可选的 `LoadConfigOptions`；不传时行为与 v0.5.3 完全一致。
2. 测试夹具去重：`test/server.test.ts` 改用共享夹具 `test/support/harness.ts`，仓库内不再有第二份实现。
3. 测试断言改为与配置常量比对，不再硬编码默认续跑消息的中文文案。

本轮**无用户可见行为变更**；`src/config.ts` 有运行时 API 变更，按仓库发布规则 bump 至 `0.5.4`。

## 未来方向（尚无明确排期）

| 方向 | 说明 |
|---|---|
| 全局默认值守 | 需配置项 `defaultEnabled` 之类，当前只做每会话手动开关。 |
| 值守会话列表 UI | 右栏/面板展示所有值守会话状态（当前只展示当前会话的 `Watch` 块）。 |
| 更细的完成判定 | AI 辅助判断任务完成（当前刻意不做，零模型成本）。 |
| 清理 V1 兼容死路径 | `message.updated` / `session.error` / `info.role` 当前**有意保留**；若清理需同步改测试与 changelog，并先征得同意。 |

## 不移植 / 不做的清单

参考项目 `MichengAI/dsh-pua`（取证基线 `main`@`26ed406`，Apache-2.0）。v0.5.2 裁定：**只移植** Loop 压力 6 档 + Oracle 拒绝 3 档（后者在代码中并入压力梯语义，代码里搜不到 `oracle` 字样）；以下 8 类**不移植**：

| 项 | 不移植理由 |
|---|---|
| 风味 15 套 | 需 systemPrompt / commands / agent 注册 API，我方宿主无此 API。 |
| 人设 | 同上，需模型侧角色注册能力。 |
| 方法论预设 | 需 systemPrompt / commands / agent 注册 API。 |
| 角色层级 | 需 systemPrompt / commands / agent 注册 API（verifier / self-reviewer 等）。 |
| i18n | 需宿主侧文案资源注册与语言协商机制。 |
| 降压换框 | 需模型侧判断（由模型自行选择降压说法），我方只发固定文案槽。 |
| 钉味 | 该行为诉求已被 exit-code 验证门控覆盖。 |
| feedback 判定 | 需 transcript 路径，我方当前拿不到会话转录文件路径。 |

我方 `message` / `finalCheckMessage` / `escalation*` 文案槽已能承载上述机制的行为内容。

## 相关文档

- 决策与裁定索引：[docs/architecture/provenance-and-loop.md](../architecture/provenance-and-loop.md)
- 现行机制规格：[docs/architecture/loop-mechanisms.md](../architecture/loop-mechanisms.md)
