# 代码模块结构

入口只做组装，按功能维度解耦；改一处功能只碰一个文件。

```
src/
  index.ts    server 入口：Plugin.define({id, setup}) + RPC 注册 + 事件订阅
  tui.tsx     TUI 入口：slash 命令 + footer 状态 slot（@jsxImportSource @opentui/solid）
  rpc.ts      Rpc.define：set / status / list + state.changed 事件
  config.ts   JSONC 配置加载（全局 + 项目覆盖，deep merge，BOM 容错）
  state.ts    值守状态：ctx.storage 持久化 + 内存锁（inFlight/pending）
  events.ts   事件解析：sessionID 双兼容 / error 提取 / 完成标记正则
  engine.ts   核心判定：retry hook、错误/空闲调度、节流、时段、排除
  prompt.ts   续跑消息模板渲染 + session.prompt 注入
```

## 模块职责

| 模块 | 职责 | 依赖 |
|---|---|---|
| `index.ts` | 组装：注册 RPC + hook + 事件订阅 + 清理 | rpc / engine / state |
| `tui.tsx` | 命令入口 + footer 展示 + toast | rpc（跨进程走 HTTP client） |
| `rpc.ts` | `set{enabled}` / `status{perSession}` / `list` + `state.changed` | state |
| `config.ts` | 配置加载/合并/归一 | — |
| `state.ts` | watched map 持久化 + 内存锁 | storage / config |
| `events.ts` | 载荷解析（纯函数，可单测） | — |
| `engine.ts` | 判定矩阵 + 调度 + 注入 | state / events / config / prompt |
| `prompt.ts` | 消息模板渲染（`{time}` `{remaining}`） | — |

## 边界

- `package.json` 为 `type: module`；exports `"."` → server、`"./tui"` → TUI
- `tsconfig.json` 仅 typecheck 用（运行时无需构建，直接加载 TS）