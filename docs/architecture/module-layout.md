# 代码模块结构

入口只做组装，按功能维度解耦；改一处功能只碰一个文件。

```
src/
  index.ts    server 入口：Plugin.define({id, setup}) + RPC 注册 + 事件订阅
  tui.tsx     TUI 入口：slash 命令 + footer 状态 slot + 右侧栏块（@jsxImportSource @opentui/solid）
  rpc.ts      AUTOCONTINUE_RPC_CONTRACT（普通对象）：set / status / list + state.changed 事件
  config.ts   JSONC 配置加载（全局 + 项目覆盖，deep merge，BOM 容错）
  state.ts    值守状态：ctx.storage 持久化 + 内存锁（inFlight/pending/verifying）
  events.ts   事件解析：sessionID 双兼容 / error 提取 / 完成标记正则 / 哨兵匹配
  engine.ts   核心判定：retry hook、错误/空闲调度、节流、时段、排除、验证闸门
  verify.ts   验证命令运行：argv 构造 / 子进程 spawn + 超时杀进程树 / 输出截断清洗
  prompt.ts   续跑消息模板渲染 + session.prompt 注入
  reactive-mount.ts  TUI slot 反应式挂载（reactiveElement 模式：createElement + insert）
  session-resolution.ts  TUI 会话 ID 解析链：JSX props 解包 → slot 缓存 → router（纯函数）
```

## 模块职责

| 模块 | 职责 | 依赖 |
|---|---|---|
| `index.ts` | 组装：注册 RPC + hook + 事件订阅 + 清理 | rpc / engine / state |
| `tui.tsx` | 命令入口 + footer 展示 + 右侧栏块 + toast | rpc（跨进程走 HTTP client） |
| `session-resolution.ts` | TUI 会话 ID 解析链（纯函数，可单测） | — |
| `reactive-mount.ts` | TUI slot 反应式挂载 | — |
| `rpc.ts` | `set{enabled}` / `status{perSession}` / `list` + `state.changed` | state |
| `config.ts` | 配置加载/合并/归一 | — |
| `state.ts` | watched map 持久化 + 内存锁 | storage / config |
| `events.ts` | 载荷解析 + 哨兵匹配（纯函数，可单测） | — |
| `engine.ts` | 判定矩阵 + 调度 + 注入 + 验证闸门 | state / events / config / prompt / verify |
| `verify.ts` | 验证命令 spawn + 输出截断清洗 | — |
| `prompt.ts` | 消息模板渲染（`{time}` `{remaining}`） | — |

## 边界

- `package.json` 为 `type: module`；exports `"."` → server、`"./tui"` → TUI
- `tsconfig.json` 仅 typecheck 用（运行时无需构建，直接加载 TS）
