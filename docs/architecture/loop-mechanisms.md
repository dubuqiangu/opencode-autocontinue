# 续跑机制规格（现行行为与历史修复规格）

本文是 opencode-autocontinue **现行实现**的准确规格：每个判定环节的输入、判据、产出与落点，
以及各版本修复规格的归档（每条注明「已发布」与「历史（已归档）」）。

配套文档：

- [provenance-and-loop.md](provenance-and-loop.md)——决策与裁定索引（为什么这么定、哪些方案被否决）。
- [loop-evidence.md](loop-evidence.md)——取证与历史轮次（机制来源、上游比对、逐版本落地记录）。
- [events-and-state.md](events-and-state.md)——事件词汇、持久化字段与状态机图。

本文描述的是**代码当前真实在做的事**，不描述设想。§9 归档 v0.5.3 的修复规格与验收口径
（各条**已发布**，逐条给出当前行为），§10 记录 v0.5.4 的内部增量，§11 记录 v0.5.5 的增量。

## 目录

- [§1 注入溯源](#1-注入溯源)
- [§2 自回声兜底](#2-自回声兜底)
- [§3 验证驱动 Loop](#3-验证驱动-loop)
- [§4 哨兵与 paused 状态](#4-哨兵与-paused-状态)
- [§5 挫败感触发](#5-挫败感触发)
- [§6 无人值守护栏与停止原因](#6-无人值守护栏与停止原因)
- [§7 完成判定](#7-完成判定)
- [§8 停止路径总表](#8-停止路径总表)
- [§9 v0.5.3 修复规格](#9-v053-修复规格)
- [§10 v0.5.4 增量](#10-v054-增量)
- [§11 v0.5.5 增量](#11-v055-增量)

---

## 1. 注入溯源

### 1.1 问题

插件把续跑消息用 `session.prompt({sessionID, text})` 注入纯文本，宿主把它落库为
`type:"user"`。引擎的 user 分支只看类型不看来源，于是**插件自己的注入被当成真实用户消息**，
触发 `store.resume(sessionID, true)`：

- 本轮 `injections` 立刻归零 → `maxConsecutive` 停止保障失效；
- 每次注入都误设 `userGraceMs` 安静期，续跑节奏被自己的注入打断。

### 1.2 现行实现

溯源标记定义在 `src/prompt.ts`：

```ts
export const PROVENANCE_ORIGIN = "opencode-autocontinue"
export const PROVENANCE_KIND = "continuation"
export const PROVENANCE_METADATA: Record<string, unknown> = {
  origin: PROVENANCE_ORIGIN,
  kind: PROVENANCE_KIND,
}
export function isPluginInjection(metadata: unknown): boolean
```

注入函数 `injectContinuation`（`src/prompt.ts`）的通道优先级：

1. 宿主提供 `session.synthetic` 时，用 `session.synthetic({ sessionID, text, description, metadata, resume: true })`
   —— 落库为 `type:"synthetic"`，与真实用户消息结构上可区分；
2. `synthetic` 缺失或抛错时，回退 `session.prompt({ sessionID, text, metadata })`——靠 `metadata` 区分。

两路都带 `PROVENANCE_METADATA`，因此计数修复**不依赖**宿主是否提供 `synthetic`。
函数返回**实际发送的渲染文本**，供 §2 的自回声守卫比对。

引擎侧判来源（`src/engine.ts` 的 user 分支）按三层兜底读取 metadata：

- V2 inbox 形状：`item.payload.metadata ?? item.metadata ?? info.metadata`；
- V1 info 形状：`info.payload.metadata ?? info.metadata`。

命中 `isPluginInjection(...)` 的消息**不进入** `resume()`，也不算真实用户消息。

### 1.3 边界

`synthetic` 的 `resume` 语义与 `metadata` 是否回流到引擎，属未确认的宿主行为假设。
因此 §2 的自回声兜底是必需的，不是冗余。

---

## 2. 自回声兜底

`metadata` / `synthetic` 是否真的回流到引擎稍后读到的消息，无法保证。故引擎记录**自己何时注入过**，
用「自回声」作 host-agnostic 保底判定。

- `InMemoryState.lastSelfInjection?: { text: string; at: number }`（`src/state.ts` 的 `InMemoryState`）。
- `injectAndRecord`（`src/engine.ts` 的注入漏斗）在 `injectContinuation` 成功后立即记录
  `{ text: 实际发送的完整文本, at: Date.now() }`。
- 判定顺序：`isPluginInjection(metadata)` → 回声 → 真实用户。
- 回声判定（`src/engine.ts` 的 `isSelfEcho`）共**三条规则**：
  1. **文本相同判回声**——入站文本**可提取**，且与记录文本**逐字相等**。
  2. **文本不同绝不误吞**——入站文本**可提取**但与记录文本**不同** → **一定不是**回声，
     按真实用户消息处理（走 `resume()`、挫败感检测等真实用户路径）。
  3. **无文本按时间窗兜底**——入站文本**提取不到**（缺失或空串），且
     `Date.now() - lastSelfInjection.at <= selfEchoWindowMs`（默认 10s，`src/config.ts` 的
     `selfEchoWindowMs`）→ 判为回声。
- 文本提取：V2 inbox 分支取 `item.payload.text`；V1 info 分支拼接文本 part。
- 命中回声：跳过 `resume()` 与 `lastUserMessageAt`，等同 `metadata` 路径处理。
- **回声幂等（v0.5.5）**：注入记录在**整个 `selfEchoWindowMs` 窗口内保持有效**，不在首次命中时清除。
  宿主可能把同一条注入以**两种事件形状**各投递一次（例如 `message.updated` 与
  `session.inbox.enqueued`），第二次投递同样被判为回声——不触发 `resume()`，也不清零
  **注入上限 / 验证失败计数 / 轮次墙钟**三重上界。

### 2.1 已知限制

- 真实用户在注入后 10s 内发出**逐字相同**的消息会被误判为回声——概率可忽略。
- **时间窗兜底的残留风险**：真实用户消息若落在 `selfEchoWindowMs` 窗口内、且宿主**不提供
  可提取文本**，会被第 3 条规则判为回声而**未被处理**（既不 `resume()`，也不进入真实用户路径）。
  引擎侧无法进一步收窄——没有文本就没有可比对的依据；调小 `selfEchoWindowMs` 可降低触发概率。

---

## 3. 验证驱动 Loop

`verifyCommand` 非空即进入 Loop 模式；为空时行为与 v0.3.x 完全一致。

### 3.1 语义

完成**不再只认模型自报**。模型给出完成信号（完成标记 / `doneSentinel`）时才运行验证命令，
按 **exit code** 判定：

- 通过 → `done`；
- 不通过 → 计一次 `rejections` 并注入升级提示续跑。

**无完成信号的空闲轮不触发验证**（否则干净树上的 `npm test` 会立刻误判 done）。
verify 模式下完成信号只用于「触发验证」，不再用于「判定完成」。

### 3.2 相关配置（`src/config.ts`）

| 键 | 默认 | 说明 |
|---|---|---|
| `verifyCommand` | `""` | 验证命令；空 = 关闭 Loop 模式 |
| `verifyTimeoutMs` | `120000` | 单次验证超时；钳制 `1000..3600000` |
| `verifyMaxIterations` | `50` | 失败轮次上限；钳制 `0..10000`，`0` = 不限 |
| `verifyCwd` | `""` | 验证工作目录；空 = `ctx.location.directory` |
| `selfEchoWindowMs` | `10000` | §2 自回声时间窗；钳制 `>= 0` |

### 3.3 验证执行（`src/verify.ts`）

- `verificationArgv(command, platform)`：
  - win32 → `["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command]`；
  - 其它 → `["/bin/sh", "-c", command]`。
- `pass = !timedOut && !spawnUnavailable && exitCode === 0`。
- **降级**：命令**无法启动**（`spawnUnavailable`）→ `pass = true`，沿用模型的完成信号，
  避免无限升级；只有命令成功启动但退出码非 0 才计失败。
- **输出上限**：`STREAM_MAX_BYTES = 8 * 1024`（每流），`appendBoundedCapped` 按 UTF-8 字节
  保留头一半 + 尾一半，中间以省略标记连接；`buildVerifyDetail` 再做一次权威 8KB 头尾截断，
  头部附**不可信数据声明行**。
- **超时与中止**：先温和终止（`GRACE_MS = 1_000` 后强杀进程树），win32 用
  `taskkill /F /T`，POSIX 用 `detached` + `process.kill(-pid, "SIGKILL")`；
  grace 定时器被跟踪并在结束时 `clearTimeout`，另有兜底定时器保证 Promise 一定 resolve。
- **增量解码**：stdout/stderr 各用一个 `StringDecoder("utf8")`，避免跨 chunk 的多字节字符被替换为 U+FFFD。

### 3.4 门控与陈旧结果丢弃（`src/engine.ts` 的 `runVerifyGate`）

- **未配置 `verifyCommand`**：走既有逻辑（标记 → finalCheck / done；否则注入 `message`）。
- **有完成信号**时，执行顺序为：
  1. **命令前快照复检**（TOCTOU 防护）：在创建 `AbortController` **之前**重取
     `store.getState(sessionID)`，校验 state ∈ {`watching`, `confirming`}、且
     `lastUserMessageAt` 不落在 `userGraceMs` 内，再记录 `roundBefore = freshGate.roundId`。
     （`entry` 是 await 之前捕获的活对象引用，期间真实用户消息会经 `resume()` 就地 bump
     `roundId`，直接读它会把**新**轮号记成旧轮号。）
  2. 运行验证命令，携带 `AbortSignal`（off / dispose / 新用户轮时中止）。
  3. **命令后 staleness 复检**：`!disposed`、state 仍在 {`watching`, `confirming`}、
     `roundId === roundBefore`、`endAt` 未过期、墙钟预算未耗尽；任一不满足 → 丢弃结果，
     **不注入、不判 done**。
  4. `pass` → `markDone` + `emitChanged("done")`。
  5. `!pass` → `recordRejection()` 后**再判上限**（verify-then-cap）：
     `verifyMaxIterations > 0 && rejections >= verifyMaxIterations` → `markStopped(sessionID, "verify-limit")`；
     否则用 `composeRejectionPrompt` 组装提示、附 `verify.detail` 后注入并 `recordInjection`。
- **无完成信号**时：不跑验证，只按既有逻辑注入 `message`（同样做注入前复检）。
- **事件路径不得绕过验证**：verify 模式下，assistant 完成分支只调度一次短延迟注入，
  结论一律交给 `maybeInject` 的验证闸门。

### 3.5 升级提示（轮次压力梯）

`escalationMessages`（整条替换两档）已于 v0.5.0 删除（breaking）。现行形态是
「基础 `message` + 压力梯 + 阈值追加」：

- `selectPressureMessage(ladder, rejections)`（`src/engine.ts`）：分档
  `<=3 / <=7 / <=15 / <=30 / <=50 / else`，梯子更短时钳到最后一行，空数组返回 `""`。
- `composeRejectionPrompt(pluginConfig, rejections)`（`src/engine.ts`）：

  ```ts
  const lines = [pluginConfig.message, `🚫 验证未通过（连续第 ${rejections} 次）。`]
  const pressure = selectPressureMessage(pluginConfig.escalationPressureLadder, rejections)
  if (pressure) lines.push(pressure)
  if (rejections >= 3 && pluginConfig.escalationReassessMessage) lines.push(pluginConfig.escalationReassessMessage)
  if (rejections >= 5 && pluginConfig.escalationRootCauseMessage) lines.push(pluginConfig.escalationRootCauseMessage)
  return lines.join("\n")
  ```

### 3.6 安全边界

- 验证输出是**不可信数据**：注入时带显式声明行，且**哨兵与完成标记检测只读 assistant 消息，
  绝不扫描 `verify.detail`**（否则验证输出可自我终止循环）。
- 输出先 `stripControlChars` 再做头尾截断。
- Windows 用 `-NoProfile -NonInteractive`，避免用户 profile 改变行为或命令交互挂起。
- 命令来自本地配置而非模型输出，**无命令注入面**；但子进程继承宿主 env，输出可能回显敏感值
  —— 已知限制，不做密钥模式脱敏。

---

## 4. 哨兵与 paused 状态

### 4.1 配置与匹配

| 键 | 默认 | 说明 |
|---|---|---|
| `abortSentinelTag` | `"loop-abort"` | 成对标签名；空串禁用 |
| `pauseSentinelTag` | `"loop-pause"` | 成对标签名；空串禁用 |

`matchSentinel(text, tag)`（`src/events.ts`）对 tag 做正则转义后构造
`<tag>([\s\S]+?)</tag>`：必须**成对**、夹注**非空**、**大小写敏感**（无 `i` 标志）；
空 tag 返回 `undefined`。

### 4.2 判定位置与顺序

哨兵判定在 `maybeInject` 内、验证闸门**之前**，verify 与非 verify 模式统一：

1. **abort** 哨兵 → `markStopped(sessionID, "abort-sentinel")` + `clearTimer` + `stopInterval`
   + `emit("stopped")`，**不注入**。
2. **backgroundWorkRunning 守卫**（后台子代理/任务仍在跑 → 不判 done、不注入）。
3. **pause** 哨兵 → `markPaused(sessionID)` + `clearTimer` + `stopInterval` + `emit("paused")`，
   **不注入**。

abort 在后台守卫**之前**、pause 在守卫**之后**：显式放弃必须立即生效，而暂停不必打断在飞的工作。

### 4.3 paused 状态

- `WatchState["state"]` 联合含 `"paused"`（`src/rpc.ts`）。
- `markPaused(sessionID)` 把 state 置 `paused` 并持久化。
- `hydrate()` 保留 `paused`（等待用户输入的**活动**值守），丢弃终态 `done` / `stopped`。
- 真实用户消息经 `store.resume()` 把 state 翻回 `watching`，并由引擎重新 `scheduleInterval`，
  值守自然恢复。
- `maybeInject` 顶部守卫只放行 `watching` / `confirming`，`paused` 会走 `stopInterval` + return，
  **不会注入**——无需额外分支。
- TUI：`paused` → footer `[AC ⏸]`；侧栏仍只渲染 `watching` / `confirming`。

---

## 5. 挫败感触发

### 5.1 配置

```ts
/** 真实用户消息中出现这些子串（大小写不敏感）即视为「质量不满」；空数组 = 功能关闭。 */
frustrationTriggers: string[]
/** 命中后追加到下一次注入末尾的提醒句；仅在 frustrationTriggers 非空时生效。 */
frustrationMessage: string
```

- 默认 `frustrationTriggers: []`——**默认关闭**（与 `observeToolFailures: false` 同先例：
  误判会把一句斥责塞进正常轮次）。
- 合并规则：数组**替换**（与 `escalationPressureLadder` 同规则），字符串覆盖。

### 5.2 检测

- 位置：真实用户消息分支内、**自回声守卫之后**——插件自己的注入回流永远不会触发。
- 文本来源：V2 `item.payload.text`；V1 `messageText(info.parts)`。
- 匹配：`matchesFrustration`（`src/engine.ts`）做**大小写不敏感的子串匹配**，
  不使用正则、不搬运上游的过泛词表；命中任一子串即算命中。

### 5.3 副作用

1. `InMemoryState.frustrationPending: boolean`（初值 `false`）。
2. `store.resume(sessionID, recomputeEndAt, preserveRejections)` 的第三参为 `true` 时
   **跳过** `entry.rejections = 0`，但**仍** `entry.roundId += 1`（在飞的验证结果照常作废）。
   理由：用户抱怨本身就是「上一轮交付被否」的证据，此时清零计数恰好是错的。
3. 落点是 `injectAndRecord`——所有注入的唯一漏斗：若 `memory.frustrationPending` 且
   `cfg.frustrationMessage` 非空，则**在调用 `injectContinuation` 之前**把提醒句以 `\n\n`
   追加到待发文本，并清标志。必须在注入前合成，保证自回声记录用的是**实际发送的文本**。

---

## 6. 无人值守护栏与停止原因

### 6.1 默认上界（v0.5.2 起）

| 键 | 旧默认 | 现默认 | 语义 |
|---|---|---|---|
| `watchTimeoutMs` | `0` | `86_400_000`（24h） | `0` 仍表示「无墙钟上限」 |
| `verifyMaxIterations` | `0` | `50` | `0` 仍表示「不限验证轮次」 |

这是**默认值变更**，`0 = 无限` 的语义保留，用户可显式写 `0` 恢复无限。

### 6.2 停止原因

`StopReason` 共 **8 值**，**单一真源**在 `src/rpc.ts` 的 `STOP_REASONS`：

```ts
export type StopReason =
  | "window-closed"
  | "watch-timeout"
  | "injection-cap"
  | "verify-limit"
  | "idle-interrupted"
  | "user-interrupted"
  | "abort-sentinel"
  | "title-excluded"
```

- `WatchState.stopReason?: StopReason` 是**持久化字段**（`src/rpc.ts` 的 `WatchState`）。
- `WatchStore.markStopped(sessionID, reason?: StopReason)`：传 reason 则写入，
  **不传 reason 则清空**既有 reason（该无参语义已被单测锁定）。
- `markDone` 与 `resume` 都会把 `stopReason` 置 `undefined`——上一轮的原因不得泄漏到新一轮状态。
- `hydrate()` 只在 `isStopReason(entry.stopReason)` 为真时保留该字段。
- RPC：`WatchStatus`、`WatchStatusEvent` 与 `state.changed` 的 schema 都声明 `stopReason`
  （schema 的 `enum` 由 `STOP_REASONS` 派生；schema 是 `additionalProperties:false`，
  **不显式声明就会被整条丢弃**）。
- TUI：footer 显示 `[AC ⏹ N · 短语]`，`/autocontinue status` 的 toast 同样显示原因文案。
  侧栏块**保持既有契约**——终态（`done` / `stopped`）不渲染侧栏。
- 英文短语表在 `src/tui-logic.ts` 的 `STOP_REASON_LABELS`（v0.5.5 起从 `src/tui.tsx` 抽出的
  纯逻辑模块），其键集合与 `STOP_REASONS` 的一致性由测试守卫。

### 6.3 墙钟预算的现行计量

`watchTimeoutMs` **按轮次计量**（v0.5.3 起）。`WatchState` 同时存两个时间锚点：

- `since`——本次 `/autocontinue on` 的开始时间，`resume()` **不改动**它，供侧栏 ⏱ 时长显示；
- `roundSince`——**本轮**的开始时间，`watch()` 时与 `since` 同时置位，真实用户消息开启新一轮时刷新。

墙钟判定一律读 `roundSince`：

- `src/engine.ts` 的 `maybeInject`——注入前的超时判定；
- `src/engine.ts` 的 `runVerifyGate`——验证命令返回后的 staleness 复检。

`hydrate()` 遇到旧数据缺 `roundSince` 时**回落为 `since`**（旧记录没有轮次概念，
首次恢复时按值守起点算，避免一恢复就判定超时）。`watchTimeoutMs: 0` 仍表示**无限**。

---

## 7. 完成判定

### 7.1 非 verify 模式：两阶段完成

1. `watching` 态下命中完成标记 → `beginConfirming()`，state 变 `confirming`，
   注入 `finalCheckMessage`（整库检查 + 文档同步），并记录
   `confirmingAtAssistantCount`（当时的 assistant 消息条数）。
2. `confirming` 态下**必须有一条新的** assistant 回复（`assistantCount` 超过记录值），
   且该回复再次命中完成标记 → `markDone()`，footer `[AC ✓]`。
3. `confirming` 态下新回复**未**命中标记 → `continueWatching()` 回到 `watching`
   （**保留**注入计数），等下一次触发重新判定。
4. `finalCheckEnabled: false` 时，命中标记即 `markDone()`，不走两阶段。

完成标记的来源：`buildCompletionMatcher(config)`（`src/config.ts`）——
`markerRegex` 有效时取代 `completionMarkers`；两者都为空时返回 `null` matcher，
即**不检测完成**，会话持续值守。

### 7.2 verify 模式：exit code 即完成

verify 模式下 §7.1 的两阶段流程**整段被替换**：完成信号只触发验证，完成与否只看
验证命令的 exit code（§3.4）。

### 7.3 完成不等于停止

护栏停止一律记为 `stopped`，**绝不记为 `done`**。`done` 只表示「任务真的完成了」。

---

## 8. 停止路径总表

共 **8 条**带原因的停止路径，全部记为 `stopped`：

| 停止原因 | 触发点 | 落点（符号） | 状态 |
|---|---|---|---|
| `window-closed` | `endAt` 到点 | `src/engine.ts` 的 `maybeInject`（窗口判定分支） | `stopped` |
| `watch-timeout` | 墙钟预算耗尽 | `src/engine.ts` 的 `maybeInject`（墙钟判定分支） | `stopped` |
| `injection-cap` | `injections >= maxConsecutive` | `src/engine.ts` 的 `maybeInject`（注入上限分支） | `stopped` |
| `verify-limit` | `rejections >= verifyMaxIterations` | `src/engine.ts` 的 `runVerifyGate`（verify-then-cap 分支） | `stopped` |
| `idle-interrupted` | V1 `session.idle` 且 `outcome="interrupted"` | `src/engine.ts` 的 V1 `session.idle` 事件分支 | `stopped` |
| `user-interrupted` | V2 `session.execution.interrupted` | `src/engine.ts` 的 V2 中断事件分支 | `stopped` |
| `abort-sentinel` | assistant 文本命中 abort 哨兵 | `src/engine.ts` 的 `maybeInject`（abort 哨兵分支） | `stopped` |
| `title-excluded` | 会话标题命中 `excludeTitleKeywords` | `src/engine.ts` 的 `maybeInject`（标题排除分支） | `stopped` |

补充说明：

- **用户主动 `/autocontinue off`** 不是一条停止路径——它直接移除值守记录，不产生 `stopped` 状态。
- **pause 哨兵**不是停止——它把状态置为 `paused`，等待用户输入后经 `resume()` 恢复。
- 标题排除路径自 v0.5.3 起记为 `title-excluded`（此前调用无参 `markStopped(sessionID)`，
  会**清空**既有 `stopReason`，footer 只能显示裸 `[AC ⏹ N]`）。
- **忙 / 活跃状态没有 `session.status` 轮询**：是否在跑由**事件派生**（`lastBusyAt` /
  `lastActiveAt`），判定为忙或仍在活动时直接跳过本轮注入，不做轮询等待。

---

## 9. v0.5.3 修复规格

> 本节归档 v0.5.3 的修复规格与验收口径。逐条写明已裁定的语义、实现契约与验收要求。
> 各条状态见各小节开头的「状态」标注：**✅ 已发布**的条目给出**当前行为**；
> 「问题 / 裁定 / 实现契约」的叙述是**当时的历史快照（历史（已归档））**，保留在案以免被误读为待办。

### 9.1 配置钳制：`maxConsecutive` 负值回退

> **状态：✅ 已发布（v0.5.3；v0.5.6 补告警）。**
> **当前行为**：`mergeConfig` 的 `maxConsecutive` 分支对**负值回退到基础值**（默认 `20`），
> `0` 仍表示**不限**，非有限值（`NaN` / `Infinity` / `-Infinity` / `1e400`）回退默认，正数原样采用。
> 基础值本身不可用时再回退到出厂默认 `20`。
> **v0.5.6 起**：负值回退**产出恰好一条 `console.error` 诊断**（含键名、原始值、生效值）——回退是一次**静默改写用户输入**的动作，按 v0.5.6 建立的「改写必告警」不变式必须出声。

**问题**：`mergeConfig` 对 `maxConsecutive` 只做了有限性校验，**没有下界钳制**
（`src/config.ts` 的 `mergeConfig`）。负值会被原样写入，运行时判定是
`cfg.maxConsecutive > 0 && entry.injections >= cfg.maxConsecutive`——负数不满足 `> 0`，
于是**唯一的注入次数上限被静默取消**，与 v0.5.2 守护栏的意图直接冲突。

**对照**：`watchTimeoutMs`（`Math.max(0, ...)`）、`verifyMaxIterations`（钳 `0..10000`）、
`selfEchoWindowMs`（`Math.max(0, ...)`）都已钳制，`maxConsecutive` 是**唯一漏网**的数值键。

**裁定语义**：

| 输入 | 结果 |
|---|---|
| 负数（如 `-1`） | 回退到基础值（默认 `20`） |
| `0` | 保持 `0` = **不限**（既有语义不变） |
| 非有限（`NaN` / `Infinity` / `-Infinity` / `1e400`） | 回退默认（既有语义不变） |
| 正数 | 原样采用 |

**实现契约**：

- 在 `mergeConfig` 的 `maxConsecutive` 分支内，钳制到**基础值**而不是硬编码常量：
  负数时 `merged.maxConsecutive = base.maxConsecutive`，即以调用方传入的 base 为准
  （`loadConfig` 的合并链是「默认 → 全局 → 项目」，故回退到基础值即回退到默认 20）。
- `0` 必须**放行**：不能写成 `Math.max(0, value)` 之外的任何钳制，否则 `0 = 不限` 的语义会变。
- 非有限判定沿用既有 `Number.isFinite` 写法。

**验收**：`test/config-safety.test.ts` 断言 `maxConsecutive: -1` 合并后等于 `base.maxConsecutive`；
`maxConsecutive: 0` 合并后等于 `0`；`maxConsecutive: 1e400` 合并后等于 `base.maxConsecutive`；
`maxConsecutive: 5` 合并后等于 `5`。

### 9.2 墙钟预算按轮次计量

> **状态：✅ 已发布（v0.5.3）。**
> **当前行为**：`watchTimeoutMs` **按轮次计量**——`watch()` 同时置 `since` 与 `roundSince`；
> 真实用户消息经 `resume()` 开启新一轮时**刷新 `roundSince`**、`since` **不变**；
> `hydrate()` 遇到旧数据缺 `roundSince` 时**回落为 `since`**；引擎两处墙钟判定都读
> `roundSince`；`watchTimeoutMs: 0` 仍表示**无限**。

**问题**：`watchTimeoutMs`（默认 24h）当前从 `since` 起算，`since` 只在 `watch()` 时写入，
`resume()` 不改动它。用户在一次值守中发过若干条真实消息后，**每一轮都只能吃到第一轮剩余的预算**，
第 2 轮起几乎立刻超时。这与「无人值守护栏保护长任务」的初衷相反。

**裁定语义**：`watchTimeoutMs` 改为**每一轮**计量。

**实现契约**：

1. `WatchState` 新增持久字段 `roundSince: number`（本轮起始时间戳，epoch ms）。
2. `watch()` 同时置 `since` 与 `roundSince`（两者同为 `Date.now()`）。
3. `resume()`（真实用户消息触发的新一轮）**刷新 `roundSince`**，`since` **不变**。
   - `since` 继续表示「本次值守开始时间」，供侧栏 ⏱ 时长显示，语义不变；
   - `roundSince` 表示「本轮开始时间」，供墙钟预算计量。
4. `hydrate()` 遇到旧数据缺 `roundSince` 时**回落为 `since`**（旧记录没有轮次概念，
   首次恢复时按值守起点算，避免一恢复就判定超时）：
   ```ts
   roundSince: typeof entry.roundSince === "number"
     ? entry.roundSince
     : (typeof entry.since === "number" ? entry.since : now),
   ```
5. 引擎两处墙钟判定改用 `roundSince`：
   - `src/engine.ts` 的 `maybeInject`（注入前的超时判定）：
     `Date.now() - entry.roundSince >= cfg.watchTimeoutMs`；
   - `src/engine.ts` 的 `runVerifyGate`（验证命令返回后的 staleness 复检）：
     `Date.now() - after.roundSince >= cfg.watchTimeoutMs`。
6. `watchTimeoutMs: 0` 仍表示**无限**（既有语义不变）。

**行为变更记录**：v0.5.2 起原本按「首次 `/autocontinue on`」累计；v0.5.3 改为按轮次。
这是**修正而非收紧**——新一轮不会继承上一轮的剩余预算，等于把「一次性总额」还原成
「每轮额度」。取值上界（默认 24h）与 `0 = 无限` 都不变。

**验收**：

- `store.watch()` 后 `since === roundSince`；
- `store.resume()` 后 `roundSince` 前进而 `since` 不变；
- `hydrate` 旧记录（无 `roundSince`）得到 `roundSince === since`；
- 引擎：把 `roundSince` 调到足够久远的时刻 → 判定超时停止（`watch-timeout`）；
  把 `since` 调老但 `roundSince` 保持新鲜 → **不**停止。

**文档同步（✅ 已完成）**：`docs/architecture/events-and-state.md` 的存储 JSON 示例已补
`roundSince` 字段；`docs/features/config.md` 已说明 `watchTimeoutMs` 的计量单位是「单轮」。

### 9.3 第 8 个停止原因：`title-excluded`

> **状态：✅ 已发布（v0.5.3）。**
> **当前行为**：标题命中 `excludeTitleKeywords` 时，引擎调用
> `markStopped(sessionID, "title-excluded")`；`StopReason` 取值集合为 **8 值**；
> TUI 短语为 `title excluded`，footer 渲染为 `[AC ⏹ N · title excluded]`。

**问题**：标题命中 `excludeTitleKeywords` 而停止时，引擎调用的是**无参**的
`markStopped(sessionID)`（`src/engine.ts` 的标题排除分支）。按 `markStopped` 的既有语义，
无参调用会**清空**既有的 `stopReason`——于是 footer 只能显示裸 `[AC ⏹ N]`，
用户无法区分「这个会话被标题规则排除了」与其它停止原因。

**裁定语义**：

- `StopReason` 取值集合扩为 **8 值**，顺序固定为：
  `window-closed`、`watch-timeout`、`injection-cap`、`verify-limit`、`idle-interrupted`、
  `user-interrupted`、`abort-sentinel`、`title-excluded`。
- 标题排除路径改为 `markStopped(sessionID, "title-excluded")`。
- TUI 英文短语：`title excluded`。
- footer 格式：`[AC ⏹ N · title excluded]`。
- `markStopped(id)` 无参「清空 reason」的语义**保留不变**（已被单测锁定），
  且 v0.5.3 之后生产代码**不再有**该调用点——无参分支退化为纯兼容 API。

**实现契约**：

1. `STOP_REASONS` 的**唯一定义**落在 `src/rpc.ts`（契约模块，server 与 TUI 双侧共享）：
   `src/rpc.ts` 追加 `"title-excluded"`（放在数组**末尾**，保持 §9.4 的单一真源顺序），
   `src/state.ts` 从 `./rpc.ts` 导入并再导出，保持既有引用路径可用。
2. `src/engine.ts` 的标题排除分支改为 `await this.store.markStopped(sessionID, "title-excluded")`。
3. `src/tui-logic.ts` 的 `STOP_REASON_LABELS` 追加 `"title-excluded": "title excluded"`。
4. RPC 的两处 schema enum 与 `RpcContract` 的联合类型同步追加该值（见 §9.4）。

**验收**：

- 标题命中 `excludeTitleKeywords` → 状态 `stopped` 且 `stopReason === "title-excluded"`；
- TUI 渲染出 `[AC ⏹ N · title excluded]`；
- `markStopped(id)` 无参调用仍会清空 reason（既有单测保持通过）。

### 9.4 `stopReason` 单一真源

> **状态：✅ 已发布（v0.5.3）。**
> **当前行为**：`STOP_REASONS` 的唯一定义在 `src/rpc.ts`；`src/rpc.ts` 的两处 schema `enum`
> 写作 `enum: [...STOP_REASONS]`；`src/state.ts` 从 `./rpc.ts` 导入并再导出
> `STOP_REASONS` / `StopReason`；TUI 侧标签表 `STOP_REASON_LABELS` 保持字面量对象形态，
> 由测试断言与 `STOP_REASONS` 的集合相等。

**问题**：停止原因的取值集合目前有 **4 份手写副本**：

| # | 位置 | 形态 |
|---|---|---|
| 1 | `src/state.ts` 的 `StopReason` 联合类型 | 类型层真源 |
| 2 | `src/state.ts` 的 `STOP_REASONS` 数组（**私有** `const`，仅供 `isStopReason` 使用） | 运行时真源 |
| 3 | `src/rpc.ts` 的两处 schema `enum`（`status` 输出 + `state.changed` 事件） | 契约层副本 |
| 4 | `src/tui-logic.ts` 的 `STOP_REASON_LABELS` 标签表 | 展示层副本 |

其中 `src/rpc.ts` 内还有第三份字面量：`RpcContract.events["state.changed"].schema.properties.stopReason`
的联合类型，它与同文件的两处运行时 `enum` 也是互相独立的副本。

**漂移代价**：RPC schema 是 `additionalProperties:false` + 显式 `enum`。若新增了
`title-excluded` 却漏改 `state.changed` 的 schema `enum`，宿主会**拒绝该会话的所有
`state.changed` 事件**——footer 停在旧状态、侧栏不再刷新，而且不报任何错。
这是静默的全量事件丢失。

**裁定语义**：

1. `STOP_REASONS` 的**唯一定义**落在 `src/rpc.ts`——该模块本就是 server 与 TUI 双侧共享的
   契约模块，已承载 RPC schema 与 `WatchState` / `WatchStatus` 接口：

   ```ts
   export const STOP_REASONS = [
     "window-closed",
     "watch-timeout",
     "injection-cap",
     "verify-limit",
     "idle-interrupted",
     "user-interrupted",
     "abort-sentinel",
     "title-excluded",
   ] as const
   export type StopReason = (typeof STOP_REASONS)[number]
   ```

   取值集合与顺序由此**一处**定义，其余副本全部由它派生。
2. `src/rpc.ts` 内两处 schema `enum`（`status` 输出 + `state.changed` 事件）与
   `RpcContract` 的 `stopReason` 联合类型，**全部由该数组派生**（schema 写作
   `enum: [...STOP_REASONS]`，类型写作 `StopReason`）。
3. `src/state.ts` 从 `./rpc.ts` 导入 `STOP_REASONS` 与 `StopReason` 并**再导出**
   （`export { STOP_REASONS }` + `export type { StopReason }`），保持既有引用路径可用；
   `isStopReason` 仍留在 `src/state.ts`，改用导入的 `STOP_REASONS`。
4. TUI 侧的 `STOP_REASON_LABELS` **保持字面量对象形态**，不在运行时派生，
   一致性改由**测试守卫**保证。该表当前落在 `src/tui-logic.ts`（v0.5.5 从
   `src/tui.tsx` 抽出，见 §11.5），`src/tui.tsx` 只做再导出。
5. 最低要求：若实施中确因其它原因无法直接派生，则**至少由测试断言三者与 `STOP_REASONS`
   完全一致**（集合相等 + 顺序相等），任何漂移立即失败。

**实现契约与依赖方向**：

- 依赖方向因此**单向**：`state.ts → rpc.ts`。当前两模块互相 type 引用
  （`src/rpc.ts` 的 `import type { StopReason } from "./state.ts"` 与
  `src/state.ts` 的 `import type { WatchState, WatchStatus } from "./rpc.ts"`）被一并消除。
- **真源为何不能落在 `src/state.ts`**：`src/tui.tsx` 已运行时
  `import { AUTOCONTINUE_RPC_CONTRACT } from "./rpc.ts"`，esbuild 会把被导入模块整个打进
  `dist/tui.js`。若真源落在 `src/state.ts`，则 `rpc.ts` 必须**值级**导入 `state.ts`，
  于是整个 server 侧的 `WatchStore` 会被打进 TUI 交付物。`src/rpc.ts` 不依赖任何
  Node 内建模块，是唯一安全的落点。
- `src/state.ts` 的**再导出**保证既有引用路径（例如 `import { STOP_REASONS } from "./state.ts"`）
  继续可用，不强迫调用方改导入路径。
- **TUI 标签表为何不派生**：v0.5.3 时 `test/tui-delivery.test.ts` 用 `new Function` 把
  `src/tui.tsx` 中 `STOP_REASON_LABELS` 所在的源码区间**单独求值**（剥掉 `export` 与类型标注后
  构造工厂函数），标签表若引用 `STOP_REASONS` 就会在该隔离作用域里找不到标识符。
  v0.5.5 把标签表与其它纯逻辑抽到 `src/tui-logic.ts`（见 §11.5）后，测试改为直接
  `import` 该模块；但标签表仍保持**自足的字面量对象**，一致性继续由测试断言：
  键集合与 `STOP_REASONS` 完全相等、每个取值都有非空短语。

**验收**：

- 一条测试断言：RPC 两处 schema `enum` 的取值集合与顺序 == `STOP_REASONS`；
- 一条测试断言：`RpcContract` 的联合类型取值集合 == `STOP_REASONS`；
- 一条测试断言：`Object.keys(STOP_REASON_LABELS)` 的集合 == `STOP_REASONS` 的集合。

### 9.5 测试定时器泄漏

**问题**：`test/server.test.ts` 的 `makeEngine()` 构造
`AutocontinueEngine` 后**从不调用 `engine.dispose()`**。引擎在测试期间启动的
per-session Timeout 与 per-session Interval 全部残留——测试跑完后仍有 **15 个活跃定时器**，
官方命令 `node --test` 因此**永久挂起不退出**；当前只能靠 `--test-force-exit`
强制退出（192/192 用例全绿）。

`engine.dispose()`（`src/engine.ts` 的 `AutocontinueEngine.dispose`）正是为此存在：
它 `clearTimeout` 全部 `timers`、`clearInterval` 全部 `intervalTimers`、并 abort 在飞的验证控制器。

**裁定语义**：

1. 测试必须**自行退出**，不得依赖 `--test-force-exit` 掩盖泄漏。
   - `--test-force-exit` 只能作为「已知仍有泄漏」的临时止血手段，不能是标准测试命令。
2. `package.json` 增加 `test` script：

   ```json
   "test": "node --experimental-strip-types --test \"test/*.test.ts\""
   ```

3. `makeEngine()` 必须在每个用例结束时释放引擎：让 `makeEngine()` 返回一个
   `dispose()` 辅助函数（或用 `t.after(() => engine.dispose())` 注册清理），
   确保**每个**用例都调用 `engine.dispose()`。
4. 清理必须覆盖**全部**测试文件——凡是构造引擎或持有定时器的用例都要释放
   （当前实现已统一到 `test/support/harness.ts` 的 `createEngine()` / `disposeEngines()`）。

**验收**：

- `npm test` 跑完自行退出（退出码 0），**不加** `--test-force-exit`；
- 退出前无残留活跃句柄（`process.getActiveResourcesInfo()` 不含 `Timeout`）。

**状态：已完成**。

- `package.json` 的 `test` script 已改为
  `node --experimental-strip-types --test "test/*.test.ts"`，不含 `--test-force-exit`。
- 引擎释放统一收口到共享夹具 `test/support/harness.ts`：`createEngine()` 注册每个引擎实例，
  `disposeEngines()` 在各测试文件的 `afterEach` 中释放，并检查是否有引擎漏释放（有则抛错）。
  守卫辅助函数为 `assertNoLiveEngines()`。
- 文档同步已完成：`AGENTS.md` 与 `docs/architecture/overview.md` 的测试命令均已指向新的
  `npm test`。

### 9.6 v0.5.3 实施清单汇总

| # | 条目 | 主要落点 | 状态 |
|---|---|---|---|
| 9.1 | `maxConsecutive` 负值回退 | `src/config.ts`（`mergeConfig`） | 已发布 |
| 9.2 | 墙钟预算按轮次 | `src/rpc.ts`（`WatchState.roundSince`）、`src/state.ts`（`watch`/`resume`/`hydrate`）、`src/engine.ts`（两处墙钟判定） | 已发布 |
| 9.3 | 第 8 个停止原因 | `src/rpc.ts`（`STOP_REASONS` 真源追加 `title-excluded`）、`src/state.ts`（导入并再导出）、`src/engine.ts`（标题排除分支）、`src/tui-logic.ts`（标签表） | 已发布 |
| 9.4 | 停止原因单一真源 | `src/rpc.ts`（唯一定义 + 两处 schema enum 与 `RpcContract` 联合类型派生）、`src/state.ts`（导入并再导出）、`src/tui-logic.ts`（标签表由测试守卫） + 一致性测试 | 已发布 |
| 9.5 | 测试定时器泄漏 | `test/*.test.ts`、`test/support/harness.ts`、`package.json`（`test` script） | 已发布 |

**顺序建议**：9.4 先做（它是 9.3 的前置——新增取值时若真源已统一，就不会出现漏改副本）；
再做 9.3；9.1、9.2 相互独立；9.5 最后做（它会改变测试运行方式，需要在其它改动落定后收口）。

---

## 10. v0.5.4 增量

> 本节记录 v0.5.4 的三项增量。**不改变任何运行时行为**：`loadConfig` 的新参数可选，
> 不传时行为与 v0.5.3 完全一致。

### 10.1 全局配置路径可注入

`loadConfig` 新增**可选**第二参数 `LoadConfigOptions`，可指定本次读取哪个全局配置文件。

- 不传该参数时，读取路径与 v0.5.3 完全一致（用户 home 下的默认全局配置路径）。
- 用途：测试隔离真实用户全局配置时，不必改写 `USERPROFILE` / `HOME` 这类**进程级环境变量**
  ——进程级全局状态在同进程并行跑测试时会互相污染。
- `src/config.ts` 有运行时 API 变更，按仓库发布规则（`AGENTS.md` §2）必须 bump 至 `0.5.4`。

### 10.2 测试夹具统一

`test/server.test.ts` 里自己那份 `FakeStorage` / `makeFakeSession` / 引擎注册表删除，
统一改用共享夹具 `test/support/harness.ts`。仓库内不再有第二份实现。

### 10.3 断言与配置常量比对

原断言把默认续跑消息的中文文案硬编码在测试里，改文案就会让测试无故失败。改为与配置常量比对：
断言的是**行为**（注入的就是配置的那条消息），而不是文案本身。

> **状态：部分完成。** 默认续跑消息与 `finalCheckMessage` 的**部分**断言已改为与配置常量比对，
> 但 `test/server.test.ts` 中仍有中文文案字面量断言（如 `/^继续执行/`、`/整体检查/`）。
> v0.5.5 未补完，详见 `docs/decisions/changelog.md` 的 v0.5.5「本版没有做的事」。

---

## 11. v0.5.5 增量

> 本节记录 v0.5.5 的增量。主题是**加固**：配置写错时不再静默、值守状态不再被误清、
> 回声不再被误判为真实用户消息。

### 11.1 配置校验与诊断

`src/config.ts` 的 `mergeConfig` 与 `readConfigFile` 增加了一整层校验与告警，
全部告警走 `console.error`（输出到 stderr / 宿主日志），**不静默丢弃**。

**读取诊断**（`readConfigFile`）：

| 情形 | 行为 |
|---|---|
| 文件**不存在** | **静默**回退默认值（正常路径，不打扰用户） |
| 读取**失败**（权限、路径被目录占位、I/O 错误） | `console.error` 一条，含**配置文件绝对路径**与错误信息，随后回退默认值 |
| **解析失败**（JSONC 语法错误） | `console.error` 一条，含**配置文件绝对路径**与错误信息，随后回退默认值 |

**值校验**（`mergeConfig`）：

- **JSONC 尾逗号前瞻跳过注释**：`1, // 说明\n}` 这类写法不再被当成语法错误。
- **6 个数组型配置键剔除空字符串**：`completionMarkers` / `errorPatterns` / `excludePatterns` /
  `excludeTitleKeywords` / `escalationPressureLadder` / `frustrationTriggers`。
  空串是任何字符串的子串，留着会让匹配器命中一切。
- **`markerRegex` 三重防护**（常量 `MAX_MARKER_REGEX_SOURCE_LENGTH = 1024`）：
  源长度超限 → 忽略并告警；检测到**嵌套量词**（ReDoS 风险）→ 忽略并告警；
  正则**不可编译** → 忽略并告警。三种情形一律回落到 `completionMarkers`。
- **`startTime` / `endTime` 校验 `HH:MM`**（时 ≤ 23、分 ≤ 59）：非法值**回退为空**
  （= 不限制每日窗口）并告警。
- **数值钳制**（常量 `MAX_TIMER_DELAY_MS = 2^31 - 1`）：
  `idleDelayMs` / `minIntervalMs` 的**负值钳到 0 并告警**；
  `intervalMs` / `idleDelayMs` / `minIntervalMs` **超过上限**时钳到上限并告警。
  `intervalMs` 的 `0 = 关闭周期检查` 语义保持可达（只对正值套用 1s 下限）。
- **v0.5.6 建立的不变式**：任何**被静默改写**的配置值都产出**恰好一条** `console.error`
  （含键名、原始值、生效值）；**合法值零诊断**。覆盖范围：负值钳 0、`intervalMs` 正值低于
  1s 地板、`intervalMs` / `idleDelayMs` / `minIntervalMs` 超 `2^31-1`、`maxConsecutive` 负值回退、
  `watchTimeoutMs` / `userGraceMs` / `selfEchoWindowMs` 负值钳 0、`verifyTimeoutMs` 越界、
  `verifyMaxIterations` 越界、6 个数组键剔除空串。
  静默的合法值：`intervalMs = 0`、`userGraceMs = 0`、`watchTimeoutMs = 0`、`selfEchoWindowMs = 0`、
  `maxConsecutive = 0`、`verifyMaxIterations = 0`，以及各上下限本身。

> 注意：`verifyTimeoutMs` / `verifyMaxIterations` / `watchTimeoutMs` 的既有钳制**边界不变**，
> 变化只是从静默改为告警。

### 11.2 错误匹配串统一

`src/events.ts` 的 `errorToMatchString` 在 `name` 缺失时**回退读 `type`**——
宿主在消息事件路径上用 `name` 标注失败，在 retry hook 路径上用 `type` 标注。
此前两条路径对**同一类错误**产出**不同的匹配串**，导致「消息事件路径判为可重试、
retry hook 路径判为不可重试」这类分歧。回退后两条路径产出**同一个**匹配串。

同时 `isRetryableError` 与 `titleExcluded` 在运行时**跳过空串** pattern / exclude /
标题关键词——这是配置加载之外的**最后一道防线**。

### 11.3 护栏与生命周期加固

- **回声幂等**（`src/engine.ts` 的 `isSelfEcho`）：注入记录在整个 `selfEchoWindowMs`
  窗口内保持有效。同一条注入被宿主以**两种事件形状**各投递一次时，第二次投递同样
  被识别为自身回声，不再触发 `resume()` 清零「注入上限 / 验证失败计数 / 轮次墙钟」
  三重上界。详见 §2。
- **回声时间窗兜底**（同函数）：入站文本**提取不到**且窗口内确有自注入记录时，
  判定为自身回声。残留风险见 §2.1 与 `docs/decisions/known-issues.md`。
- **`roundId` 进程级全局单调递增**（`src/state.ts` 的 `allocateRoundId`）：
  此前 `roundId` 从 0 重新开始，off → on 之后**陈旧的验证结果**可能被当成新一轮的结果。
- **在途注入锁与每轮缓存拆分**（`src/state.ts` 的 `watch` / `unwatch` / `resetRoundCache`）：
  `watch()` 重置**每轮缓存**但**不清除在途注入锁**；`unwatch()` 两者都清。
- **引擎 disposed 守卫**（`src/engine.ts`）：disposed 后**不再新建定时器**、
  **不再改写持久化状态**。
- **final-check 复检**（`src/engine.ts`）：完成复查轮的注入在 `await` 之后**复检会话
  是否仍被值守**，避免用户在这段窗口内关闭值守后仍发生注入。
- **定时器延迟钳制**（`src/engine.ts` 的 `clampTimerDelay`）：引擎排出的**每个**定时器
  延迟都钳到 `2^31 - 1`——超限值此前会退化成 1ms 热循环。
- **配置读取位置前移**（`src/engine.ts`）：非值守会话的事件**不再白读两次盘**；
  回声判断复用**已加载**的配置。
- **验证门控的轮次快照**（`src/engine.ts` 的 `runVerifyGate`）：命令**启动前**重读一份
  状态快照并校验，命令**返回后**复检 `roundId` 是否变化——避免命令运行期间的
  `resume()` 让陈旧结果通过。

### 11.4 验证进程终止的未捕获异常

`src/verify.ts` 的 Windows 进程树终止助手补上 **spawn 失败监听**：
此前进程启动失败是**异步**发生的，会变成**未捕获异常**并可能带崩宿主进程；
现在被捕获并转为正常的验证失败。

### 11.5 TUI 纯逻辑抽离

停止原因文案表（`STOP_REASON_LABELS`）、时长格式化（`formatDuration`）、
watch 状态合并（`mergeWatchState`）三块**纯逻辑**从 `src/tui.tsx` 抽出到新建的
`src/tui-logic.ts`。该模块**无 JSX、无 solid-js 依赖、无宿主 SDK 依赖**，
测试可以直接 `import` 它，不必再从 `.tsx` 源码里刮表（见 §9.4）。

`src/tui.tsx` 保留再导出，既有引用路径不变。

### 11.6 脱敏扫描器扩充

`scripts/sanitize-scan.ts` 的扫描规则扩充为 **12 条模式**：修正了 **Telegram token**
的匹配形状（此前带描述文字前缀，导致真实 token 永远匹配不到）；补充**本机用户名**与
`/home/<用户名>` 形态；产物文件按形态识别。
