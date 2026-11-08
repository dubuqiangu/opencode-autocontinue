# 配置系统

两层配置，deep merge，项目级优先。加载器（`src/config.ts`）：JSONC 解析（注释 + 尾逗号），BOM 容错；坏文件回退默认值。

**引号语义**（v0.5.6 起明确）：

| 串类型 | 转义规则 | 用途 |
|---|---|---|
| 双引号串 | **严格 JSON 语义**：`\n` `\t` `\\` `\"` `\uXXXX` 等按 JSON 解释；非法转义（如 `\d`）**抛 `SyntaxError`** | 需要 JSON 转义语义时用双引号 |
| 单引号串 | **字面量语义**（Python 式 raw）：只有 `\'` → `'`、`\\` → `\` 是转义；**其它任何** `\X` 原样保留两个字符 | Windows 路径等字面量场景 |

单引号串采用字面量语义，是因为常见的 Windows 路径里含有 `\n` `\t` `\f` `\b` 这些**合法 JSON 转义字母**：若按 JSON 解释，`'C:\Users\<用户名>\name\file.txt'` 会被静默解码成 `C:\Users` + 换行 + `ame` + 换页 + `ile.txt`——路径被悄悄改错，比直接报错更危险。

## 配置文件位置

| 层级 | Unix / macOS | Windows（PowerShell 写法） |
|---|---|---|
| 全局（按用户） | `~/.config/opencode/opencode-autocontinue.jsonc` | `$env:USERPROFILE\.config\opencode\opencode-autocontinue.jsonc` |
| 项目覆盖 | 仓库内 `.opencode/opencode-autocontinue.jsonc` | 仓库内 `.opencode/opencode-autocontinue.jsonc` |

> Windows 列为 **PowerShell 写法**（可直接粘贴到 PowerShell）；cmd 下请写用户目录的绝对路径。

- 两层配置 **deep merge**，**项目级优先**（项目级同名字段覆盖全局，全局其余字段保留）。
- 项目级路径指的是**仓库根目录下的 `.opencode`**，不是用户目录里的那个。
- 合并顺序是「**默认 → 全局 → 项目**」，故项目级覆盖全局、全局覆盖出厂默认。

### 三步创建配置

1. **创建文件**：在上面的路径新建 `opencode-autocontinue.jsonc`（全局文件要先建 `opencode` 目录；项目文件要先建 `.opencode` 目录）。
2. **粘贴**：把下面「完整示例」或「最小示例」的内容粘进去（JSONC，允许注释和尾逗号）。
3. **重启**：**改完配置必须完整重启 opencode**（`opencode service restart` 或退出重开）才会生效——`/reload` 不会重载插件配置。

> **v0.5.3 / v0.5.4 也同样需要完整重启 TUI**：`/reload` 只重载会话与界面，
> **不会重载插件**，因此插件侧的配置读取与新增的运行时 API 都要在重启后才生效。
> 本文档中所有版本的新配置项一律适用这条规则。

最小示例：

```jsonc
{
  "enabled": true,
  "message": "继续执行。按既定计划推进；遇到问题先自查修复，勿中断整体任务。",
  "maxConsecutive": 20
}
```

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（`OC_AUTOCONTINUE=0` 环境变量可整体禁用） |
| `message` | `继续执行。按既定计划推进；遇到问题先自查修复，勿中断整体任务。` | 注入消息模板，支持 `{time}` `{remaining}`。**普通续跑**（错误恢复 / 空闲续跑 / 周期检查）用此消息；**完成复查轮**用 `finalCheckMessage`；**验证失败轮**用 `composeRejectionPrompt()` 组合提示（`message` + 压力梯一行 + 阈值追加句） |
| `startTime` / `endTime` | 空 / 空 | 每日值守时段（本地 HH:MM，空=不限制）。**跨午夜窗口**（`endTime` 时刻早于 `startTime`，如 22:00→08:30）：`endAt` 会在当天已过时滚动到次日；非跨日窗口当天已过即停止。跨午夜起点闸（`startGateClosed`）：次日 `00:00`..`startTime` 之间窗口仍视为开启 |
| `idleDelayMs` | `15000` | 空闲后延迟注入；同时是「会话近期仍在活动」的判定窗口（`lastActiveAt`） |
| `minIntervalMs` | `30000` | 同会话最小续跑间隔 |
| `maxConsecutive` | `20` | 单轮值守最大注入次数（`0`=不限制；**负值回退默认 20**，见 v0.5.3）。任一注入（错误恢复/周期检查/完成复查/验证失败）都计入 |
| `watchTimeoutMs` | `86400000`（24h，**v0.5.2 默认值变更**，原为 `0`） | 单轮值守最长时长（ms），超时自动 `stopped`。`0` = 无期限（区别于每日 `endTime` 窗口）。**v0.5.3 起按轮次计量**：真实用户消息开启新一轮时预算重算 |
| `completionMarkers` | `["[任务完成]", "[夜间任务完成]", "[task done]", "<promise>DONE</promise>", "<promise>LOOP_DONE</promise>"]` | 完成标记。**任一命中触发完成流程**（见 `finalCheckEnabled`）。**空数组 `[]` = 不检测完成标记**（会话持续值守） |
| `markerRegex` | 空 | 完全自定义完成标记正则。**若有效则取代 `completionMarkers`** |
| `finalCheckEnabled` | `true` | 完成标记命中后，注入 `finalCheckMessage` 进入复查轮（confirming）；复查完成（再次命中标记）才 `done`。`false` = 标记命中直接 `done` |
| `finalCheckMessage` | `请整体检查一遍项目是否存在遗漏或 bug，并同步整理项目相关文档。检查完毕确认无误后，输出完成标记。` | 复查轮注入的话术（整体检查 + 文档整理） |
| `errorPatterns` | `["bad_response_status_code", "ECONNRESET", "timeout", ...]`（节选，完整列表见下方示例） | 视为可恢复的错误特征（大小写不敏感子串）。匹配串归一为 `name: message (status: N)`（宿主给的是 `type` 时回退读 `type`），retry hook 路径与消息事件路径**产出同一个串**，同一条 pattern 不会一边命中一边失配。纯 5xx 裸状态（如 status 503 无 message）也能命中 `"(status: 5"` / `"429"` |
| `excludePatterns` | `["MessageAbortedError", "operation was aborted"]` | 永不自动续跑（用户主动中止） |
| `excludeTitleKeywords` | `["测试"]` | 标题含这些词不续跑。命中时会话停止，原因 `title-excluded`（短语 `title excluded`） |
| `userGraceMs` | `15000` | 用户最近发真实消息后 N ms 内不自动续跑 |
| `intervalMs` | `3600000` | 周期检查间隔（ms），`0` = 关闭（正值配置下限钳制为 `1000`）。每间隔向值守中的会话触发一次统一注入判定（仅当会话空闲、模型近 60s 无 busy、未命中完成标记/复查轮外、且在值守窗口内、最后一条 assistant 消息非"疑似未完成"——提问结尾 / 工具调用在途 / 短确认回复） |

## 配置校验与诊断（v0.5.5）

配置写错时**不再静默**。加载器（`src/config.ts`）在读取与合并两个阶段都会做检查，
所有告警走 `console.error`——输出到 **stderr / 宿主日志**（不是插件自己的文件），
不写进会话。

### 读取阶段

| 情形 | 行为 |
|---|---|
| 文件**不存在** | **静默**回退默认值（正常路径，不打扰用户） |
| 读取**失败**（权限、路径被目录占位、I/O 错误） | 输出一条 `console.error`，内容含**配置文件的绝对路径**与错误信息，随后回退默认值 |
| **解析失败**（JSONC 语法错误） | 输出一条 `console.error`，内容含**配置文件的绝对路径**与错误信息，随后回退默认值 |

### 合并阶段（逐键校验）

| 键 | 非法输入 | 行为 |
|---|---|---|
| `startTime` / `endTime` | 不是 `HH:MM`（时 > 23 或分 > 59） | **回退为空**（= 不限制每日窗口）并告警 |
| `markerRegex` | 源长度 > 1024 | **忽略该值**并告警（回落到 `completionMarkers`） |
| `markerRegex` | 含**嵌套量词**（ReDoS 风险） | **忽略该值**并告警 |
| `markerRegex` | 正则**不可编译** | **忽略该值**并告警 |
| `completionMarkers` / `errorPatterns` / `excludePatterns` / `excludeTitleKeywords` / `escalationPressureLadder` / `frustrationTriggers` | 数组中含**空字符串** | **剔除空串**（空串是任何字符串的子串，留着会让匹配器命中一切）**并告警**（含键名与剔除数量；剔空后数组为空时额外提示该键已无任何可用项） |
| `idleDelayMs` / `minIntervalMs` | 负值 | **钳到 0** 并告警 |
| `intervalMs` | 负值 | **钳到 0** 并告警 |
| `intervalMs` | 正值低于 `1000` | **地板到 `1000`** 并告警 |
| `watchTimeoutMs` / `userGraceMs` / `selfEchoWindowMs` | 负值 | **钳到 0** 并告警 |
| `intervalMs` / `idleDelayMs` / `minIntervalMs` | 大于 `2^31-1` | **钳到 `2^31-1`** 并告警（超出定时器可表示范围） |
| `maxConsecutive` | 负值 | **回退到基础值**（基础值不可用时回退默认 `20`）并告警（v0.5.3 起，见下） |
| `verifyTimeoutMs` | 低于 `1000` / 高于 `3600000` | **钳到边界** 并告警 |
| `verifyMaxIterations` | 负值 / 高于 `10000` | **钳到边界** 并告警 |

**不变式（v0.5.6 起）**：任何**被静默改写**的配置值，都必须产生**恰好一条** `console.error`，诊断信息含**键名、原始值、生效值**。**本来就合法的值不产生任何诊断**——下列值全部静默：

- `intervalMs = 0`（文档化语义：关闭周期检查）、`userGraceMs = 0`（不等）、`watchTimeoutMs = 0`（无墙钟上限）、`selfEchoWindowMs = 0`、`maxConsecutive = 0`（不限次）、`verifyMaxIterations = 0`（不限轮）
- `intervalMs = 1000`（1s 地板本身）、`verifyTimeoutMs = 1000` / `3600000`、`verifyMaxIterations = 10000`、各 `2^31-1` 上限本身
- 任何数组键**不含空串**时

> JSONC 解析器的**尾逗号前瞻会跳过注释**：`1, // 说明\n}` 这类写法不再被当成语法错误。
>
> `intervalMs` 的 `0 = 关闭周期检查` 语义保持可达——1s 下限只对**正值**套用。
>
> 全局配置与项目覆盖是**两层独立合并**：同一个键在两层都被改写时会各产生一条诊断（每层一次改写 = 一条诊断），因此**同一个键最多看到两条**。

