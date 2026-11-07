# 变更记录

本文件按版本分节记录 opencode-autocontinue 的历史变更，新版本在前。每节内部按 **新增 / 修复 / 默认值变更 / 验证** 四类归档；某一类在当版没有内容时直接省略。

> 注：带「注」的条目为该版本当时的事实，后续版本语义或默认值已发生变化，请以对应版本的说明为准。

## 索引

| 版本 | 日期 | 一句话摘要 |
|---|---|---|
| v0.5.4 | 2026-11-08 | 全局配置路径可注入（`loadConfig` 新增可选参数）、测试夹具去重（统一到 `test/support/harness.ts`）、测试解除文案硬编码 |
| v0.5.3 | 2026-11-07 | `maxConsecutive` 负值回退默认、墙钟预算按轮次计量、新增第 8 个停止原因、停止原因单一真源、测试自行退出、文档分层校正 |
| v0.5.2 | 2026-11-02 | 借鉴裁定记录、挫败感触发（opt-in）、无人值守护栏与默认上界、七值 `stopReason` |
| v0.5.1 | 2026-11-01 | 全项目审计修复：跨午夜起点闸、验证 TOCTOU、非有限数值、JSONC 尾逗号、哨兵优先级等 |
| v0.5.0 | 2026-11-01 | 验证输出限流、abort/pause 哨兵与 `paused` 状态、压力梯替代 `escalationMessages`、验证状态进 TUI/RPC、工具失败观测 |
| v0.4.0 | 2026-10-31 | 注入溯源修复、验证驱动续跑 Loop（opt-in）、终止哨兵 |
| v0.3.16 | 2026-10-30 | 新增 `totalInjections` 累计注入观测 |
| v0.3.15 | 2026-10-21 | 滞留的 streaming tool 不再钉死会话 |
| v0.3.14 | 2026-10-20 | 消除注册期 TDZ 风险、`intervalMs: 0` 可真正禁用定期检查 |
| v0.3.13 | 2026-10-20 | 会话仍在运行时不再被定期注入打断 |
| v0.3.12 | 2026-10-18 | 缩短 `userGraceMs` 安静窗口、后台子代理防误判完成 |
| v0.3.11 | 2026-10-16 | 适配宿主 v2 消息与事件形状 |
| v0.3.10 | 2026-10-14 | 折叠状态跨挂载存活、交付守卫与 dist 核对 |
| v0.3.9 | 2026-10-14 | 修响应式实例割裂、Watch 块支持点击折叠 |
| v0.3.8 | 2026-10-14 | 移除 `Show` 死闸门，改 tracked thunk 门控 |
| v0.3.7 | 2026-10-14 | 会话 ID 解析抽为纯模块并补 4 锁单测 |
| v0.3.6 | 2026-10-14 | 修「No current session」与侧栏终态常驻 |
| v0.3.5 | 2026-10-13 | 修 TUI 渲染 effect 跨图失效导致的界面冻结 |
| v0.3.4 | 2026-10-08 | 修完成复查流程与侧栏展示共 4 处缺陷 |
| v0.3.3 | 2026-10-08 | 修侧栏 / footer 不实时刷新 |
| v0.3.2 | 2026-10-07 | 修用户手工停止后仍继续注入 |
| v0.3.1 | 2026-10-06 | 侧栏状态显示去重 |
| v0.3.0 | 2026-10-06 | 统一注入管线、完成确认机制、`watchTimeoutMs` 单轮上限、删除 `intervalMessage` |
| v0.2.5 | 2026-10-05 | 修侧栏保活心跳计数恒为 0 |
| v0.2.4 | 2026-10-05 | 注入前「任务真完成」校验增强 |
| v0.2.3 | 2026-10-05 | 侧栏新增保活心跳计数行 |
| v0.2.2 | 2026-10-05 | 深度审查修复（2 P1 / 10 P2 / 10 P3） |
| v0.2.1 | 2026-10-05 | 新增保活心跳、修 status 报错与图标延迟刷新 |
| v0.2.0 | 2026-10-04 | TUI 值守块修复、界面全英文化 |
| 开发阶段 | 2026-10-03 | 骨架 / RPC / 核心 / TUI 实现、文档体系重构、深度审查修复 |

---

## v0.5.4

日期：2026-11-08

本轮是 v0.5.3 之上的**三项技术债清理**（内部 API 扩展 + 测试可维护性改进），
**无用户可见行为变更**。

### 新增

**① `loadConfig` 支持可选的全局配置路径注入**

- `loadConfig` 新增可选第二参数 `LoadConfigOptions`，可指定本次读取哪个全局配置文件。
- **不传该参数时行为与 v0.5.3 完全一致**：仍读取用户 home 下的默认全局配置路径。
- 用途：让测试可以隔离真实的用户全局配置，而不必改写 `USERPROFILE` / `HOME` 这类
  **进程级环境变量**——进程级全局状态在同进程并行跑测试时会互相污染。
- `src/config.ts` 有运行时 API 变更，按仓库发布规则必须 bump 版本至 `0.5.4`。

### 修复

**② 测试夹具去重**

- `test/server.test.ts` 里自己那份 `FakeStorage` / `makeFakeSession` / 引擎注册表删除，
  统一改用共享夹具 `test/support/harness.ts`。
- 仓库内不再有第二份实现。

**③ 测试解除文案硬编码**

- 原断言把默认续跑消息的中文文案写死在测试里，改文案就会让测试无故失败。
- 改为与配置常量比对：断言的是**行为**（注入的就是配置的那条消息），而不是文案本身。

### 验证

- 本轮无用户可见行为变更：8 个停止原因、footer 短语、侧栏文案、5 道停止保障等事实**均不变**。
- 单元测试与静态守卫由编排者统一执行。
- 仍未做实机验证的三项不变：跨午夜窗口、验证 TOCTOU、`stopReason` 的 footer / toast 显示效果。

