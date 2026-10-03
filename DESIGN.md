# opencode-autocontinue — DESIGN

V2 服务端 + TUI 插件：自动续跑"总任务未完成就被中断"的会话。

## 1. 目标与边界

**目标**：会话因任何非用户原因中断（`bad_response_status_code` 等模型错误、阶段完成空闲、
网络抖动、工具失败……）而**总任务未完成**时，自动注入用户可自定义的续跑消息，让 agent 继续。
默认消息：
`继续执行。审视已完成的功能是否存在bug，未实现的功能是否有安排好的执行计划`

**边界（不做）**：
- 不做 AI 判断"任务是否完成"（用完成标记 + 次数兜底，更可控、零额外模型成本）。
- 不接管 opencode-bridge 的运行时（只对会话层面续跑）。
- 不做 TUI 的复杂面板；只做 footer 状态指示（值守中/已停）+ toast 反馈。
- 只对**用户主动值守**的会话生效（会话内 `/autocontinue on|off`），不全局自动跑。

## 1.5 目录树

```
opencode-autocontinue/
├── package.json          # type:module; exports "."→src/index.ts, "./tui"→src/tui.tsx
├── tsconfig.json         # 仅 typecheck 用（运行时无需构建）
├── .gitignore            # node_modules / dist / *.local.md
├── README.md             # 安装/更新/卸载/验证/排障
├── DESIGN.md             # 本文档
├── tasks.md              # 任务清单
└── src/
    ├── index.ts          # server 入口：Plugin.define({id, setup})
    ├── tui.tsx           # TUI 入口：slash 命令 + footer 状态 slot（/** @jsxImportSource @opentui/solid */）
    ├── rpc.ts            # Rpc.define：set / status / list + state.changed 事件
    ├── config.ts         # JSONC 配置加载（全局 + 项目覆盖，deep merge）
    ├── state.ts          # 值守状态：ctx.storage 持久化 + 内存锁
    ├── events.ts         # 事件解析：sessionID 双兼容 / error 提取 / 完成标记正则
    ├── engine.ts         # 核心判定：retry hook、错误/空闲调度、节流、时段、排除
    └── prompt.ts         # 续跑消息模板渲染 + session.prompt 注入
```

## 2. 架构

