# footer 状态指示 + 右侧栏值守块

## footer 状态指示

挂载点：`prompt.footer.status`（append 模式，不覆盖原生状态行）。

### 状态与图标

| 状态 | 显示 | 条件 |
|---|---|---|
| 值守中 | `[AC ●]` | 当前会话已 `/autocontinue on`，正在值守 |
| 已完成 | `[AC ✓]` | 助手消息命中完成标记，已停止续跑 |
| 已暂停 | `[AC ⏸]` | 模型输出 `<loop-pause>…</loop-pause>`，暂停等待用户补充（用户新消息后恢复）。**`⏸` 是暂停，不是停止** |
| 已停止 | `[AC ⏹ N]` | 达最大续跑次数 / 时段窗口关闭 / 墙钟超时 / 验证上限 / 中止等护栏触发，或会话标题命中排除关键词，N = 已续跑次数 |
| 已停止（带原因） | `[AC ⏹ N · <phrase>]` | 同上，且该停止路径带有 `stopReason`，`·` 后跟人类可读的英文短语 |

未值守的会话不渲染任何 footer 指示（返回 null，不占位）。

### 停止原因文案

- 会话处于 `stopped` 时，UI 显示**人类可读的停止原因短语**（英文，如 `injection cap`、`window closed`），**不直接暴露 `stopReason` 的原始枚举值**（`injection-cap` / `window-closed` / `verify-limit` …）。
- 文案出现在 footer 的已停止指示与 `/autocontinue status` 的命令 toast（stopped 轮追加 ` · <phrase>`）；原因随 `state.changed` 事件携带的 `stopReason` 字段实时写回。

**8 个停止原因短语对照表（v0.5.3 补齐 `title excluded`）：**

| `stopReason` | UI 短语（原文） | 一句话解释 |
|---|---|---|
| `window-closed` | `window closed` | 值守时段窗口到点（每日 `endTime` / 冻结的 `endAt`） |
| `watch-timeout` | `watch timeout` | 墙钟上限 `watchTimeoutMs` 到期（默认 24h） |
| `injection-cap` | `injection cap` | 注入次数达 `maxConsecutive`（默认 20） |
| `verify-limit` | `verify limit` | 验证失败轮次达 `verifyMaxIterations`（默认 50） |
| `idle-interrupted` | `interrupted while idle` | 空闲轮被中断（模型报错 / 网络抖动） |
| `user-interrupted` | `stopped by user` | 用户主动中止（Esc / `session.execution.interrupted`） |
| `abort-sentinel` | `abort sentinel` | 模型输出 abort 哨兵 `<loop-abort>…</loop-abort>` |
| `title-excluded` | `title excluded` | 会话标题命中 `excludeTitleKeywords`（默认含 `测试`），该会话不续跑 |

## 右侧栏值守块

挂载点：`sidebar.content`（append 模式，与原生 Context/MCP 段同通道，落于其下）。

| 状态 | 显示 | 条件 |
|---|---|---|
| 值守中 | `Watch` + `⏱ 3m 22s` / `🔄 N injections` / `🎯 on watch\|review round` | 值守进行中（`watching` / 复查轮 `confirming`），⏱ 为已值守时长 |
| 值守中（注入计数补充） | `🔄 N injections (M this round)` | 括号内 M 为**本轮**（自上次真实用户消息起）的注入数；累计数与本轮数相同时不显示括号后缀 |
| 值守中（附加行，仅有值时） | `🔍 verifying` / `🚫 N rejections` / `🛠 N tool failures` | 验证命令运行中 / 本轮验证被拒次数 / 启用 `observeToolFailures` 时的工具失败观测计数 |
| 终态 / 未值守 | 不渲染（返回 null，不占位） | `done` / `stopped` / `paused`，或未 `/autocontinue on` |

- **两处注入计数口径不同，别直接比对**：侧栏 `🔄` 的主数字是**生命周期累计**（`totalInjections`，自该会话首次值守起累计），括号里的 `M this round` 才是本轮数；而 `/autocontinue status` 的 toast 只显示**本轮**注入数（`injections`）。所以一个会话值守过几轮后，侧栏主数字会大于 status toast 里的数字——这是口径差异，不是显示错误。