---

## v0.5.3

日期：2026-11-07

### 修复

**① 注入次数上限的负值不再静默取消限制**

- 此前把 `maxConsecutive` 配成负数时，注入次数上限会被静默取消（等同于无限注入）：用户以为自己设了限制，实际却在无限注入。
- 现在负值回退到默认值 **20**；`0` 仍表示不限；非有限数值（`NaN` / `Infinity` / `-Infinity`）仍回退默认值。

**② 墙钟预算改为按轮次计量**

- `watchTimeoutMs`（默认 24 小时）此前自**首次** `/autocontinue on` 起累计计时；一轮用完预算后，即使收到新的真实用户消息开启新一轮，也会因没有剩余预算而不再续跑。
- 现在改为**按轮次**计量：真实用户消息开启新一轮时预算重新计算，新一轮不继承上一轮的剩余预算。
- 这是修正而非收紧——预算上界不变，「`0` = 无限」的语义也不变。

**③ 标题命中排除关键词时也能说明停止原因**

- 此前标题命中排除关键词而停止时没有停止原因，footer 只能显示裸的 `[AC ⏹ N]`，用户看不出为什么停了。
- 现在新增第 8 个停止原因 `title-excluded`（界面短语 `title excluded`），footer 显示为 `[AC ⏹ N · title excluded]`。

**④ 停止原因取值收敛到单一真源**

- 此前停止原因分散在 4 处手写；漏改其中一处，该会话的所有状态刷新事件就会被宿主静默拒绝（界面看起来「卡住不动」）。
- 现在停止原因以单一真源定义（**8 值**），并由测试守卫确保 **RPC 契约、状态存储、界面文案**三者永远一致。

**⑤ 文档层事实校正**

- 入口页事实校正。
- 安装 / 更新 / 卸载命令中的占位符替换为真实仓库名。
- 断链修复。

**⑥ 文档结构化**

- changelog 结构化：改为按版本分节 + 索引表。
- 设计稿拆分：687 行文档拆为「决策索引 / 现行机制规格 / 取证历史」三份。

### 验证

**⑦ 测试命令不再永久挂起**

- `npm test` 现在跑完自行退出，不再依赖强制退出参数。
- 此前测试结束后命令一直不退出，根因是测试未释放引擎实例（残留 15 个活跃定时器）。

---

## v0.5.2

日期：2026-11-02

参考 `MichengAI/dsh-pua` **第三轮**比对，用户选定 P1 文档记录 + P2 缩减版挫败感触发 + P3 无人值守护栏；设计稿 `docs/architecture/provenance-and-loop.md` §7.3.1 / §9。

### 新增

**P2 缩减版挫败感触发（opt-in，默认关闭）**

- 新增 `frustrationTriggers: string[]`（默认 `[]`，大小写不敏感**子串**匹配，数组覆盖式合并，空数组即关闭）与 `frustrationMessage: string`。
- 命中**真实用户消息**（自回声守卫之后，插件自己的注入永不触发）→ 置 `frustrationPending`。
- `resume(..., preserveRejections=true)` 保留 rejections（用户抱怨本身就是「上轮交付被否」的证据），但仍推进 `roundId` 使在飞验证作废。
- 在 `injectAndRecord` 唯一漏斗**合成后再注入**（保证自回声记录 = 实际发送文本）。

**P3 无人值守护栏——七值 `stopReason`**

- 新增 `stopReason` 七值：`window-closed` / `watch-timeout` / `injection-cap` / `verify-limit` / `idle-interrupted` / `user-interrupted` / `abort-sentinel`。
- 贯通 `WatchState` 持久化 → `markStopped` → 引擎各停止点 → `state.changed` / RPC schema（`enum` 显式声明，`additionalProperties:false` 故不可省略）→ TUI footer `[AC ⏹ N · 短语]` 与 `/autocontinue status` toast。
- **护栏停止一律是 `stopped`，绝非 `done`**。
- 侧栏保持既有契约（终态不渲染）。

### 默认值变更

- `watchTimeoutMs` 默认 `0` → `86_400_000`（24 小时）。
- `verifyMaxIterations` 默认 `0` → `50`。
- `0` 仍表示无限（用户可显式写 `0` 恢复）。

### 验证

**P1 借鉴裁定记录**

- 对 dsh-pua 的「风格」机制做完整取证（`main`@`26ed406`：风味 15 套 + 模式 11 种 + 挫败感纠偏 + 失败升级 L1–L4 + Loop 压力 6 档 + Oracle 拒绝 3 档）与取舍评估，结论写入 `decisions/roadmap.md`。
- 结论：**不移植**——风味 / 人设 / 方法论预设 / 角色层级 / i18n / 降压换框 / 钉味 / feedback 判定。
  - 前三类需 systemPrompt / commands / agent 注册 API，降压需模型侧判断。
  - 钉味行为诉求已被 exit-code 门控覆盖。
  - feedback 需 transcript 路径。
  - 「挫败感触发」移入**缩减后借鉴**。
- 两处有意语义偏差记档于 §7.3.1：压力梯按**验证拒绝数**而非 dsh-pua 的迭代计数 → 墙钟意义上升级更晚；`≥5` 时两条提示**叠加**而非互斥。

**文档同步**

- `decisions/{roadmap,known-issues}.md`、`features/{config,engine,footer}.md`、`architecture/events-and-state.md`、`architecture/provenance-and-loop.md` §7.3.1/§9。

**测试**

- 单测 162→192（server +15 / config-safety +8 / tui-delivery +7）。