## 配置生效顺序（注入判定链）

配置项不是同时生效的：守护栏类的键在**阶段一**判定，会话状态类的键在**阶段二**判定。
下表与 `docs/features/engine.md` 的「注入判定流程」**完全一致**。

| 阶段 | 判定 | 用的配置键 | 不通过时 |
|---|---|---|---|
| 一 | 值守窗口 `endAt` | `startTime` / `endTime` | 未到点 → **跳过本轮**；到点 → **停止**（`window-closed`） |
| 一 | 墙钟预算 | `watchTimeoutMs` | 用尽 → **停止**（`watch-timeout`） |
| 一 | 注入上限 | `maxConsecutive` | 达到 → **停止**（`injection-cap`） |
| 二 | 用户安静期 | `userGraceMs` | 不足 → **跳过本轮** |
| 二 | 标题排除 | `excludeTitleKeywords` | 命中 → **停止**（`title-excluded`） |
| 二 | 会话近期活跃 | `idleDelayMs` | 活跃中 → **跳过本轮** |
| 二 | 注入节流 | `minIntervalMs` | 节流中 → **跳过本轮**（到点再判定） |
| 三 | 完成标记 | `completionMarkers` / `markerRegex` / `finalCheckEnabled` / `finalCheckMessage` | 命中 → 进入完成流程 |
| 三 | 验证门控 | `verifyCommand` / `verifyTimeoutMs` / `verifyMaxIterations` / `verifyCwd` | 不通过 → 注入升级提示续跑 |
| 三 | 升级提示 | `escalationPressureLadder` / `escalationReassessMessage` / `escalationRootCauseMessage` | 按拒绝数选档追加 |
| 三 | 哨兵 | `abortSentinelTag` / `pauseSentinelTag` | 命中 → **停止** / `paused` |
| 三 | 挫败感提醒 | `frustrationTriggers` / `frustrationMessage` | 命中 → 追加一句到下一次注入 |
| — | 工具失败观测 | `observeToolFailures` | 仅观测，不参与判定 |
| — | 总开关 | `enabled` | 关闭则引擎不工作 |

