# 决策与裁定索引

本文是 opencode-autocontinue 的**决策索引**：回答「某个机制为什么这么定、哪些方案被否决」。

- 逐版本的完整取证过程（上游比对、宿主 API 核实、评审结论、逐版本落地记录）已移至
  [loop-evidence.md](loop-evidence.md)。
- 现行实现的准确规格（判定链、停止条件、注入与验证流程）见
  [loop-mechanisms.md](loop-mechanisms.md)。
- 事件词汇、持久化字段与状态机图见 [events-and-state.md](events-and-state.md)。

本文只保留**结论与关键理由**，不复述取证过程；每条决策的原始论证以「依据」列指向对应文档。

## 目录

- [§1 已裁定事项索引](#1-已裁定事项索引)
- [§2 决策明细](#2-决策明细)
- [§3 不移植清单摘要](#3-不移植清单摘要)
- [§4 相关文档指向](#4-相关文档指向)

---

## §1 已裁定事项索引

| # | 决策 | 裁定结论 | 被否决的备选 | 依据 |
|---|---|---|---|---|
| D1 | 注入通道优先级 | 优先 `session.synthetic`（落库 `type:"synthetic"`），失败回退 `session.prompt` + `metadata`；两路都带 `metadata.origin` | 只用 `session.prompt` 纯文本——注入回流被当真实用户消息，`maxConsecutive` 停止保障失效 | loop-evidence §0、§2；loop-mechanisms §1 |
| D2 | 注入来源判定 | 三层 metadata 兜底读取（`item.payload.metadata` → `item.metadata` → `info.metadata`）+ `isPluginInjection` 守卫 | 只读 `item.metadata`——本机 schema 实为 payload 嵌套，读不到就退化成「无来源信息」 | loop-evidence §2.2；loop-mechanisms §1.2 |
| D3 | 自回声兜底 | 引擎记录 `lastSelfInjection`，窗口内**文本逐字相等**即判回声（不触发 `resume()`）；**无文本**时按 `selfEchoWindowMs` 时间窗兜底；文本**不同**时绝不误吞 | 完全依赖宿主回流 `metadata`/`synthetic`（两项都属未证实假设） | loop-evidence §2.3；loop-mechanisms §2 |
| D4 | 验证驱动 Loop 的门控语义 | 仅当检测到完成信号才跑验证命令；完成**只**认独立命令的 exit code | 无信号也验证——干净树上的 `npm test` 会立刻误判 done；只认模型自报——模型自报即信 | loop-evidence §3.1、§3.4；loop-mechanisms §3.1、§3.4 |
| D5 | 失败上限的判定顺序 | verify-then-cap：先验证，通过即 done，失败才判上限 | cap 前置——与原折中自相矛盾，且所谓「省一次子进程」在数学上并不成立 | loop-evidence §3.6；loop-mechanisms §3.4 |
| D6 | 验证安全 | 输出按**不可信数据**处理：声明行 + 控制字符清洗 + 8KB 头尾截断；哨兵与完成标记检测**绝不**扫描验证输出 | 把命令输出直接拼进 prompt——验证输出可自我终止循环 | loop-evidence §3.7；loop-mechanisms §3.6 |
| D7 | spawn 不可用时的降级 | `spawnUnavailable` → `pass=true`，沿用模型的完成信号 | 视为失败并重试——验证不可能时无限升级 | loop-evidence §1.3、§3.3；loop-mechanisms §3.3 |
| D8 | 终止哨兵（第一轮） | 只保留 `doneSentinel`（`<promise>LOOP_DONE</promise>`）；abort/pause 暂缓 | 第一轮同时上 abort/pause——默认单标签与「成对匹配」自相矛盾，且与 `completionMarkers` 近乎重复 | loop-evidence §4；loop-mechanisms §4 |
| D9 | 终止哨兵（第二轮） | 补回成对标签的 abort/pause：abort → `stopped`、pause → `paused`（等待用户输入后经 `resume()` 恢复） | 单标签写法；把 abort/pause 一律记为停止（会丢掉「等待用户补充」这一语义） | loop-evidence §7.2；loop-mechanisms §4 |
| D10 | 升级提示的形态 | 基础 `message` + 6 档轮次压力梯 + `rejections ≥ 3` REASSESS + `≥ 5` 退回需求（`escalationMessages` 于 v0.5.0 breaking 删除） | `escalationMessages` 整条替换两档；五档分桶（属猜测，降为两档后再细化） | loop-evidence §3.5、§7.3；loop-mechanisms §3.5 |
| D11 | 压力梯的挂载变量 | 按**验证拒绝数** | 按上游的 loop 迭代计数——上游把未经验证的续跑轮次也计入，噪声更大 | loop-evidence §7.3.1；loop-mechanisms §3.5 |
| D12 | 阈值叠加而非互斥 | `rejections ≥ 5` 时 REASSESS 与根因句**都加** | 上游的 `else-if` 互斥（≥5 只给根因句） | loop-evidence §7.3.1 |
| D13 | 工具失败观测计数器 | opt-in（`observeToolFailures` 默认 `false`），去重 + 成功清零，**只观测不参与任何完成/停止判定** | 默认开启；把它当作任务失败数 | loop-evidence §7.5；loop-mechanisms §6 |
| D14 | 挫败感触发 | 缩减后借鉴 + opt-in（`frustrationTriggers` 默认 `[]`）：命中真实用户消息后装饰**下一次**注入 | 原样移植——上游挂在同一轮，我方只有「新开一轮」的通道；默认开启——误判会把一句斥责塞进正常轮次 | loop-evidence §9.2、§9.4；loop-mechanisms §5 |
| D15 | 无人值守护栏 | 默认上界 `watchTimeoutMs = 24h`、`verifyMaxIterations = 50`；`0` 仍表示无限，用户可显式写 0 恢复 | 默认全 0——无人值时没有任何上界 | loop-evidence §9.5；loop-mechanisms §6.1 |
| D16 | 停止原因可观测 | `stopReason` **八值**贯通持久化 → `markStopped` → 引擎各停止点 → RPC schema → footer / toast 短语 | 只发 `state:"stopped"`——用户无法区分护栏停止、窗口到点、用户中止与模型 abort 哨兵 | loop-evidence §9.5；loop-mechanisms §6.2 |
| D17 | 标题排除的停止原因 | v0.5.3 补第 8 个取值 `title-excluded`（footer 短语 `title excluded`） | 无参 `markStopped(sessionID)`——会清空既有原因，footer 只剩裸 `[AC ⏹ N]` | loop-mechanisms §9.3 |
| D18 | 停止原因的单一真源 | v0.5.3：`STOP_REASONS` 唯一定义在 `src/rpc.ts`，两处 schema enum 与 `RpcContract` 联合类型全部派生；`src/state.ts` 导入并再导出；TUI 标签表保持字面量形态、由测试守卫 | 四份手写副本——漏改 rpc enum 会让宿主拒绝该会话**所有** `state.changed` 事件，静默丢失全部状态更新 | loop-mechanisms §9.4 |
| D19 | 跨午夜窗口 | `computeEndAt` 跨日滚动 + `startGateClosed` 跨午夜感知（次日 00:00–`startTime` 属窗口尾段，仍算开）。**已实现，尚未实机验证** | 朴素的 `startTime` 比较——跨午夜窗口在次日清晨被误判「未到点」而不注入 | loop-evidence §8.1、§8.2；loop-mechanisms §7 |
| D20 | 墙钟预算的计量口径 | v0.5.3：按**轮次**计量（新增持久字段 `roundSince`，`watch()` 置位、`resume()` 刷新、`hydrate()` 回落为 `since`） | 按 `since` 累计——新一轮继承上一轮的剩余预算，第 2 轮起几乎立刻超时 | loop-mechanisms §9.2 |
| D21 | 注入上限的配置语义 | v0.5.3：`maxConsecutive` 负值回退基础值（默认 20），`0` 仍表示不限，非有限值回退默认 | 负值静默取消唯一的注入上限——与 v0.5.2 守护栏的意图直接冲突 | loop-mechanisms §9.1 |
| D22 | DSH 风格（风味）机制 | 整体**不移植**（风味/人设/方法论预设/角色层级/i18n/降压换框/钉味提醒库/feedback） | 逐项借鉴——多数依赖我方 `ServerContext` 没有的宿主 API；且部分与「零模型成本」冲突 | loop-evidence §9.2 |
| D23 | V2 死路径清理 | **不做**：保留 `message.updated` / `session.error` / `info.role` 分支 | 删掉死路径——会破坏 5 处锁定用例并回退 0.3.11 已记录的兼容决策，收益仅「少几行」 | loop-evidence §7.6 |
| D24 | 测试退出方式 | v0.5.3：测试必须自行退出，`npm test` = `node --experimental-strip-types --test "test/*.test.ts"` | 依赖 `--test-force-exit`——掩盖 `makeEngine()` 从不 `dispose()` 造成的 15 个残留定时器 | loop-mechanisms §9.5 |
| D25 | 全局配置路径的可注入性 | v0.5.4 起 `loadConfig` 支持可选的全局配置路径注入（`LoadConfigOptions`）。**已实现**：测试经由 `setup()` / `loadConfig()` 的注入参数指向临时目录，不再改写 `USERPROFILE` / `HOME` 这类进程级环境变量 | 靠改 `USERPROFILE` / `HOME` 隔离——进程级全局状态，同进程并行跑测试会互相污染 | loop-mechanisms §10 |

---

## §2 决策明细

### 2.1 注入溯源与自回声（D1–D3）

原始缺陷：注入用 `session.prompt` 落库为 `type:"user"`，引擎的 user 分支只看类型不看来源，
于是插件自己的注入触发 `resume()`——本轮 `injections` 每次注入即归零，**`maxConsecutive`
停止保障形同失效**，且每次注入误设 `userGraceMs` 安静期。

裁定：优先 `session.synthetic`（结构上可区分），回退 `prompt` + `metadata`；两路都带溯源标记。
**计数修复不依赖宿主是否提供 `synthetic`**。

但 `metadata` 是否回流到引擎稍后读到的消息、`synthetic` 的 `resume` 语义是否如预期，
都属未证实的宿主行为假设。故引擎记录**自己何时注入过**（`lastSelfInjection`），
按**三条规则**判回声（`src/engine.ts` 的 `isSelfEcho`）：

1. **文本相同判回声**——入站文本可提取，且与记录文本**逐字相等**；
2. **文本不同绝不误吞**——入站文本可提取但与记录文本**不同** → 一定**不是**回声，
   按真实用户消息处理（走 `resume()`、挫败感检测等真实用户路径）；
3. **无文本按时间窗兜底**——入站文本提取不到（缺失或空串），且
   `Date.now() - lastSelfInjection.at <= selfEchoWindowMs`（默认 10s）→ 判为回声。

**引擎本来就知道自己何时注入过**，这是不依赖宿主行为的保底判定。v0.5.5 起注入记录在
**整个 `selfEchoWindowMs` 窗口内保持有效**（不在首次命中时清除），宿主把同一条注入
以两种事件形状各投递一次时，第二次仍被判为回声——不会触发 `resume()` 清零三重上界。

已知限制（保留在案）：

- 真实用户在注入后 10s 内发出逐字相同的消息会被误判为回声（概率可忽略）；
- **时间窗兜底的残留风险**：真实用户消息若落在窗口内、且宿主**不提供可提取文本**，
  会被第 3 条规则判为回声而**未被处理**（既不 `resume()`，也不进入真实用户路径）。
  引擎侧无法进一步收窄——没有文本就没有可比对的依据；调小 `selfEchoWindowMs` 可降低触发概率。
  已记入 `docs/decisions/known-issues.md`，本版不修。

### 2.2 验证驱动 Loop 与其安全边界（D4–D7）

上游 dsh-pua 的核心能力代差是：完成只认**独立命令的 exit code**，不认模型自报。
我方采纳，但必须加**门控**——否则干净树上的 `npm test` 会在空闲轮立刻误判 done。
因此：完成信号只是「触发验证」的开关，完成与否**只看 exit code**。

上限判定统一为 verify-then-cap：先跑验证，通过即 done，失败才计一次 `rejections` 再判上限。
原设计的「cap 前置」与折中方案自相矛盾，且折中在数学上与上游等价、所谓「省一次子进程」并不成立。

安全上，验证输出是仓库/工具产物，属**不可信数据**：注入时加显式声明行，先
`stripControlChars` 再做头尾截断（总 ≤ 8KB）；哨兵与完成标记检测**只读 assistant 消息，
绝不扫描验证输出**——否则验证输出可以自我终止循环。

命令来自本地配置而非模型输出，故**无命令注入面**；但子进程继承宿主 env，输出可能回显敏感值，
该限制**已知且不做脱敏**。`node:child_process` 属未文档化机制，跨版本可能失效，
故命令无法启动时降级为 `pass=true`（沿用完成信号，避免无限升级）。

### 2.3 终止哨兵：从「只留 doneSentinel」到「补回 abort/pause」（D8–D9）

第一轮只保留 `doneSentinel`：原设计的 abort/pause 默认**单标签**与「成对匹配」自相矛盾，
且在非验证模式下与 `completionMarkers` 近乎重复、验证模式下又无用武之地，故暂缓。

第二轮把 abort/pause 补回，并改为**成对标签**（对齐上游）：abort → `stopped`（放弃）、
pause → `paused`（求助，等待用户补充后经 `resume()` 恢复）。判定顺序 abort → pause → done，
且 abort 置于 `backgroundWorkRunning` 守卫**之前**——显式放弃必须生效，而暂停不必打断在飞的工作。

### 2.4 升级提示：从两档到轮次压力梯（D10–D12）

第一轮的 `escalationMessages`（整条替换两档）属猜测，v0.5.0 breaking 删除，改为
「基础 `message` + 阈值追加 + 轮次压力梯」。

两处与上游**有意不等价**，记录在案以免被误判为移植遗漏：
① 压力梯按**验证拒绝数**而非上游的 loop 迭代计数——在我方设计中只有「独立检查判定不通过」
才与上游的迭代语义等价，代价是我方的压力升级在墙钟意义上比上游**更晚**；
② 阈值**叠加**而非互斥——「列 3 个不同假设」与「你可能在解决错误的问题」互补不矛盾，
且最深档最需要双提示。

### 2.5 观测型机制：工具失败与挫败感触发（D13–D14）

两者都是 **opt-in 且默认关闭**——误判的代价是往正常轮次里塞噪音。

- 工具失败计数器刻意**不是**任务失败数，只作观测：去重（滚动窗口）+ 成功清零，
  不参与任何完成/停止判定，故宿主形状漂移不会影响正确性。
- 挫败感触发是上游「机械可移植」的唯一一项：上游把它挂在同一轮，我方只有「新开一轮」的通道，
  故**降级为装饰下一次本来就要发的注入**。判定位置在自回声守卫**之后**，
  插件自己的注入回流永远不会触发；命中时**保留** `rejections`——用户抱怨本身就是
  「上一轮交付被否」的证据，此时清零计数恰好是错的。

### 2.6 无人值守护栏与停止原因（D15–D16）

v0.5.2 给无人值场景装了两道上界：`watchTimeoutMs` 24h 覆盖跨午夜夜班（22:00→08:30 = 10.5h）
且不误杀长任务；`verifyMaxIterations` 50 在默认 `maxConsecutive: 20` 之上留出余量，
同时在用户把 `maxConsecutive` 设为 `0`（无限）时仍有一道护栏。`0 = 无限` 的语义保留。

停止原因从「只有 `state:"stopped"`」升级为枚举，v0.5.2 首批 **7 值**、
v0.5.3 补第 8 值 `title-excluded`，合计 **8 值**，贯通持久化字段 → `markStopped` →
引擎各停止点 → RPC schema → TUI footer 与 `/autocontinue status` toast。
**护栏停止一律是 `stopped`，绝不是 `done`。** 侧栏保持既有契约：终态不渲染侧栏。

### 2.7 窗口与预算（D19–D21）

跨午夜窗口的起点闸必须跨午夜感知：`startTime` 22:00 / `endTime` 08:30 的窗口，
在次日 00:00–22:00 之间**仍是开着的**——朴素的 `now < startTime` 比较会在整个夜半段
误判「未到点」而不注入。
**该语义已实现，但尚未实机验证**（跨午夜的实机验证仍是待办，见
`docs/decisions/known-issues.md`）。

墙钟预算则按**轮次**计量：新一轮不继承上一轮的剩余预算。这是**修正而非收紧**，
等于把「一次性总额」还原成「每轮额度」；`since` 保留「本次值守开始时间」的语义，
供侧栏 ⏱ 时长显示。

注入上限的配置语义同样是「负值是手误」：负数会**静默取消**唯一的注入上限，
与守护栏的意图冲突，因此回退基础值；`0` 仍表示不限。

### 2.8 DSH 风格机制不移植（D22）

对上游「风格」轴做了完整取证（风味 15 套、模式 11 种、挫败感纠偏、失败升级 L1–L4、
Loop 压力 6 档、Oracle 拒绝 3 档），结论是**整体不移植**，只有挫败感触发缩减后借鉴。
决定性理由：多数机制依赖我方 `ServerContext` **没有**的宿主 API
（`ctx.systemPrompt.section` / `ctx.commands.register` / agent 注册 / 子代理派生）；
上游的 auto 路由**不是代码算的**——是把方法论路由文档塞进 prompt 让模型路由，
与我方「零模型成本」的取向冲突；上游的 verifier 只出建议且禁改文件，而我方的
验证门控**严格更强**（只认真实 exit code）。

### 2.9 v0.5.3 的三条收口（D17–D18、D20–D21、D24）

本轮是全项目审计后的修复轮，三条主线：

- **可观测性补齐**：标题排除路径此前调用无参 `markStopped`，清空原因导致 footer 只剩裸
  `[AC ⏹ N]`，补第 8 个取值 `title-excluded`。
- **配置与口径**：负值回退基础值；墙钟预算改按轮次；两处都属「修正误配」而非收紧。
- **工程卫生**：停止原因的取值集合收敛到**单一真源**（此前四份手写副本，
  漏改 rpc enum 会静默丢掉该会话的全部 `state.changed` 事件）；测试必须自行退出，
  不得靠 `--test-force-exit` 掩盖 `makeEngine()` 从不 `dispose()` 造成的 15 个残留定时器。

完整的规格、验收口径与实施清单见 [loop-mechanisms.md §9](loop-mechanisms.md#9-v053-修复规格)。

v0.5.4 的三项技术债清理（全局配置路径可注入、测试夹具去重、断言与配置常量比对）
**不改变任何运行时语义**，规格见 [loop-mechanisms.md §10](loop-mechanisms.md#10-v054-增量)。

---

## §3 不移植清单摘要

上游 `MichengAI/dsh-pua` 的以下能力**明确不移植**，逐项理由见
[loop-evidence.md 的 v0.5.2 节](loop-evidence.md#v052-风格机制评估落地--无人值守护栏)（§9.2 详版）：

1. **风味 Flavor / 方法论预设 / 味道路由**——依赖 `ctx.systemPrompt.section` 与
   `ctx.commands.register`，我方 `ServerContext` 没有；且其 auto 路由靠 prompt 让模型自行路由。
2. **模式 Mode（人设 / 角色层级 / 语言）**——需 agent 注册与子代理派生；我方验证门控严格更强。
3. **失败升级候选 L1–L4（含强制动作块与 checklist）**——行为内容用户自己就能贴进
   `escalationPressureLadder`，其自动选择器却依赖上面缺失的 API。
4. **i18n**——上游模型侧本就不本地化（只覆盖 UI）；我方 prompt 是用户自己的配置字符串。
5. **降压换框协议**——需 LLM 判定，且要按风味「说人话」，与零模型成本取向冲突。
6. **钉味提醒库**——其行为诉求（「体感是输入，验收看证据链」）已被我方 exit-code 门控**机械覆盖**。
7. **stop-feedback 问卷**——需 `jq` + `transcript_path` + 本地计数文件。
8. **两事件 surface-replace / 状态折叠 / integrity guard**——宿主专属或性价比低。

---

## §4 相关文档指向

- 「每个判定环节的准确规格」→ [loop-mechanisms.md](loop-mechanisms.md)。
- 「机制来源与各版本落地记录」→ [loop-evidence.md](loop-evidence.md)。
- 「事件载荷与持久化字段」→ [events-and-state.md](events-and-state.md)。

各文档中的历史引用（§ 编号）指向上游那份合并文档的章节号；
拆分后这些编号的正文位于 [loop-evidence.md](loop-evidence.md)，
而 [loop-mechanisms.md](loop-mechanisms.md) 的章节号是**重新编号**后的现行规格，两者不可混用。