> 注：该表述为 v0.5.2 当时状态，后续版本已变更（见 v0.5.3）——`stopReason` 由 7 值增至 8 值（新增 `title-excluded`）。

---

## v0.5.1

日期：2026-11-01

全项目审查修复：对 `5ffbbd1` 做 @oracle 缺陷审计 + @explorer 覆盖 / 漂移表，逐条对源码复核；设计稿 §8。

### 修复

- **(F1) 跨午夜起点闸**——`startTimeNotReached` 在跨午夜窗口（如 22:00→08:30）次日 `00:00..startTime` 之间误判「未到点」而停止注入；改用跨午夜感知的 `startGateClosed(startTime, endTime)`。
- **(F2) 验证前 TOCTOU**——`runVerifyGate` 在创建验证 controller 前重取快照并校验 state / userGrace，再记录 `roundId`，避免 await 期间真实用户消息 bump `roundId` 使陈旧验证结果被当新轮，误判 `done` / 注入。
- **(F4) 非有限数值拒绝**——`mergeConfig` 所有数值键加 `Number.isFinite`，`1e400` / `NaN` / `-Infinity` 一律回退默认（防 `Infinity` 触发 hot timer）。
- **(F5) 字符串感知尾逗号**——`parseJsonc` 删除事后正则，改为同一次字符扫描内处理，字符串内的 `,}` / `,]` 原样保留。
- **(F6) `state.changed` 携带 `toolFailureCount`**——事件 schema / `WatchStatusEvent` / 发射端补该字段（`additionalProperties:false` 会丢弃未声明字段）。
- **(F7) V1 工具结果观测**——工具 part 扫描移出 assistant 分支，逐条消息识别 `tool` / `tool_use` / `tool_result`，V1 `tool_result(is_error)` 使计数器 +1（id 由 `tool_use_id` 回填）。
- **(F8) abort 哨兵优先**——abort 块移到 `backgroundWorkRunning` 守卫之前（显式 abort 必须生效），pause 保持在守卫之后。
- **(F9 / F12) verify.ts**——grace 定时器跟踪并清理（防 resolve 后仍 +1s 触发 killTree）；stdout / stderr 改用 `StringDecoder` 增量 UTF-8 解码（防跨 chunk 多字节字符被替换为 U+FFFD）。
- **(F11)** `state.ts` `resume` 注释对齐实际行为（窗口已过则关闭 endAt，不重算）+ 补测。
- **删除**：`state.ts` `resetInjectionCount`（导出死代码）。

### 验证

- **补测**：新增 `test/config-safety.test.ts`，并补跨午夜起点闸 / TOCTOU / V1 工具结果 / abort 优先 / 多字节解码 / 哨兵优先级等用例。
- **文档同步**：`features/{config,commands,engine,footer}.md`、`architecture/{events-and-state,module-layout,overview}.md`、`architecture/provenance-and-loop.md` §3.5、`decisions/{known-issues,roadmap}.md` 与 `README.md`。
- 单测 136→162（server +16 / verify-safety +2 / config-safety +8）。

---

## v0.5.0

日期：2026-11-01

参考 `MichengAI/dsh-pua` **第二轮**比对，用户选定 ①–⑤+B；设计稿 `docs/architecture/provenance-and-loop.md` §7。

### 新增

- **(2) abort / pause 哨兵 + `paused` 状态**——成对标签 `<loop-abort>…</loop-abort>` / `<loop-pause>…</loop-pause>`（`abortSentinelTag` / `pauseSentinelTag` 可配置，空串禁用），判定顺序 abort→pause→done；abort→`stopped`、pause→`paused`（均不注入，用户新消息经 `resume()` 恢复）；在 `maybeInject` 的验证闸门前统一判定，只读 assistant 文本（绝不扫描验证输出）。
- **(4) 验证状态进 TUI / RPC**——`WatchStatus` 与 `state.changed` 事件暴露 `rejections` / `verifying`；验证进行中先 emit `verifying:true`（`finally` 清除）；侧栏显示 `🔍 verifying` / `🚫 N rejection(s)`。
- **(5) 工具失败观测计数器（opt-in）**——按工具调用 id 去重的滚动窗口（`slice(-128)`）+ 成功清零，刻意**非**任务失败数（仅观测、不参与完成 / 停止判定）；侧栏 `🛠 N tool failure(s)`。

### 修复

- **(1) 验证输出采集上限**——`defaultSpawn` 原先 `stdout += chunk` 无上限累积，啰嗦命令（失败测试全量输出）可撑爆内存；改为边读边按 8KB 头尾截断（新导出 `appendBoundedCapped`，首错 / 末错都不丢），最终仍由 `buildVerifyDetail` 做权威 8KB 截断。
- **(3) 升级提示阈值化（breaking）**——删除「整条替换的两档」`escalationMessages`，改为「基础 `message` + 轮次压力梯（`escalationPressureLadder` 6 档 3/7/15/30/50）+ `rejections≥3` REASSESS 追加 + `≥5` 退回需求追加」（`selectPressureMessage` / `composeRejectionPrompt`）。
- **B 健壮性**——强杀前 1s 温和终止（`graceMs`）；`verifyTimeoutMs` 钳 `1s..3600s`、`verifyMaxIterations` 钳 `0..10000`。

### 默认值变更

- `observeToolFailures` 默认 `false`（工具失败观测为 opt-in）。

### 验证

- **未做（主动否决）**：「删 V2 死路径」——`message.updated` / `session.error` / `info.role` 为**有意保留的 V1 兼容路径**（`test/server.test.ts` 5 处用例 + changelog 0.3.11 锁定），删除会破坏测试并回退既定决策，收益仅「少几行」，风险与收益不匹配，故不执行。
- `dist/tui.js` 已重建。
- 单测 119→136（新增 `test/verify-safety.test.ts` 4 项 + `test/server.test.ts` 13 项）。