> 逐环节的输入、判据与落点见 [loop-mechanisms.md](../architecture/loop-mechanisms.md)。

## 验证驱动 Loop 与哨兵（v0.4.0 起，v0.5.0 扩展）

| 键 | 默认 | 说明 |
|---|---|---|
| `verifyCommand` | 空 | 验证命令；**空 = 关闭验证驱动 Loop**（行为与仅完成标记一致）。非空时仅当检测到完成信号（完成标记 / `<promise>LOOP_DONE</promise>`）才运行该命令，按 **exit code** 判定完成 |
| `verifyTimeoutMs` | `120000` | 单次验证超时；钳制 `1000`..`3600000`（1s..3600s） |
| `verifyMaxIterations` | `50`（**v0.5.2 默认值变更**，原为 `0`） | 失败轮次上限；`0` = 不限；钳制 `0`..`10000` |
| `verifyCwd` | 空 | 验证工作目录；空 = 会话/项目目录（`ctx.location.directory`） |
| `selfEchoWindowMs` | `10000` | 自回声窗口：窗口内与上次注入文本**逐字相同**的入站「用户」消息视为自身回声，不计入真实用户轮；**入站文本提取不到**时也按此窗口兜底判为回声（见下方风险提示）。`0` = 关闭基于时间的判定（此时只有 metadata 溯源能判出回声） |
| `abortSentinelTag` | `"loop-abort"` | 成对**中止**标签名（`<loop-abort>…</loop-abort>`）；空串禁用。命中 → 会话停止 |
| `pauseSentinelTag` | `"loop-pause"` | 成对**暂停**标签名；空串禁用。命中 → `paused`，等待用户新消息恢复 |
| `escalationReassessMessage` | REASSESS 文案 | 验证被拒 `≥3` 次时追加到续跑提示 |
| `escalationRootCauseMessage` | 退回需求文案 | 验证被拒 `≥5` 次时追加 |
| `escalationPressureLadder` | 6 档 | 每次被拒追加一行，按被拒次数在 3/7/15/30/50 分档选择；空数组关闭压力行 |
| `observeToolFailures` | `false` | 启用工具失败观测计数（**仅观测**，不影响完成/停止判定）。侧栏显示 `🛠 N tool failure(s)` |

