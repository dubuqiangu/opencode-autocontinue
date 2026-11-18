# 未来扩展与未实现记录

> 事实基线：owner `dubuqiangu`，插件 id `github:dubuqiangu/opencode-autocontinue`。
> 最近一次带 commit 记录的发布为 v0.5.7（commit `22e965f`）；**v0.5.8 为本轮发布中**
> （`package.json` 的 `version` 已是 `0.5.8`，尚未打 commit / tag）。

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
| v0.5.2 | `stopReason` 停止原因可观测：**7 值**（v0.5.2 当时口径）贯通 `WatchState` → `markStopped` → 事件/RPC schema → footer 与 `/autocontinue status` toast；v0.5.3 补第 8 值后为 8 值。 |
| v0.5.3 | `maxConsecutive` 负值回退默认 20（`0` 仍表示不限）：此前负值会让上限判定失效，注入次数不再受限。 |
| v0.5.3 | 墙钟预算 `watchTimeoutMs` 改为按轮次计量：真实用户消息开启新一轮即重算，新增内部字段 `roundSince`，`since` 语义不变（仍供侧栏 ⏱ 时长）。 |
| v0.5.3 | 新增第 8 个停止原因 `title-excluded`（界面短语 `title excluded`），标题命中排除关键词不再是无原因的裸停止。 |
| v0.5.3 | 停止原因收敛为单一真源（8 值）并加测试守卫，杜绝枚举字面量各写一份而漂移。 |
| v0.5.3 | 测试定时器泄漏修复，`npm test` 跑完自行退出，不再需要 `--test-force-exit`。 |
| v0.5.3 | 文档层结构化与事实校正：入口页、安装命令占位符、断链修复、changelog 重构、设计稿拆分三份。 |
| v0.5.4 | 全局配置路径可注入：`loadConfig` 新增可选的 `LoadConfigOptions`，不传时行为与 v0.5.3 完全一致。 |
| v0.5.4 | 测试夹具去重：`test/server.test.ts` 改用共享夹具 `test/support/harness.ts`，仓库内不再有第二份实现。 |
| v0.5.4 | 测试断言改为与配置常量比对，不再把默认续跑消息的中文文案硬编码在测试里。**（部分完成，见 v0.5.5 行）** |
| v0.5.5 | 配置诊断与校验：配置文件读取/解析失败时输出含绝对路径的告警；数组键剔除空串、`markerRegex` 三重防护、`HH:MM` 时间窗校验、数值负值钳 0 与超大值钳上限。 |
| v0.5.5 | 回声幂等与时间窗兜底：注入记录在整个 `selfEchoWindowMs` 窗口内保持有效；文本提取不到时按时间窗判回声。 |
| v0.5.5 | 护栏与生命周期加固：`roundId` 进程级全局单调递增、在途注入锁与每轮缓存拆分、引擎 disposed 守卫、final-check 复检、定时器延迟钳制、配置读取位置前移。 |
| v0.5.5 | 错误匹配串统一：`name` 缺失时回退读 `type`，retry hook 路径与消息事件路径产出同一匹配串。 |
| v0.5.5 | TUI 纯逻辑抽离到 `src/tui-logic.ts`；TUI 状态指示在查询失败时保留原指示。 |
| v0.5.5 | 验证进程终止补 spawn 失败监听，消除未捕获异常；脱敏扫描器扩充为 12 条模式。 |
| v0.5.6 | 单引号串改**字面量语义**（只有 `\'` / `\\` 是转义）：Windows 路径 `'C:\Users\<用户名>\name\file.txt'` 不再抛 `SyntaxError`，也不会被 JSON 转义规则静默解码成含控制字符的坏路径；双引号串保持严格 JSON 语义。 |
| v0.5.6 | 配置钳制的**诊断对称性**：建立「被静默改写的值必产生恰好一条诊断、合法值零诊断」的不变式，覆盖负值钳 0、`intervalMs` 1s 地板、`2^31-1` 上限、`maxConsecutive` 负值回退、验证超时与轮数越界、6 个数组键剔空。 |
| v0.5.6 | 侧栏与 status toast 不再暴露内部枚举值：新增 `WATCH_STATE_LABELS` 状态标签表（`on watch` / `review round` / `on hold` / `stopped` / `finished`），未知态回退 `unknown state (<原始值>)`；`⏱` 起始占位改为 `⏱ starting`。 |
| v0.5.6 | 标签表 own-property 守卫：`STOP_REASON_LABELS` / `WATCH_STATE_LABELS` 改用 `Object.hasOwn`，修掉 `constructor` / `toString` 等原型链键被渲染成 `function Object() { [native code] }` 的既有缺陷。 |
| v0.5.6 | 手工验证脚本 `test/config-verify.ts` 改用 `globalConfigPath()`，不再直读 `USERPROFILE` / `HOME`；配置文件缺失与匹配器为 `null` 时给提示而非崩栈。 |
| v0.5.6 | 结构：`src/config.ts` 按职责拆为 `config-schema.ts` / `config-parse.ts` / `config-validate.ts` + 瘦门面，导出名保持不变。 |
| v0.5.7 | 右栏 OMO-Slim↔Stats 间距翻倍修复：空闲时不再创建 0 高占位容器 box，slot render 改返回响应式 thunk，空闲产出 `true` 不占 gap。 |
| v0.5.8 | 配置层补齐「静默丢弃」诊断：新增 `CONFIG_KEY_TYPES` 类型预检（覆盖 `PluginConfig` 全部 30 个键），类型不匹配 / 非有限值 / 必填空串 / 非对象配置文件一律回退基础值并产生**恰好一条**告警，**生效值零变化**。 |
| v0.5.8 | 测试文案硬编码清完（v0.5.4 遗留项）：`UNTRUSTED_NOTICE` / `rejectionCountLine` / `REMAINING_*` 从 `src/` 导出为常量，断言改为与常量或配置槽比对，断言强度只增不减。 |
| v0.5.8 | `stopReason` 渲染拼装下沉为纯函数：`footerIndicatorLabel` / `statusToastMessage` 取代 JSX 内联拼装，「原因短语缺失 / footer 与 toast 不一致 / 复数化错误」从此可确定性单测。 |