> 注：该表述为 v0.5.0 当时状态，后续版本已变更（见 v0.5.2）——`verifyMaxIterations` 默认值由 `0` 改为 `50`。

---

## v0.4.0

日期：2026-10-31

参考 `MichengAI/dsh-pua` 移植，用户选定范围；设计稿 `docs/architecture/provenance-and-loop.md`。

### 修复

- **(1) 注入溯源（修真实 bug）**——注入的「继续执行」原先经 `session.prompt` 落库为 `type:"user"`，被引擎当成真实用户消息 `resume()`，使本轮 `injections` 每次注入即归零（`maxConsecutive` 停止保障形同失效）并误设 `userGraceMs` 安静期。
  - 改为优先 `session.synthetic`（落库 `type:"synthetic"`，结构可区分）并带 `metadata.origin="opencode-autocontinue"`，回退 `prompt` + `metadata`。
  - 引擎 user 分支按 `item.payload.metadata`（本机 schema 实测为 payload 嵌套）判来源，仅真实用户消息才 `resume()`。
  - 另加**自回声兜底**（记录上次注入文本，窗口内文本相同的入站消息视为自身回声），使修复不依赖宿主是否回流 metadata。

### 新增

- **(2) 验证驱动续跑 Loop（opt-in，`verifyCommand`）**——完成不再只信模型自报：仅当检测到完成信号（标记 / `doneSentinel`）才运行独立命令，按 exit code 判定；通过→done，失败→两档升级提示 + 验证输出续跑。
  - 含超时杀进程树、陈旧结果丢弃（`roundId`）、hydrate 归一化（`rejections` / `roundId`）、spawn 不可用降级为「沿用完成信号」防无限升级、`verifyCwd` 默认取 `ctx.location.directory`。
- **(3) 终止哨兵**——`completionMarkers` 默认追加 `<promise>LOOP_DONE</promise>`。

### 验证

- **安全**——验证输出按不可信数据（声明行 + 控制字符清洗 + 头尾 8KB 截断），哨兵检测只读 assistant 消息。
- `verifyCommand` 未配置时行为与 v0.3.16 完全一致。
- 单测 91→119。

---

## v0.3.16

日期：2026-10-30

### 新增

- **可观测性：新增 `totalInjections`**（本次 watch 起的累计注入次数，不随用户消息清零），TUI 侧边栏优先展示该累计值，并在括号内附本轮次数。

### 修复

- **起因**——`resume()` 在每轮真实用户消息时把 `injections` 归零：这一归零本身是对的，它驱动 `maxConsecutive` 自限（含义是自上次用户消息以来连续注入了几次）；但 TUI 把本轮计数当成总注入次数展示，于是用户刚回一句就看到「🔄 0 injections」，误以为插件失效。

### 验证

- `injections` 语义不变（仍为本轮计数、驱动 `maxConsecutive`、footer 停止态仍显示本轮数）；新增的 `totalInjections` 仅纯增量，贯穿 WatchState / WatchStatus / RPC 契约 schema / state.changed 事件 / TUI 显示链路，向后兼容（缺字段时回退到 `injections`）。

---

## v0.3.15

日期：2026-10-21

### 修复

- **会话卡在「streaming」工具上无法续跑**（真实故障，发生于「opencode-db-insight 插件开发与三版发布」）。
  - **现象**——模型在发出一个 shell tool 调用后中断，但该 tool part 的 `state.status` 永久停在 `"streaming"`（无后续终态消息落库），成为会话最后一条消息。
  - **根因**——`looksIncomplete` 规则 B（非终态 tool 无 tool_result → 视为「工具在途」）直接把 `maybeInject` 回退，使该会话被钉死在 watching、永远不继续。该规则依赖「工具最终会变成终态」的假设，工具被中断 / 异常终止时会误判。
  - **修复**——`looksIncomplete` 规则 B 改为时间敏感：v2 非终态 tool 仅当近期活跃（`time.streamed/created` 在 `toolStaleMs`（默认 60s）内）才视为「在途」；滞留的 orphaned tool（如本次 30 分钟无活动）不再阻止续跑，与 v0.3.13 的 `lastActiveAt` 过期自愈设计一致。v1 `tool_use`（无 time 字段）保持严格行为。

### 验证

- 添加 1 个回归用例（近期 streaming tool 仍不完整 / 滞留 streaming tool 视为死、可续跑 / 终态 tool 不完整），测试 90→91。

---

## v0.3.14

日期：2026-10-20

修复两个实际问题（整体代码审视发现）。

### 修复

- **(1) index.ts**——`rpcImplementation.set` 闭包引用后声明的 `engine`（const），而 `ctx.rpc.register` 在 `engine` 存在前就运行。不过 `register` 只存储实现不同步调用方法，所以运行时安全；但若宿主在注册时同步调用 `set`（或任何重排）会触发 TDZ `ReferenceError`。修复：在 `rpcImplementation` 之前构造 `engine`，删除后续重复声明。
- **(2) config.ts**——`intervalMs` 被 `Math.max(1_000, ...)` 夹制，使文档化的「0 = 禁用定期检查」无法通过配置达到（`scheduleInterval` 已支持 `<=0` 禁用）。修复：保留 P2-7 正值 1s 下限，但 `0` 直通传递，让禁用路径可用。

### 验证

- 添加 1 个回归用例（`intervalMs:0` 保持 0），测试 89→90。

---

## v0.3.13

日期：2026-10-20

### 修复

