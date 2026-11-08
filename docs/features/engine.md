# 自动续跑引擎

核心逻辑在 server（`src/engine.ts`）：值守判定、节流、时段、续跑注入。只监听事件 + 提供 RPC。

## 两类恢复路径

| 路径 | 触发 | 动作 |
|---|---|---|
| 错误恢复 | `session.error` / assistant 消息带 error | 判定可重试 → 延迟注入续跑消息 |
| 空闲恢复 | `session.idle`（stage-complete） | 判定通过后注入续跑消息 |

## retry hook：第一道防线

模型调用瞬时失败（如 `bad_response_status_code`）时，`ctx.session.hook("retry")` 先拦截：

- 命中 `errorPatterns` → 改 `retry: true` + 指数退避（2s→4s→… 封顶 60s）
- 尽量在调用层恢复，**不产生续跑消息**

retry 层救不回（最终失败）才走会话级续跑兜底——两层互补而非替代。

## 注入判定流程

收到 `session.error` / `session.idle`（以及周期检查心跳）后进入 `maybeInject`，
按下列阶段依次检查。判定分三类：**停止**（记 `stopReason`，本轮结束）、**跳过本轮**
（不注入，稍后重试）、**继续**（进入注入漏斗）。`inFlight` 锁在入口即置位，防并发重复注入。

**阶段一 · 守护栏（超出即停止）**

1. 会话状态是否为 `watching` / `confirming`？否则本轮结束（并停掉周期检查）。
2. 值守时段闸门是否开启？（`startGateClosed`——跨午夜窗口的 `00:00`..`startTime` 之间
   窗口仍视为开启；**未开启则跳过本轮**）
3. 是否在值守时段窗口内？（冻结的 `endAt` 未到；否则**停止**，原因 `window-closed`）
4. 墙钟预算是否用尽？（`watchTimeoutMs`，默认 24h；否则**停止**，原因 `watch-timeout`）
5. 是否已达注入上限？（`maxConsecutive`，默认 20；`0` = 不限；否则**停止**，原因 `injection-cap`）

**阶段二 · 会话状态闸门（跳过本轮，不注入）**

6. 距上次真实用户消息是否足够久？（> `userGraceMs`，默认 15s；不足则推迟本轮）
7. 会话标题是否命中排除关键词？（`excludeTitleKeywords`，默认含 `测试`；命中则**停止**，
   原因 `title-excluded`）
8. 模型近期是否繁忙？（事件派生的 `lastBusyAt`：**60 秒**内判定为忙，不注入）
9. 会话近期是否仍在活动？（事件派生的 `lastActiveAt`：**`idleDelayMs`** 内视为仍在跑，不注入）
10. 是否在节流内？（距上次注入 < `minIntervalMs`，默认 30s；剩余时间到点再判定）

**阶段三 · 注入漏斗**

11. 读取最后一条 assistant 消息（并按 `observeToolFailures` 记录工具失败观测）。
12. 是否命中 abort 哨兵？（`<loop-abort>…</loop-abort>` → **停止**，原因 `abort-sentinel`）
13. 是否有后台子代理/任务在跑？（有则**跳过本轮**——整体任务尚未结束，不判完成也不注入）
14. 是否命中 pause 哨兵？（`<loop-pause>…</loop-pause>` → `paused`，等待用户补充后恢复）
15. 完成判定 / 验证门控（见下文「完成检测」「验证模式」）。
16. 注入。

> **没有 `session.status` 轮询。** 忙/活跃状态由事件派生：`lastBusyAt`（60 秒窗口）与 `lastActiveAt`（`idleDelayMs` 窗口），不使用轮询等待。
>
> 阶段顺序与 `docs/features/config.md` 的「配置生效顺序」一致；逐环节的输入、判据与落点见
> [loop-mechanisms.md §1–§8](../architecture/loop-mechanisms.md)。

## 注入通道

注入优先走 `session.synthetic({sessionID, text, metadata, resume: true})`——落库 `type=synthetic`，结构上可与真实用户消息区分。宿主不支持 `session.synthetic`（或调用失败）时，回退到 `session.prompt({sessionID, text, metadata})`。

两路都带溯源 metadata（`origin: "opencode-autocontinue"`），使注入回流不被误判为真实用户消息。

**注入文本并非全部同一条**：

