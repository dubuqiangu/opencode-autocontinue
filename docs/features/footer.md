# footer 状态指示 + 右侧栏值守块

## footer 状态指示

挂载点：`prompt.footer.status`（append 模式，不覆盖原生状态行）。

### 状态与图标

| 状态 | 显示 | 条件 |
|---|---|---|
| 值守中 | `[AC ●]` | 当前会话已 `/autocontinue on`，正在值守 |
| 已完成 | `[AC ✓]` | 助手消息命中完成标记，已停止续跑 |
| 已停止 | `[AC ⏸ N]` | 达最大续跑次数 / 时段窗口关闭而停止，N = 已续跑次数 |

未值守的会话不渲染任何 footer 指示（返回 null，不占位）。

## 右侧栏值守块

挂载点：`sidebar.content`（append 模式，与原生 Context/MCP 段同通道，落于其下）。

| 状态 | 显示 | 条件 |
|---|---|---|
| 值守中 | `Watch` + `⏱ 3m 22s` / `🔁 N injections` / `🎯 watching\|confirming` | 值守进行中（`watching` / 复查轮 `confirming`），⏱ 为已值守时长 |
| 终态 / 未值守 | 不渲染（返回 null，不占位） | `done` / `stopped`，或未 `/autocontinue on` |

- 全英文标签（图标 + 英文单词），与 usage-meter 右侧栏风格一致
- `⏱` 时长每 1s 刷新（状态为 `watching` / `confirming` 时跑定时器）
- 侧栏块只承载"值守进行中"；终态反馈由 footer 指示符（`[AC ✓]` / `[AC ⏸ N]`）与命令 toast 承载——终态行曾在此渲染且跨重启复活，导致每个历史值守过的会话常驻 Watch 块（v0.3.6 修复）

## 刷新机制

- **每会话独立状态**：TUI 维护 `Record<sessionID, status>` 的每会话状态表，不是单个全局信号——多会话同时值守互不覆盖（A 的标记不会因开启 B 而消失）
- **动态读走 createMemo**：footer/sidebar 的渲染文本全部在 `createMemo` 内计算，信号变化即时触发 JSX 重渲染（无需切 session 才刷新；对应 usage-meter v0.7.8 修复的同款问题）
- 订阅 RPC 事件 `autocontinue.state.changed`，状态变化更新对应会话的表项
- 会话 ID 来源：`slotProps.sessionID`（JSX 函数组件收到的是 props 包装对象，须先解包再读——v0.3.6 前直接读包装层导致 `lastSlotSessionID` 永不缓存，`/autocontinue` 报「No current session」），回退 `lastSlotSessionID`（slot 缓存）→ `context.ui.router.current().params.sessionID`

## 配套反馈

- 开启/关闭/续跑注入/停止/出错时 toast 提示（全英文）
- `/autocontinue status` 直接读 RPC 结果（不经可能过期的信号），显示 `Watching · <state> · N resumes` 或 `Not watching`