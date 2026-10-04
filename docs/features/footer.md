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
| 值守中 | `Watch` + `⏱ 3m 22s` / `🔁 0 resumes` / `🎯 watching` | 会话已开启值守，⏱ 为已值守时长 |
| 已停止 | `Watch` + `⏱ ⏸` / `🔁 N resumes` / `🎯 stopped` | 达上限 / 时段关闭而停止 |
| 已完成 | `Watch` + `⏱ ✓` / `🔁 N resumes` / `🎯 done` | 命中完成标记 |
| 未值守 | 不渲染（返回 null，不占位） | 未 `/autocontinue on` |

- 全英文标签（图标 + 英文单词），与 usage-meter 右侧栏风格一致
- `⏱` 时长每 1s 刷新（仅当状态为 `watching` 时跑定时器）

## 刷新机制

- **每会话独立状态**：TUI 维护 `Record<sessionID, status>` 的每会话状态表，不是单个全局信号——多会话同时值守互不覆盖（A 的标记不会因开启 B 而消失）
- **动态读走 createMemo**：footer/sidebar 的渲染文本全部在 `createMemo` 内计算，信号变化即时触发 JSX 重渲染（无需切 session 才刷新；对应 usage-meter v0.7.8 修复的同款问题）
- 订阅 RPC 事件 `autocontinue.state.changed`，状态变化更新对应会话的表项
- 会话 ID 来源：`slotProps.sessionID`，回退 `lastSlotSessionID`（slot 缓存）→ `context.ui.router.current().params.sessionID`

## 配套反馈

- 开启/关闭/续跑注入/停止/出错时 toast 提示（全英文）
- `/autocontinue status` 直接读 RPC 结果（不经可能过期的信号），显示 `Watching · <state> · N resumes` 或 `Not watching`