| 场景 | 注入文本 |
|---|---|
| 普通续跑（错误恢复 / 空闲续跑 / 周期检查） | `message` |
| 完成复查轮（进入 `confirming` 后） | `finalCheckMessage` |
| 验证失败轮 | `composeRejectionPrompt()`（= `message` + 压力梯一行 + 阈值追加句） |

**并发防护**：`maybeInject` 入口即置 `inFlight`，中间有多个 `await`（解析标题、取最新消息），并发事件/定时器不会再通过检查。注入前还会复查会话仍处于 `watching` **或** `confirming`（完成复查轮同样允许注入）——`await` 期间可能已被 unwatch / markDone / markStopped，此时放弃注入。

## 完成检测（停止条件）

| 停止条件 | 说明 |
|---|---|
| 完成标记（两阶段） | 最后一条 assistant 消息首次命中 `completionMarkers`（或 `markerRegex`）→ 进入 `confirming` 并注入 `finalCheckMessage`；复查回复再次命中 → `done`。`finalCheckEnabled: false` 时命中即 `done`。`completionMarkers` 为空数组 = 不检测完成；`markerRegex` 若有效则**取代** `completionMarkers` |
| 最大连续注入次数 | `injections >= maxConsecutive`（默认 20）→ 停止（`injection-cap`） |
| 值守时段 | 到达 `endTime`（watch 时冻结 endAt；跨午夜窗口如 22:00→08:30 会自动滚动到次日，非跨日窗口当天已过立即停止）→ 停止（`window-closed`） |
| 墙钟上限 | 单轮值守时长达到 `watchTimeoutMs`（默认 24h）→ 停止（`watch-timeout`） |
| 验证失败上限 | 验证失败轮次达到 `verifyMaxIterations`（默认 50）→ 停止（`verify-limit`） |
| 用户手动 off | `/autocontinue off` → 停止（直接移除记录，**不是**一条停止路径） |
| 用户主动中止 | `session.execution.interrupted`（V2）/ `session.idle` 且 `outcome="interrupted"`（V1，Esc 手工停止）→ 停止但保留值守标记（可重新 on）。`MessageAbortedError` / `operation was aborted` 属 `excludePatterns`（不自动续跑的错误特征），并非停止来源 |
| 模型终止/暂停哨兵 | `<loop-abort>…</loop-abort>` → `stopped`；`<loop-pause>…</loop-pause>` → `paused`（成对标签，仅读 assistant 文本） |
| 标题排除 | 会话标题命中 `excludeTitleKeywords` → 停止（`title-excluded`，v0.5.3 起带原因） |

## 停止原因（v0.5.2 起，v0.5.3 补齐第 8 个）

停止时会给 watch 状态记一个 `stopReason`（**只在 `stopped` 轮存在**），用于回答「为什么停」。**除用户主动 `/autocontinue off`（直接移除值守记录，不是一次停止）外，各停止路径都会带上原因**；标题排除路径自 v0.5.3 起也带 `title-excluded`。

| `stopReason` | 英文短语（UI 显示） | 触发点 |
|---|---|---|
| `window-closed` | `window closed` | 值守窗口到点（每日 `endTime` / 冻结的 `endAt`） |
| `watch-timeout` | `watch timeout` | 墙钟上限 `watchTimeoutMs` 到期（默认 24h） |
| `injection-cap` | `injection cap` | 注入次数达 `maxConsecutive`（默认 20） |
| `verify-limit` | `verify limit` | 验证失败次数达 `verifyMaxIterations`（默认 50） |
| `idle-interrupted` | `interrupted while idle` | 空闲轮被中断（模型报错 / 网络抖动） |
| `user-interrupted` | `stopped by user` | 用户主动中止（Esc / `session.execution.interrupted`） |
| `abort-sentinel` | `abort sentinel` | 模型输出 abort 哨兵 `<loop-abort>…</loop-abort>` |
| `title-excluded` | `title excluded` | 会话标题命中 `excludeTitleKeywords`（默认含 `测试`），该会话不续跑 |