## 真机待办

以下三项**仍未做实机验证**（单测与静态守卫已覆盖，但缺真机确认），v0.5.8 仍未做：

| 项 | 说明 | v0.5.8 进展 |
|---|---|---|
| 跨午夜窗口 | `startGateClosed` 在真实跨午夜会话中的滚动与注入行为。 | 单测补强：新增**钉住日历日期**的用例（时钟固定在 `2026-11-19 23:59` / `2026-11-20 00:01` / `2026-11-20 09:00`），断言 `computeEndAt` 恰落在**下一个日历日**的 08:30 |
| 验证 TOCTOU | 验证命令执行期间真实用户消息插入时，陈旧结果是否被正确丢弃。 | 未变——需真实并发模拟，本轮不修 |
| stopReason 显示效果 | footer `[AC ⏹ N · <phrase>]` 与 `/autocontinue status` toast 的实际渲染效果。 | 插件侧**已闭合**：文案拼装下沉为纯函数并有确定性单测；剩余仅**宿主原样渲染**这一层 |

任务明细见 [任务清单](../../tasks.md)。

## 本轮 v0.5.5（2026-11-08 发布）

本轮是 v0.5.4 之上的**加固轮**，主题是「配置写错时不再静默」与「值守状态不再被误清」。

1. 配置诊断与校验：读取/解析失败输出含绝对路径的告警；数组键剔除空串；
   `markerRegex` 长度上限（1024）、嵌套量词（ReDoS）与可编译三重检查；
   `startTime` / `endTime` 校验 `HH:MM`；数值负值钳 0、超过 `2^31-1` 钳上限。
2. 护栏与生命周期加固：`roundId` 进程级全局单调递增；在途注入锁与每轮缓存拆分；
   引擎 disposed 守卫；final-check 复检；定时器延迟钳制；配置读取位置前移。
3. 回声幂等与时间窗兜底：注入记录在整个 `selfEchoWindowMs` 窗口内保持有效；
   文本提取不到时按时间窗判回声。
4. 错误匹配串统一、TUI 纯逻辑抽离、TUI 状态指示保留、验证进程 spawn 失败监听、
   脱敏扫描器扩充。

**本轮没有修的已知问题**（详见 [known-issues.md](known-issues.md)）：

- **存储多实例丢行未修**——值守列表仍按单一存储键 `opencode-autocontinue.watched` 保存，
  多个实例并发写会互相覆盖丢行。按会话分键属**破坏性存储布局变更**，需另给迁移与
  向后兼容方案，本轮**不修**。
- **回声时间窗兜底的残留风险未消除**——真实用户消息在窗口内且宿主不提供可提取文本时，
  仍会被判为回声而未被处理。
- **v0.5.4 的「测试解除文案硬编码」只完成了一部分**——默认续跑消息与 `finalCheckMessage`
  的中文文案前缀仍以字面量出现在断言里，本轮未补完。

`src/` 有运行时改动，按仓库发布规则 bump 至 `0.5.5`。

## 本轮 v0.5.6（2026-11-09 发布）

本轮是 v0.5.5 之后的**收尾轮**，主题是「把上一轮报告里的既有低优先级项一次清掉」。

