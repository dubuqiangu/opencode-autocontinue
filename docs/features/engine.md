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

收到 `session.error` / `session.idle` 后依次检查，全部通过才注入：

1. 会话是否在值守名单？（`inFlight` 锁在入口即置位，防并发重复注入）
2. 是否被排除（`excludePatterns` / 标题关键词 / 用户最近消息宽限期）？
3. 是否在值守时段窗口（`startTime` ~ `endTime`）？
4. 是否在节流内（距上次注入 < `minIntervalMs`）？
5. 距上次真实用户消息是否足够久（> `userGraceMs`）？
6. 会话当前是否非 busy？（`session.status` 非 idle 时绝不注入，轮询等待）

通过 → `session.prompt({sessionID, text})` 注入续跑消息（`resume: true`）。

**并发防护**：`tryInject` 入口即置 `inFlight`，中间有多个 `await`（解析标题、取最新消息），并发事件/定时器不会再通过检查。注入前还会复查会话仍处于 `watching`——`await` 期间可能已被 unwatch / markDone / markStopped，此时放弃注入。

## 完成检测（停止条件）

| 停止条件 | 说明 |
|---|---|
| 完成标记 | 最后一条 assistant 消息命中 `completionMarkers`（或 `markerRegex`）→ `done` |
| 最大连续次数 | `consecutive >= maxConsecutive`（默认 20）→ 停止 |
| 值守时段 | 到达 `endTime`（watch 时冻结 endAt；跨午夜窗口如 22:00→08:30 会自动滚动到次日，非跨日窗口当天已过立即停止）→ 停止 |
| 用户手动 off | `/autocontinue off` → 停止 |
| 用户主动中止 | `MessageAbortedError` / `operation was aborted` / `session.interrupt` → 停止但保留值守标记（可重新 on） |

## 防重 / 防冲突

- **单实例续跑**：同一会话同一时刻只允许一个在途注入（`inFlight` 锁）
- **双事件防重**：`session.error` 与 `message.updated(error)` 可能同时到达，用 `pendingContinue` 标记去重，只在 idle 时统一发送
- **不打断运行中会话**：`session.status` 非 idle 时绝不注入，轮询等待
- **不与其他插件冲突**：本插件不改会话、不删消息，只读事件 + 注入 prompt