- 全英文标签（图标 + 英文单词），与 usage-meter 右侧栏风格一致
- 注入计数用 **🔄**（U+1F504），不是 🔁
- `⏱` 时长每 1s 刷新（状态为 `watching` / `confirming` 时跑定时器）
- `⏱` 的**起始占位**是 `⏱ starting`（`since` 尚未成为数字时）：刻意不用省略号 `…`——省略号看起来像一个**被截断的数值**，与相邻行的数值风格不一致；`starting` 是正常英文措辞，且**行长度稳定**，真实时长到位时不会让侧栏块跳动
- 侧栏块只承载"值守进行中"；终态/暂停反馈由 footer 指示符（`[AC ✓]` / `[AC ⏸]` / `[AC ⏹ N]` / `[AC ⏹ N · <phrase>]`）与命令 toast 承载——终态行曾在此渲染且跨重启复活，导致每个历史值守过的会话常驻 Watch 块（v0.3.6 修复）
- **标题可折叠**（v0.3.9）：点击 `▼ Watch` 标题行立即收起为 `▸ Watch`，再点展开；折叠状态存 setup 作用域（v0.3.10），宿主重挂载侧栏不重置（重挂载重置曾让折叠像失效）

## 刷新机制

- **每会话独立状态**：TUI 维护 `Record<sessionID, status>` 的每会话状态表，不是单个全局信号——多会话同时值守互不覆盖（A 的标记不会因开启 B 而消失）
- **动态读走 createMemo**：footer/sidebar 的渲染文本全部在 `createMemo` 内计算，信号变化即时触发 JSX 重渲染（无需切 session 才刷新；对应 usage-meter v0.7.8 修复的同款问题）
- 订阅 RPC 事件 `autocontinue.state.changed`，状态变化更新对应会话的表项；事件携带 `rejections`/`verifying`/`toolFailureCount`/`stopReason`，随状态实时写回（v0.5.0/v0.5.1/v0.5.2）
- 会话 ID 来源：`slotProps.sessionID`（JSX 函数组件收到的是 props 包装对象，须先解包再读——v0.3.6 前直接读包装层导致 `lastSlotSessionID` 永不缓存，`/autocontinue` 报「No current session」），回退 `lastSlotSessionID`（slot 缓存）→ `context.ui.router.current().params.sessionID`

## 配套反馈

- 开启/关闭/续跑注入/停止/出错时 toast 提示（全英文，标题固定为 `Autocontinue`）：开启 `Watch enabled`、关闭 `Watch disabled`
- `/autocontinue status` 直接读 RPC 结果（不经可能过期的信号），显示 `<label> · N injections`（计数为 1 时显示 `1 injection`；stopped 轮追加 ` · <phrase>`）或 `Not watching`
- **状态标签表**（`src/tui-logic.ts` 的 `WATCH_STATE_LABELS`）：侧栏 `🎯` 行与 status toast **共用**同一张表，同一状态在两处显示一致

  | 内部状态 | 用户可见标签 |
  |---|---|
  | `watching` | `on watch` |
  | `confirming` | `review round` |
  | `paused` | `on hold` |
  | `stopped` | `stopped` |
  | `done` | `finished` |
  | 其它（新版宿主新增的状态） | `unknown state (<原始值>)` |

  - 内部枚举值**不直接暴露给用户**——`watching` / `confirming` 这类协议字段只出现在服务端与文档的协议语境里
  - 未知状态回退成**可见的原始值**，不是空白：用户能看出「宿主发了个本版 TUI 不认识的状态」
  - 查表走 **own-property 检查**（`Object.hasOwn`）：状态字符串从 RPC 边界进来时**无类型**，裸查表会命中 `Object.prototype` 的键（`constructor` / `toString`），把 `function Object() { [native code] }` 渲染到侧栏和 toast 上