```
┌────────────────────────────────────────────────────────────┐
│ OpenCode 后台服务                                            │
│                                                            │
│  ┌──────────────────────────────────────────┐              │
│  │ server plugin (src/index.ts)            │              │
│  │  · retry hook        → 错误改可重试+退避  │              │
│  │  · event.subscribe   → session.* 事件    │              │
│  │  · 值守列表(持久化)    → storage           │              │
│  │  · 续跑调度          → 延迟/节流/次数/时段 │              │
│  │  · session.prompt    → 注入续跑消息       │              │
│  └──────────────────────────────────────────┘              │
│            ▲ 订阅事件 / 回调            │ RPC 状态查询        │
│  ┌─────────┴───────────────┐  ┌─────────▼───────────────┐  │
│  │ TUI plugin (src/tui.ts) │  │                        │  │
│  │  · footer.status slot   │  │  RPC (src/rpc.ts)      │  │
│  │  · /autocontinue 命令   │◄─┤  · on/off/status        │  │
│  │  · toast 反馈           │  │  · 读取值守状态          │  │
│  └─────────────────────────┘  └────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

- **server**：权威逻辑所在（值守判定、节流、时段、续跑），只监听事件 + 提供 RPC。
- **TUI**：命令入口 + 状态展示。命令不在 server 注册（避免 server 无 UI 上下文），
  由 TUI 的 keymap slash 命令调 RPC 完成开关，再 toast + footer 展示。
- **RPC**：server 与 TUI 同进程内可通过 `ctx.rpc()` 直接调用；跨进程用 HTTP client。
  事件 `autocontinue.state.changed` 让 TUI 刷新 footer。

## 3. 数据流

1. 用户在某会话输入 `/autocontinue on` → TUI slash 命令捕获 → `rpc.set(true)` →
   server 持久化到 storage → TUI toast「值守已开启」+ footer 更新为值守状态。
2. agent 工作中某模型调用失败（如 `bad_response_status_code`）→
   `ctx.session.hook("retry")` 判定瞬时错误 → 改 `retry:true` + 指数退避 →
   尽量在调用层恢复，不产生续跑消息。
3. 若 retry 层仍未救回（最终失败 / 阶段完成空闲）→ 收到 `session.error` 或 `session.idle` →
   server 检查：会话是否值守中？是否被排除？是否到结束时段？是否在节流内？距上次
   真实用户消息是否足够久？→ 全部通过 → `session.prompt` 注入续跑消息（resume:true）。
4. agent 输出完成标记（如 `[任务完成]`）→ server 从 `message.updated` 检出 → 停止续跑、
   footer 显示「已完成」。
5. 连续续跑达 `maxConsecutive` 或到 `endTime` → 停止，footer 显示「已停止」。

## 3.5 交互顺序

```sequence
用户        TUI插件        server插件         storage         opencode服务/模型
 │  /autocontinue on  │               │                │              │
 │───────────────────▶│  rpc.set(true) │               │              │
 │                    │───────────────▶│  watch(session) │             │
 │                    │               │────────────────▶│              │
 │                    │               │  state.changed   │             │
 │                    │◀──────────────│                  │             │
 │  toast + footer◀──│               │                  │              │
 │                    │               │                  │ 模型调用失败  │
 │                    │               │◀─────────────────│ bad_response_status_code
 │                    │               │ retry hook: 改重试+退避           │
 │                    │               │─────────────────────────────────▶│
 │                    │               │ （重试成功→无事发生）             │
 │                    │               │ 最终失败→session.error           │
 │                    │◀──────────────│                  │              │
 │                    │  idle → 判定通过 → session.prompt(续跑消息)       │
 │                    │               │─────────────────────────────────▶│
 │                    │               │  agent 输出完成标记               │
 │                    │               │◀─────────────────────────────────│
 │                    │◀─ state.changed(done)                           │
 │  footer 更新◀────│               │                  │              │
