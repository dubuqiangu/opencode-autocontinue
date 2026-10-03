# footer 状态指示

挂载点：`prompt.footer.status`（append 模式，不覆盖原生状态行）。

## 状态与图标

| 状态 | 显示 | 条件 |
|---|---|---|
| 值守中 | `[AC ●]` | 当前会话已 `/autocontinue on`，正在值守 |
| 未值守 | `[AC ○]` | 当前会话未开启值守 |
| 已完成 | `[AC ✓]` | 助手消息命中完成标记，已停止续跑 |
| 已停止 | `[AC ⏸ N]` | 达最大续跑次数 / 时段窗口关闭而停止，N = 已续跑次数 |

## 刷新机制

- 订阅 RPC 事件 `autocontinue.state.changed`，状态变化即时刷新
- 当前会话是否值守：`context.data.session.get(id)` + RPC 状态缓存决定
- 会话 ID 来源：`slotProps.sessionID`，回退 `context.ui.router.current().params.sessionID`

## 配套反馈

- 开启/关闭/续跑注入/停止/出错时 toast 提示
- 当前会话 title 命中排除关键词时高亮提示