- **定期注入会插断正在运行的会话**。用户提出：固定间隔（`intervalMs` 默认 1h）到时后若会话还在运行，不应发送预置消息。
  - **根因**——原实现仅依赖 `lastBusyAt`（60s 滑动窗口）判断模型是否忙碌，对长流式输出 / 长思考（>60s 无 busy 事件刷新）可能误判为空闲而插入。
  - **修复**——新增 `InMemoryState.lastActiveAt`（毫秒时间戳），由 v2 的 `session.execution.started` / `session.step.started` / `session.step.streamed` 事件和 busy / retry 状态刷新（均已核实存在于 v2.0.29 types.d.ts，携 `data.sessionID`）；`maybeInject` 在 `Date.now() - lastActiveAt < idleDelayMs` 时跳过注入，保证「会话还在跑就不发」，且阻断事件失败时可自动过期恢复（不会永久卡死）。
  - 保留原 `lastBusyAt` 60s 守卫不变，不破坏现有功能。

### 验证

- 添加 3 个回归用例（运行中不注入 / 稳定后恢复注入 / execution 与 step 事件刷新 lastActiveAt），测试 86→89（server 76→79）。

---

## v0.3.12

日期：2026-10-18

### 修复

- **完成检测被 5 分钟 `userGraceMs` 无限延迟 + 背景子代理防误拉**。
  - **用户反馈**——模型输出 `[任务完成]` 后，插件仍在 watching 未停止。
  - **根因**——`userGraceMs: 300_000`（5 分钟）过长，且任何用户消息（包括追问「怎么还不停」）都会重新计时安静窗口，完成检测被无限推迟。
  - **修复 (1)**——`userGraceMs` 默认 `300_000` → `15_000`（缩短安静窗口），完成检测及时触发。
  - **修复 (2)**——新增「背景工作防护」：`latestAssistantText` 扫描 synthetic 子代理消息（`metadata.source=="subagent"` 且 `metadata.state` 非终态 completed/cancelled/error/failed），`maybeInject` 与事件处理路径均在完成判定前检查——子代理仍在跑则不标记 done、不注入、继续 watching，完成后才进入 finalCheck/done，避免背景任务未完成时误判「真正完成」。

### 验证

- 添加 2 个回归用例（跑中子代理带标记不 done / 完成子代理带标记正常 confirming），测试 84→86（server 74→76）。

---

## v0.3.11

日期：2026-10-16

修复（审视发现，与宿主 v2.0.29 消息 / 事件形状失配导致完成检测与事件驱动全部失效）。

### 修复

- **(1) 消息形状**——宿主 `session.context()` 返回 v2 消息 `{type:"assistant", content:[...]}`（无 v1 的 `info.role` / `parts`），引擎 `latestAssistantText` 读 v1 字段 → `assistantCount` 恒 0 → 完成标记检测 / finalCheck 复查 / done 全成死代码，值守无限注入（模型回复 `[任务完成]` 后引擎看不见）。
  - 修复：按 `type === "assistant"` 识别 v2 消息，从 `content` 数组取文本（`messageText` 已兼容 `{type:"text",text}` 结构），保留 v1 `info.role` / `parts` 兜底。
  - `resolveTitle` 同修——v2 的 title 在 `session.get()` 返回的 `SessionInfo.title`，不在消息上，双路径读取（SessionLike 接口加 `get`）。
- **(2) 事件形状**——引擎监听的 `session.error` / `message.updated` 在 v2 事件流中不存在（实际为 `session.execution.failed` / `session.retry.scheduled`（data.error）、`session.inbox.enqueued`（data.item.type="user" 用户消息重置）、`session.message.content.updated`（流式 content）、`session.execution.interrupted`（用户 Esc）），且 v2 `session.status` 的 status 在 `data.status`、`session.idle` 无 outcome 字段。
  - 修复：各 case 补 v2 别名与 data 字段源，v1 路径保留。
- **(3) `looksIncomplete` 工具在途判定**——v2 tool part 是 `{type:"tool", state:{status:"streaming"|"running"|"completed"|"error"}}`，原只认 v1 `tool_use` / `tool_result` 且 `type:"tool"` 被双计为已返回，导致 v2 下在途工具被当作已完成而注入。
  - 修复：v2 tool 按 `state.status` 终态判定。

### 验证

- 单测 77→84（server.test.ts 67→74，新增 7 个 v2 形状回归用例：completion 经 content 检测 / 提问跳过 / 工具在途跳过 / title 经 session.get 排除 / execution.failed 调度注入 / inbox user 进入宽限 / execution.interrupted 停止）。

---

## v0.3.10

日期：2026-10-14

修复（审视发现 v0.3.9 折叠新功能 bug）。

### 修复

- **折叠状态被宿主重挂载重置**——`isCollapsed` 原声明在 `SidebarStatus` 组件体内（tui.tsx:260），而宿主会频繁重挂载侧栏 slot——本仓库自身注释明说 "the host may re-mount the sidebar often"，usage-meter 也因此在 v0.7.13 把折叠状态持久化到 settings store（其注释："another instance flipped it ... otherwise a click after a cross-instance takeover would write the store value back unchanged"）。每次宿主重挂载 → 组件体重跑 → `createSignal(false)` 新建 → 点击折叠被下次挂载立即重置，功能表现如同失效。
  - 修复：`isCollapsed` / `setIsCollapsed` 提升到 **setup 作用域**（与 `statusStore` / `lastSlotSessionID` 同级，跨挂载存活），组件体内重复声明删除。

### 新增

- **静态交付守卫**——补 `test/tui-delivery.test.ts` 静态交付守卫 6 锁（oracle Experiment C，无真机依赖）：裸 solid-js 深路径禁令 / dist 无深路径泄漏 / package.json 无 peerDependencies / exports 指向 dist bundle / bundle 已提交且含折叠标记 / bundle 非陈旧（src 标记在 bundle 内）。
- **发布工具链缺口修复**——`verify-install.ps1` 只核对 src/test/docs 三棵树，v0.3.9 起 TUI 渲染代码唯一交付载体是 `dist/tui.js`，加 dist 树核对断言（7→8 项 PASS）。

