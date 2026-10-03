# /autocontinue 命令

每会话手动开关的 slash 命令（prefix `autocontinue`，别名 `/ac`）。命令不在 server 注册，由 TUI 的 keymap slash 命令捕获，调 RPC 完成开关，再 toast + footer 展示。

## 命令

| 命令 | 动作 |
|---|---|
| `/autocontinue on` | 开启当前会话值守（写入 storage） |
| `/autocontinue off` | 关闭当前会话值守（移除 storage 记录） |
| `/autocontinue status` | 查看当前会话值守状态 |

## 命令链路

```
TUI keymap slash 命令（/autocontinue on）
  → rpc.set({ enabled: true })          ← RPC id "autocontinue"
  → server 持久化到 ctx.storage
  → 事件 autocontinue.state.changed 广播
  → TUI toast「值守已开启」+ footer 刷新
```

- `on`：watch(sessionID)，写入 storage，计数归零
- `off`：unwatch(sessionID)，删除 storage 记录
- `status`：读取当前会话状态（值守中 / 已完成 / 已停止 + 次数）

## RPC 契约

| 项 | 值 |
|---|---|
| id | `autocontinue` |
| methods | `set{enabled}` / `status{perSession}` / `list` |
| events | `state.changed{sessionID, state, consecutive}` |

## 注意事项

- 只对**用户主动值守**的会话生效，不做全局自动跑
- keymap 层必须从 `app` slot render（组件作用域）注册；直接在 `setup()` 调用会抛 `Keymap.Provider is missing`（详见 [runtime-lessons.md](../architecture/runtime-lessons.md)）