1. 单引号串改**字面量语义**（只有 `\'` / `\\` 是转义），Windows 路径不再抛
   `SyntaxError`，也不再被 JSON 转义规则静默解码成含控制字符的坏路径；
   双引号串保持严格 JSON 语义。
2. 配置钳制的**诊断对称性**：建立「被静默改写的值必产生恰好一条诊断、合法值零诊断」
   的不变式，覆盖负值钳 0、`intervalMs` 1s 地板、`2^31-1` 上限、`maxConsecutive`
   负值回退、验证超时与轮数越界、6 个数组键剔空。
3. 侧栏与 status toast 不再暴露内部枚举值（新增 `WATCH_STATE_LABELS` 状态标签表）；
   `⏱` 起始占位改为 `⏱ starting`。
4. 标签表 **own-property 守卫**（`Object.hasOwn`）——修掉 v0.5.5 已发布的
   `constructor` / `toString` 等原型链键缺陷。
5. 手工验证脚本 `test/config-verify.ts` 改用 `globalConfigPath()`，不再直读
   `USERPROFILE` / `HOME`；配置缺失与匹配器为 `null` 时给提示而非崩栈。
6. 结构：`src/config.ts` 按职责拆分（`config-schema` / `config-parse` /
   `config-validate` + 瘦门面），导出名保持不变。

**本轮没有修的已知问题**（详见 [known-issues.md](known-issues.md)）：

- **存储多实例丢行未修**——延续 v0.5.5 的裁定：按会话分键属**破坏性存储布局变更**，
  需另给迁移与向后兼容方案，本轮**不修**。
- **回声时间窗兜底的残留风险未消除**——真实用户消息在窗口内且宿主不提供可提取文本时，
  仍会被判为回声而未被处理。
- **v0.5.4 的「测试解除文案硬编码」只完成了一部分**——延续未补完。
- **标量配置项的非有限值 / 类型不匹配仍是静默回退**——本轮只把**数组键**的剔空纳入
  诊断；`NaN` / `Infinity` 与标量类型不匹配仍无诊断，需单独裁决。
- **`watchTimeoutMs` / `userGraceMs` / `selfEchoWindowMs` 无 `2^31-1` 上限钳制**——
  本轮明确不加：会改变合法值行为，超出本轮范围。

`src/` 有运行时改动，按仓库发布规则 bump 至 `0.5.6`。

## 本轮 v0.5.8（2026-11-19 发布）

本轮是 v0.5.7 之后的**收尾轮**，主题是「配置写错时不再静默」与「把只能实机验证的渲染收敛成可确定性验证」。

1. 配置层补齐「静默丢弃」诊断：新增 `CONFIG_KEY_TYPES` 类型预检（覆盖 `PluginConfig`
   全部 30 个键），类型不匹配 / 非有限值 / `message`·`finalCheckMessage` 空串 / 整个配置文件
   不是对象，一律回退基础值并产生**恰好一条**告警；**生效值零变化**（差分探针逐字节比对证实）。
2. v0.5.4 遗留的测试文案硬编码清完：用户可见文案从 `src/` 导出为常量，断言改为与常量或
   配置槽比对，断言强度只增不减。
3. `stopReason` 的 footer / toast **文案拼装**从 JSX 下沉到 `src/tui-logic.ts` 的两个纯函数，
   渲染一致性从「只能靠真人实机发现」变成确定性单测。
4. 跨午夜窗口补一条**钉住日历日期**的单测（既有用例从实现自身读的 `now` 推导期望值，
   只能证明「落在某个时刻」，钉不住日历日期）。

**本轮没有修的已知问题**（详见 [known-issues.md](known-issues.md)）：

- **三个时长键不加 `2^31-1` 上限**——`watchTimeoutMs` / `userGraceMs` / `selfEchoWindowMs`
  的取证结论是三者**全是纯时间差比较阈值**，代码中无一处进入 `setTimeout` / `setInterval`
  的延迟参数；引擎侧 `clampTimerDelay` 已覆盖全部 2 处定时器创建点。加上限**不是修 bug，
  是改写合法值行为**（如 `watchTimeoutMs: 2592000000` 会被改短导致提前 `watch-timeout`）。
  本轮**明确排除**。
- **验证流程的 TOCTOU 未做实机验证**——需真实并发模拟，本轮不修。
- **存储多实例丢行未修**——按会话分键属**破坏性存储布局变更**，需另给迁移与向后兼容方案。
- **回声时间窗兜底的残留风险未消除**——真实用户消息落在 `selfEchoWindowMs` 窗口内且宿主
  不提供可提取文本时，仍会被判为回声而未被处理。
- **宿主原样渲染层未验证**——`stopReason` 在真实字体 / emoji 宽度下的显示效果仍需实机确认。

`src/` 有运行时改动，按仓库发布规则 bump 至 `0.5.8`。

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