### 验证

- 单测 71→77。

---

## v0.3.9

日期：2026-10-14

修复（oracle 定案，用户真机第三项报障「on/off 后侧栏不立即出现 / 消失」）。

### 修复

- **v0.3.8 的响应式链路被寄生 solid 实例割裂**——`tui.tsx` 从 `solid-js/dist/solid.js`（深路径）导入信号原语，而 `@opentui/solid` 内部也从同路径导入；宿主 v2.0.29 下插件 stamp 的 `peerDependencies`（@opentui/* + solid-js 1.9.12）被安装成**寄生副本**，解析到与宿主不同的模块实例，solid 的 observer 栈是模块级私有 → thunk render effect 永远订阅不到插件的 `content` memo → 树冻结在挂载快照。
  - 叠加 `reactive-mount.ts` 用了 usage-meter **已回滚废弃的 0.7.22 createRoot + swap-dispose 模式**（宿主树里挂死图）。
  - 修复对齐 usage-meter v0.7.25 proven 配方三层：
    1. `solid-js/dist/solid.js` → 裸 `solid-js`（与宿主同实例）；
    2. `reactive-mount.ts` 整文件替换为 OMO-Slim reactiveElement 模式（`createElement` + `insert`，无 createRoot、dispose 空，生命周期交给宿主 slot 机制）；
    3. 删除 `peerDependencies`（去寄生副本源头），预构建 `dist/tui.js`（esbuild bundle，`@opentui/*` / `solid-js` 全 external，`exports["./tui"]` 指向 bundle，对齐 usage-meter / OMO-Slim 交付路径）。

### 新增

- **Watch 块标题支持点击折叠 / 展开**（`onMouseUp` + 本地 `isCollapsed` 信号 + `requestRender`，对齐 usage-meter Stats 头；标题 / 内容全部函数子节点 `{() => ...}`，杜绝 JSX 插值 untrack 冻结）。

### 验证

- 单测 71/71 不变（TUI 渲染层不在 server 测试覆盖内）。
- 事实核验：usage-meter v0.7.25 package.json（无 peerDeps + dist 交付）、reactive-mount.ts 头注释（0.7.22 createRoot 回滚史）。

---

## v0.3.8

日期：2026-10-14

修复（oracle 定案：v0.3.5 / v0.3.6 两轮均未打中症状 2 真实根因）。

### 修复

- **右侧栏默认常驻 Watch 块的根因在渲染层死闸门**——`<Show when={() => content() !== null}>` 里的 `when` 是函数，Solid 的 `Show` 从不调用它（`createMemo(() => props.when)` 值是函数对象本身，恒 truthy），子节点无条件渲染，静态 "Watch" 标题永远在屏。v0.3.6 的 content 终态过滤与 hydrate 丢弃都在数据层，不碰这个闸门，故症状必然复现。
  - 修复：FooterIndicator 与 SidebarStatus 全部移除 `<Show>` 死闸门，改 usage-meter v0.7.22 实证模式——容器常驻 + **tracked 函数子节点 thunk** 门控（`insertExpression` 对每个 thunk 建 render effect，`content()` 变化即重跑；null 清空子树、非 null 插入子树）——on 立即出现、off 立即消失、无需宿主重挂。
  - 同时删除 `Show` import 与三处误导注释。
  - v0.3.6 的数据层改动保留（无副作用）。

### 验证

- 单测 71/71 不变（TUI 渲染门不在 server 测试覆盖内，后续补挂载探针）。
- 事实核验：`Show` 源码 solid-js/dist/solid.js L1473-1491 与 @opentui/solid jsx-runtime L17-23、usage-meter sidebar-metrics.tsx L240-244 对照。

---

## v0.3.7

日期：2026-10-14

测试补充 + 文档同步（0.3.6 两项修复的固化）。

### 新增

- **会话 ID 解析链抽为纯模块 `session-resolution.ts`**（`slotSessionIDFrom` 解包 JSX props 包装层 + `resolveSessionID` 三级回退链），tui.tsx 改为调用该模块——0.3.6 的「No current session」修复自此有单测锁（此前 tui.tsx 零测试覆盖）。
- **新增 `test/session-resolution.test.ts` 4 锁**：包装层解包回归锁 / 裸 slot props 与非法值拒绝 / 三源优先级次序 / 命令时无 slot props 走缓存再走 router。

### 验证

- 单测 67→71。
- 文档：`runtime-lessons.md` 新增「JSX props 包装层」取证条目；`module-layout.md` 补 `session-resolution.ts` 模块。
- src 有重构（行为零变化）故按发布纪律 bump 0.3.7。

---

## v0.3.6

日期：2026-10-14

修复（用户真机两项报障）。

### 修复

- **(1) `/autocontinue on` 报「No current session」**——`FooterIndicator` 作为 JSX 函数组件收到的是 props 包装对象 `{slotProps}`，原实现直接在包装层读 `.sessionID` 恒为 undefined，`lastSlotSessionID` 从不缓存，命令执行时三级回退（slotProps → 缓存 → router）全空。
  - 修复：先解包 `componentProps.slotProps` 再解析（对齐 usage-meter `FooterStatus` 实证形状）。
- **(2) 右侧栏默认常驻 Watch 块**——server 对 done/stopped 终态条目保持 `watched=true`，且 hydrate 跨重启复活历史终态行，侧栏挂载即水合出非空内容。
  - 修复：侧栏块只渲染活跃值守（watching/confirming），终态反馈由 footer 指示符与命令 toast 承载；hydrate 丢弃终态行，下次 persist 重写存储自然清除。

### 验证

- 单测 65→67（新增 hydrate 终态丢弃、终态不回写两锁）。
- 另：测试套件收尾退出挂起为历史既有（残留句柄致 node stdout 管道缓冲不落盘、summary 迟迟不可见，`--test-force-exit` 收敛；stash 基线对照实锤与本次改动无关）。

> 注：该表述为 v0.3.6 当时状态，后续版本已变更（见 v0.5.3）——测试不再依赖强制退出参数。

---

## v0.3.5

日期：2026-10-13

### 修复

- **TUI 侧栏 / footer 仍不实时刷新（v0.3.3 / v0.3.4 后复现）**——根因 effect 归属：slot render 直接返回含函数子节点的 JSX 时由宿主插入，渲染 effect 落在宿主模块图，插件 signal/memo 跨图订阅失败，树冻结在挂载快照。
  - 对照同宿主真机参考 opencode-usage-meter v0.7.22（pitfalls #13）修复：新增 `reactive-mount.ts`，slot render 改为插件自建 core box + 自插 render（effect 全在插件图）；solid 原语统一 `solid-js/dist/solid.js` 避免双实例。

### 验证

- 纯 TUI 变更。

---

## v0.3.4

日期：2026-10-08

修复：完成复查流程两个缺陷 + 侧栏展示两个缺陷。

### 修复

- **(B1) confirming 后模型未回复前，旧标记消息仍是最新，任意 trigger 都会把会话提前判完成、跳过整体复查轮**——改为按 assistant 消息数区分：第二次标记只认「复查新回复」里的。
- **(B2) 复查回复无标记时应回到 watching 继续值守（保留注入计数），而不是注入通用续跑消息**——新增 `continueWatching`。
- **(H1) TUI 收 `state.changed` 事件整体替换条目丢失 `since`，侧栏 ⏱ 退化为 "⏱ …"**——改为与现有条目合并。
- **(H2) confirming 态 ⏱ 冻结**——计时器 tick 条件由 `watching` 扩为 `watching` / `confirming`。

### 验证

- 单测 62→65。

---

## v0.3.3

日期：2026-10-08

### 修复

- **TUI 侧栏 / footer 不实时刷新**——⏱ 不走秒、`/autocontinue on|off` 后不更新，必须切换会话才生效。
  - **根因**对照同宿主真机验证参考（opencode-usage-meter v0.7.16）：JSX 急切插值 `{content()}` 在 esbuild `--jsx=automatic` 下于组件挂载时一次性求值（createComponent 在 untrack 中跑组件体），memo 每个 tick 重算但插值读的是挂载快照，树冻结；且宿主按需绘制、树更新 ≠ 重绘。
  - **修复**——动态叶子改函数子节点 `{() => content()}` / `{() => label()}`（insertExpression 建跟踪 render effect），`<Show when>` 同改；侧栏 1s tick 与 `updateStatus` 后补 `context.renderer?.requestRender?.()` 强制上屏。

### 验证

- 纯 TUI 变更，单测 62→62 不变。

---

## v0.3.2

日期：2026-10-07

### 修复

- **用户手工停止对话（Esc）后 watch 状态仍停在 `watching` 并继续注入**——引擎的 `session.idle` 分支忽略事件的 `outcome` 字段。
  - **实测**——手工停止时 opencode 发 `session.idle` + `outcome="interrupted"`（紧随 assistant 消息 `error:{type:"aborted", message:"Step interrupted"}`）。
  - **修复**——新增 `idleOutcomeFromEvent`（兼容平铺 / properties / data 三形状），`session.idle` 遇 `interrupted` 即 `markStopped` + 清定时器 + 停止 interval + 发 `state.changed("stopped")`，不调度注入；其他 outcome（succeeded / failed）保持续跑行为。

### 验证

- 单测 59→62。

---

## v0.3.1

日期：2026-10-06

### 修复

- **侧栏状态显示去重**——`⏱` 行与 `🎯` 行的状态语义重复（`⏸` / `✓` 符号 vs 文字状态）。合并后 `⏱` 只在值守中（watching/confirming）显示时长，stopped/done 不再显示符号行，状态统一由 `🎯` 文字行表达（对 confirming 更精确，原符号无对应）。

### 验证

- 纯 TUI 变更，无服务端逻辑改动。

---

## v0.3.0

日期：2026-10-06

**架构级重构（统一注入管线）**。

### 新增

- **(1) 合并 🔁 resume 与 💓 keep-alive 为单一 `injections` 计数**——删除 `tryInject` / `tryKeepAlive` 双路径，统一为 `maybeInject` 单入口（interval 定时器 / `session.idle` / 错误恢复全部汇入），`maxConsecutive` 语义改为单轮注入上限（0=不限）。
- **(2) 完成确认机制**——完成标记命中后注入 `finalCheckMessage` 进入 `confirming` 复查轮，再次命中才 `done`（`finalCheckEnabled` 可关，默认开）。
- **(3) 新增 `watchTimeoutMs` 单轮值守时长上限**（0=无期限）。
- **(5) WatchState 加 `confirming` 状态**，hydrate 迁移旧 `consecutive` + `heartbeats` → `injections`。

### 修复

- **(4) 删除 `intervalMessage` 配置**（并入 `message`，breaking）。

### 验证

- 单测 55→59。

> 注：该表述为 v0.3.0 当时状态，后续版本已变更（见 v0.5.2）——`watchTimeoutMs` 默认值由 `0` 改为 24 小时。

---

## v0.2.5

日期：2026-10-05

### 修复

- **侧栏 💓 心跳计数显示恒为 0**——`state.changed` 事件只携带 `{sessionID,state,consecutive}` 不含 `heartbeats`，TUI 事件处理用缺字段对象整体覆盖本地状态导致计数被冲回 0（会话中实际已注入多条心跳消息）。
  - 修复：事件 schema 声明 `heartbeats`，`emitStateChanged` / `emitChanged` / `emitChangedInternal` 全链透传，TUI 事件处理解析并写回。

### 验证

- 单测 54→55。

> 注：该表述为 v0.2.5 当时状态，后续版本已变更（见 v0.3.0）——`heartbeats` 字段已并入 `injections`。

---

## v0.2.4

日期：2026-10-05

### 新增

- **注入前「任务真完成」校验增强**——`looksIncomplete(text, parts)` 三态判定：
  - **A** 最后消息以 `？` / `?` 结尾 → 模型在提问等用户；
  - **B** 最后消息含 `tool_use` 无 `tool_result` → 工具执行在途；
  - **C** 纯文本 ≤8 字符且为确认语（好的 / 明白 / 了解 / 收到 / OK 等）→ 在等指令。
  - 命中任一即跳过本轮注入 / 心跳（不 markDone、不 stopKeepAlive，等下一轮再查）。

### 修复

- `tryInject` 与 `tryKeepAlive` 注入前共用检查，`latestAssistantText` 改为返回 `{text, parts}`。

### 验证

- 单测 50→54。

---

## v0.2.3

日期：2026-10-05

### 新增

- **侧栏值守块新增保活心跳计数行**（`💓 N keep-alives`）——`tryKeepAlive` 注入成功后 `recordHeartbeat` 计数并持久化；`WatchState` / `WatchStatus` 加 `heartbeats` 字段，RPC status schema 声明，watch/resume 重置、hydrate 归一化。

### 验证

- 单测 49→50。

> 注：该表述为 v0.2.3 当时状态，后续版本已变更（见 v0.3.0）——`heartbeats` 字段已并入 `injections`。

---

## v0.2.2

日期：2026-10-05

深度审查修复（oracle 全量审查：无 P0，2 P1 / 10 P2 / 10 P3）。

### 修复

- **P1-1 心跳补值守窗口检查**——`startTimeNotReached` / `endAt` 已过→停止，不再窗口外注入。
- **P1-2 心跳与注入共用 `inFlight` 锁跨 await**——完成标记检查窗口期不再双注入。
- **P2**——hydrate 归一化旧数据防 schema 失败、注入前复查 userGrace、`message.updated` 兼容扁平 `event.info`、完成检测节流 2s、`pendingContinue` 闩锁超时（idleDelayMs/30s 兜底）、resume 重算已过窗口、`clearTimer` 公开供 off 路径清理。
- **P3**——标题空串不缓存、`intervalMs` 下限钳制 1s、无窗口 `{remaining}` 渲染「不限」、`errorPatterns` 的裸 `"5"` 收紧为 `"(status: 5"`、persist 串行化、titleCache 随 unwatch 清理。

### 验证

- 单测 41→49。

---

## v0.2.1

日期：2026-10-05

### 新增

- **保活心跳**（`intervalMs` / `intervalMessage`，默认 1h）——值守会话周期性注入固定话术，模型 busy / 恢复注入在途 / 完成标记 / 非值守时跳过，不递增 `consecutive`；watch/unwatch/停止路径启停定时器。

### 修复

- `lastInjectedAt: undefined` 触发 RPC schema 校验失败（`Expected number`）导致 status 报错与切会话后标记消失（序列化时省略 undefined 字段）。
- footer / 侧栏 JSX 改直接读 memo getter（`{label()}` / `{content()}`）修复 `/autocontinue on` 后图标不立即出现（usage-meter v0.7.8 同款）。
- `⏱` 时长支持 天 / 小时 单位（`613m` → `10h 13m`）。

> 注：该表述为 v0.2.1 当时状态，后续版本已变更（见 v0.3.0）——`intervalMessage` 被删除并并入 `message`，`consecutive` 与 `heartbeats` 合并为 `injections`。

---

## v0.2.0

日期：2026-10-04

### 修复

- **TUI 值守块修复**——每会话独立状态表替代全局信号（多会话同时值守互不覆盖）；动态读全部移入 createMemo（侧栏 / footer 立即刷新，无需切 session）；RPC status 输出 schema 全声明字段（`since` 透传，侧栏时长正确显示）；slash `status` 直接读 RPC 结果；`currentSessionIDFrom` 优先 slot 缓存的 lastSlotSessionID；TUI 显示全英文（Watch / resumes）。
- 另修复 RPC client contract 必须声明 methods（`rpc.set is not a function` 根因）。

---

## 开发阶段记录（A–C / D / E / 文档 / 审计修复）

日期：2026-10-03

### 新增

- **A–C 完成**——骨架 + RPC + server 核心（config/state/events/engine/prompt）+ TUI（slash 命令 + footer slot）全部实现。

### 修复

- **审计修复**——深度审查修复（S1-S5 + M3/M4/M5/M7）：TUI 跨会话信号污染、off 后 footer 残留、跨午夜窗口、空 markers 匹配一切、inFlight 竞态、单引号 JSONC、resume 闩锁、error status 匹配。

### 验证

- **A–C 完成**——`node --test test/server.test.ts` 25/25 pass；esbuild 打包通过。
- **阶段 D**——待实机验证：本地 file:// 加载、续跑注入实测、卸载干净性。
- **阶段 E**——待发布：推送前脱敏扫描、GitHub 发布、plugin update 验证。
- **文档**——文档体系重构：DESIGN.md 单文件 → `docs/` 总览 + guides/features/architecture/decisions 分类分文件，根 README 瘦身为入口页。纯文档变更，无代码改动。
- **审计修复**——单测 25→35，esbuild 双绿。