> v0.5.0 **移除** `escalationMessages`（原「整条替换两档」），改为「基础 `message` + 轮次压力梯 + 阈值追加」。
> 哨兵判定顺序固定为 **abort → pause → done**，且只读 assistant 消息文本，绝不扫描验证命令输出（验证输出视为不可信数据）。

## 挫败感触发与无人值守护栏（v0.5.2）

| 键 | 默认 | 说明 |
|---|---|---|
| `frustrationTriggers` | `[]` | 真实用户消息中出现这些**子串**（大小写不敏感）即视为「质量不满」；**空数组 = 功能关闭**（默认关闭） |
| `frustrationMessage` | `用户明确表达了对质量的不满：换本质不同的方法重新推进，并贴出可核对的验证证据（命令 + 输出），不要只改措辞。` | 命中后追加到**下一次注入**末尾的提醒句；仅在 `frustrationTriggers` 非空时生效 |

- 命中后**不新开一轮**：只把提醒句追加到本来就要发的下一次注入（追加发生在实际发送之前）。
- 合并语义：数组**替换**（同 `escalationPressureLadder`），字符串**覆盖**。
- 匹配只看**真实用户**消息，插件自身注入的回声不触发。

> **自回声时间窗的风险提示（v0.5.5）**：`selfEchoWindowMs` 窗口内，**入站文本提取不到**的
> 消息会被判为自身回声。若此时来的是一条**真实用户消息**且宿主不提供可提取文本，
> 该消息会被**吞掉**（既不 `resume()`，也不进入真实用户路径）。
> 调小 `selfEchoWindowMs` 可降低触发概率；该残留风险本版不修，
> 已记入 [known-issues.md](../decisions/known-issues.md)。

## 版本变更说明

### v0.5.5

- **配置诊断**：配置文件**不存在**仍静默回退默认值；**读取失败**或**解析失败**时输出一条
  含**绝对路径**的告警，不再「配置写错了却毫无提示」。
- **配置校验**：新增 `startTime` / `endTime` 的 `HH:MM` 校验、`markerRegex` 的长度上限
  （1024）/ 嵌套量词（ReDoS）/ 可编译三重检查、6 个数组键的空串剔除、数值键的负值钳 0
  与超大值钳上限（`2^31-1`）。详见「配置校验与诊断」。