- **护栏停止一律是 `stopped`，绝不是 `done`**：次数上限 / 墙钟上限 / 窗口关闭 / 验证上限都只表示「不再续跑」，不表示任务完成。`done` 仅由完成信号判定（verify 模式下还需验证命令 exit code 为 0）。
- `stopReason` 经 RPC（`WatchStatus` / `state.changed`）传给 TUI，UI 只显示人类可读的英文短语，不暴露枚举值。
- 设计依据见 [provenance-and-loop.md §2.6](../architecture/provenance-and-loop.md#26-无人值守护栏与停止原因d15d16)。

## 验证模式

配置 `verifyCommand` 后，完成判定改由该命令的 **exit code** 决定：

- 通过（exit 0）→ `done`
- 失败 → 计入失败轮次并升级提示（`composeRejectionPrompt()`：压力梯按 3/7/15/30/50 分档，≥3 次追加 reassess，≥5 次追加 root cause）
- `verifyTimeoutMs` 默认 `120000`（120s），超时按失败处理
- `verifyMaxIterations` 默认 `50`，为验证失败轮次上限
- 命令**无法启动**时降级为信任模型的完成信号

## 防重 / 防冲突

- **单实例续跑**：同一会话同一时刻只允许一个在途注入（`inFlight` 锁）
- **双事件防重**：`session.error` 与 `message.updated(error)` 可能同时到达，用 `pendingContinue` 标记去重，只在 idle 时统一发送
- **不打断运行中会话**：靠事件派生的 `lastBusyAt`（60 秒窗口）/ `lastActiveAt`（`idleDelayMs` 窗口）判定，不轮询 `session.status`
- **不与其他插件冲突**：本插件不改会话、不删消息，只读事件 + 注入 prompt

## v0.5.5 增量

本轮是**加固轮**，用户可见的变化集中在「值守状态不再被误清」与「配置写错时不再静默」。

### 护栏与生命周期

- **定时器延迟钳制**（`clampTimerDelay`）：引擎排出的**每个**定时器延迟都钳到 `2^31-1`
  ——超限值此前会退化成 1ms 热循环。
- **引擎 disposed 守卫**：引擎 disposed 后**不再新建定时器**、**不再改写持久化状态**，
  避免卸载后仍有副作用。
- **final-check 复检**：完成复查轮的注入在 `await` 之后**复检会话是否仍被值守**，
  避免用户在这段窗口内关闭值守后仍发生注入。
- **`roundId` 进程级全局单调递增**：此前 `roundId` 从 0 重新开始，off → on 之后
  **陈旧的验证结果**可能被当成新一轮的结果。
- **在途注入锁与每轮缓存拆分**：`watch()` 重置**每轮缓存**但**不清除在途注入锁**；
  `unwatch()` 两者都清。重开值守不再让仍在途的注入失去互斥保护。
- **配置读取位置前移**：非值守会话的事件**不再白读两次盘**；回声判断复用**已加载**的配置。

### 自回声判定

- **回声幂等**：注入记录在**整个 `selfEchoWindowMs` 窗口内保持有效**，不在首次命中时清除。
  宿主把同一条注入以**两种事件形状**各投递一次（例如 `message.updated` 与
  `session.inbox.enqueued`）时，第二次投递同样被判为回声——不触发 `resume()`，
  也不清零**注入上限 / 验证失败计数 / 轮次墙钟**三重上界。
- **时间窗兜底**：入站文本**提取不到**且窗口内确有自注入记录时，判定为自身回声。
  残留风险（真实用户消息在窗口内且宿主不提供可提取文本时被吞）见
  [known-issues.md](../decisions/known-issues.md)，本版不修。

### 错误匹配串统一

错误事件的匹配串在 `name` 缺失时**回退读 `type`**——retry hook 路径与消息事件路径
从此产出**同一个**匹配串，不再出现「同一类错误在两条路径上分类不同」。

### TUI 与验证进程

- **TUI 纯逻辑抽离**（`src/tui-logic.ts`）：停止原因文案表、时长格式化、watch 状态合并
  三块纯逻辑从 `src/tui.tsx` 抽出，可直接单测，不再需要从 `.tsx` 源码里刮表。
- **TUI 状态指示保留**：查询 watch 状态失败时**保留**原有指示——此前会误删「正在值守」的显示；
  现在**仅当**服务端明确回答「未在值守」时才移除条目。
- **验证进程终止**：Windows 进程树终止助手补上 **spawn 失败监听**——此前异步失败会变成
  **未捕获异常**，可能带崩宿主进程。