```

## 4. 事件词汇（已实测/文档确认）

| 事件/钩子 | 用途 |
|---|---|
| `ctx.session.hook("retry", ...)` | 改瞬时错误的 retry 决策（第一道防线） |
| `session.error` | 会话级错误（含 provider error） |
| `message.updated` | 看 assistant 消息是否带 error、是否含完成标记 |
| `session.idle` | 空闲（阶段完成/停摆）→ 触发续跑判定 |
| `session.status` | 跟踪 busy/idle，防在运行中注入 |
| `session.deleted` | 清理会话状态 |
| `session.created` / `session.updated` | 识别会话标题（排除关键词） |

> 实测注意：V2 事件载荷形状（`event.sessionID` 平铺 或 `event.properties` 嵌套）
> 以运行时为准；`sessionIDFromEvent` 双兼容（参考 herdr 插件已确认的做法）。

## 5. 配置

全局：`~/.config/opencode/opencode-autocontinue.jsonc`（项目 `.opencode/` 同名可覆盖，deep merge）。

```jsonc
{
  "enabled": true,                    // 总开关
  "message": "继续执行。审视已完成的功能是否存在bug，未实现的功能是否有安排好的执行计划",
  "endTime": "08:30",                 // 到点全局停止（HH:MM，当天已过则次日）
  "startTime": "22:00",               // 可选：早于该时间不自动续跑
  "idleDelayMs": 15000,               // 空闲后延迟注入
  "minIntervalMs": 30000,             // 同会话最小续跑间隔
  "maxConsecutive": 20,               // 最大连续续跑次数
  "completionMarkers": [
    "[任务完成]", "[夜间任务完成]", "[task done]", "<promise>DONE</promise>"
  ],
  "errorPatterns": [                  // 错误续跑匹配（大小写不敏感子串）
    "bad_response_status_code", "bad request", "429", "5", "ECONNRESET",
    "ECONNREFUSED", "timeout", "aborted by", "ContextOverflow", "too large to compact"
  ],
  "excludePatterns": [                // 绝不续跑（用户主动中止）
    "MessageAbortedError", "operation was aborted"
  ],
  "excludeTitleKeywords": ["测试"],    // 标题含这些词不续跑
  "userGraceMs": 300000,              // 用户最近发真实消息后 N ms 内不自动续跑
  "markerRegex": ""                    // 可选：完全自定义完成标记正则（覆盖默认）
}
```

环境变量：`OC_AUTOCONTINUE=0` 完全禁用插件。

## 6. 状态与持久化

server storage（`ctx.storage.set/get`，跨重启）：
```json
{
  "watched": { "ses_xxx": { "since": 1730000000000, "consecutive": 3, "lastInjectedAt": 1730000060000, "state": "watching|stopped|done" } }
}
```
- `watched` 键由 `/autocontinue on` 写入、`off` 删除。
- `consecutive` 在真实用户消息/完成任务时归零。

## 7. 防重/防冲突

- **单实例续跑**：同一会话同一时刻只允许一个在途注入（`inFlight` 锁）。
- **双事件防重**：`session.error` 与 `message.updated(error)` 可能同时来，用
  `pendingContinue` 标记去重，只在 idle 时统一发送。
- **不与其他插件冲突**：herdr 等插件只读事件上报；本插件不改会话、不删消息。
- **不打断运行中会话**：`session.status` 非 idle 时绝不注入，轮询等待。

## 8. 完成判定（停止条件）

- 最后一条 assistant 消息的文本匹配任一 `completionMarkers`（或 `markerRegex`）→ 停。
- `consecutive >= maxConsecutive` → 停（footer 显示已停止）。
- 到达 `endTime` → 全局停。
- 用户手动 `/autocontinue off` → 停。
- `MessageAbortedError` / `operation was aborted` / `session.interrupt` → 停且不清除
  值守标记（用户可重新 on）。

## 9. TUI 展示

- **footer**：`prompt.footer.status` slot 显示 `[AC ●]`（值守中）/ `[AC ○]`（未值守）
  / `[AC ⏸ N]`（已停，N 次）。当前会话是否值守由 `context.data.session.get(id)` +
  RPC 状态缓存决定。
- **toast**：on/off/续跑/停止/出错 时 toast 提示。
- **命令**：`/autocontinue on|off|status`（slash，prefix `autocontinue`）。

## 10. 验证方法

- `npx esbuild src/tui.tsx --loader:.tsx=tsx --jsx=automatic` 通过。
- server: 语法检查 `node --check src/index.ts`（server 为纯 TS，用 esbuild 打包验证）。
- 本地 `file://` 加载，重启后：
  - `/autocontinue on` → toast + footer 出现；`/autocontinue status` 正确。
  - 用 `opencode api` 造一个错误/空闲事件（或真实触发）→ 验证续跑消息注入。
  - 输出完成标记 → 停止。
  - `off` → 移除值守，footer 更新。
- 卸载干净：`plugin remove` 后无残留 interval/订阅（cleanup 返回 dispose）。

## 11. 已知限制

- 插件需 opencode 服务存活；服务重启后 storage 仍在但内存态（定时器/在途）丢失，会从
  storage 恢复值守列表。
- `session.error` 事件载荷形状随版本变动，实现用双兼容解析 + 单测锁定当前版本。
- retry hook 的 `bad_response_status_code` 分类依赖 opencode 对错误类型的判定；
  retry 决策仅影响"该次模型调用"，最终失败仍走会话级续跑兜底。