- **JSONC 尾逗号前瞻跳过注释**：`1, // 说明\n}` 不再被当成语法错误。
- **`selfEchoWindowMs` 语义补全**：入站文本提取不到时按时间窗兜底判为回声（此前文档已承诺、
  代码里不存在的行为）。残留风险见上方提示。

### v0.5.4

- `loadConfig` 新增可选的全局配置路径注入（`LoadConfigOptions`），不传时行为与 v0.5.3 完全一致。
- **改完配置仍需完整重启 TUI**（`/reload` 不重载插件）。

### v0.5.3

- `maxConsecutive` **负值不再静默取消上限**：负值回退默认 `20`；`0` 仍表示不限。
- 墙钟预算（`watchTimeoutMs`）**按轮次计量**：真实用户消息开启新一轮时预算重算（此前按首次 `/autocontinue on` 累计）。
- 新增第 8 个停止原因 `title-excluded`（短语 `title excluded`）：此前标题排除路径无 `stopReason`，footer 只能显示裸 `[AC ⏹ N]`。
- **改完配置仍需完整重启 TUI**（`/reload` 不重载插件）。

### v0.5.2

- 24h 默认墙钟上限：`watchTimeoutMs` 默认由 `0` 改为 `86400000`（24h）。
- `verifyMaxIterations` 默认由 `0` 改为 `50`。
- 引入可观测的 `stopReason`。
- 引入挫败感触发（opt-in，默认关闭）。

**默认上界（v0.5.2 默认值变更）**：`watchTimeoutMs` 默认由 `0` 改为 `86400000`（24h），`verifyMaxIterations` 默认由 `0` 改为 `50`；两者**显式写 `0` 仍表示无限**（即仍可恢复无限值守 / 无限验证轮次，误配置时需留意）。

## 完整示例

```jsonc
{
  "enabled": true,
  "message": "继续执行。按既定计划推进；遇到问题先自查修复，勿中断整体任务。",
  "endTime": "08:30",
  "startTime": "22:00",
  "idleDelayMs": 15000,
  "minIntervalMs": 30000,
  "maxConsecutive": 20,
  "watchTimeoutMs": 86400000,
  "completionMarkers": ["[任务完成]", "[夜间任务完成]", "[task done]", "<promise>DONE</promise>", "<promise>LOOP_DONE</promise>"],
  "finalCheckEnabled": true,
  "finalCheckMessage": "请整体检查一遍项目是否存在遗漏或 bug，并同步整理项目相关文档。检查完毕确认无误后，输出完成标记。",
  "errorPatterns": ["bad_response_status_code", "bad request", "429", "(status: 5", "ECONNRESET", "ECONNREFUSED", "timeout", "aborted by", "ContextOverflow", "too large to compact"],
  "excludePatterns": ["MessageAbortedError", "operation was aborted"],
  "excludeTitleKeywords": ["测试"],
  "userGraceMs": 15000,
  "intervalMs": 3600000,
  "markerRegex": "",
  "verifyCommand": "",
  "verifyTimeoutMs": 120000,
  "verifyMaxIterations": 50,
  "verifyCwd": "",
  "selfEchoWindowMs": 10000,
  "abortSentinelTag": "loop-abort",
  "pauseSentinelTag": "loop-pause",
  "escalationReassessMessage": "REASSESS：重读验证输出、搜索相关源码、列 3 个不同假设再行动。不要再用同样的方法。",
  "escalationRootCauseMessage": "你可能在解决错误的问题。退回到需求本身重新理解。",
  "escalationPressureLadder": [
    "稳步推进。",
    "换方案，别原地打转。",
    "先用 git log 看看自己做了什么，读取当前会话迭代记录。",
    "穷尽了吗？用 git diff 确认没在重复。",
    "停下来重新审视根因，用完全不同的思路。",
    "退回去从需求本身重新质疑。"
  ],
  "observeToolFailures": false,
  "frustrationTriggers": [],
  "frustrationMessage": "用户明确表达了对质量的不满：换本质不同的方法重新推进，并贴出可核对的验证证据（命令 + 输出），不要只改措辞。"
}
```

## 环境变量

`OC_AUTOCONTINUE=0` 完全禁用插件。

## 日志路径

| 平台 | 路径 |
|---|---|
| Unix / macOS | `~/.local/share/opencode/log/opencode.log` |
| Windows（PowerShell 写法） | `$env:USERPROFILE\.local\share\opencode\log\opencode.log` |

> Windows 列为 **PowerShell 写法**（可直接粘贴到 PowerShell）；cmd 下请写用户目录的绝对路径。
