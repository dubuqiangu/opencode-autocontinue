# 配置系统

两层配置，deep merge，项目级优先。加载器（`src/config.ts`）：JSONC 解析（注释 + 尾逗号），**单引号字符串自动归一为双引号**，BOM 容错；坏文件回退默认值。

## 配置文件位置

| 层级 | Unix / macOS | Windows（PowerShell 写法） |
|---|---|---|
| 全局（按用户） | `~/.config/opencode/opencode-autocontinue.jsonc` | `$env:USERPROFILE\.config\opencode\opencode-autocontinue.jsonc` |
| 项目覆盖 | 仓库内 `.opencode/opencode-autocontinue.jsonc` | 仓库内 `.opencode/opencode-autocontinue.jsonc` |

> Windows 列为 **PowerShell 写法**（可直接粘贴到 PowerShell）；cmd 下请写用户目录的绝对路径。

- 两层配置 **deep merge**，**项目级优先**（项目级同名字段覆盖全局，全局其余字段保留）。
- 项目级路径指的是**仓库根目录下的 `.opencode`**，不是用户目录里的那个。

### 三步创建配置

1. **创建文件**：在上面的路径新建 `opencode-autocontinue.jsonc`（全局文件要先建 `opencode` 目录；项目文件要先建 `.opencode` 目录）。
2. **粘贴**：把下面「完整示例」或「最小示例」的内容粘进去（JSONC，允许注释和尾逗号）。
3. **重启**：**改完配置必须完整重启 opencode**（`opencode service restart` 或退出重开）才会生效——`/reload` 不会重载插件配置。

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
| `errorPatterns` | `["bad_response_status_code", "ECONNRESET", "timeout", ...]`（节选，完整列表见下方示例） | 视为可恢复的错误特征（大小写不敏感子串）。匹配串含 `type: message (status: N)`，纯 5xx 裸状态（如 status 503 无 message）也能命中 `"(status: 5"` / `"429"` |
| `excludePatterns` | `["MessageAbortedError", "operation was aborted"]` | 永不自动续跑（用户主动中止） |
| `excludeTitleKeywords` | `["测试"]` | 标题含这些词不续跑。命中时会话停止，原因 `title-excluded`（短语 `title excluded`） |
| `userGraceMs` | `15000` | 用户最近发真实消息后 N ms 内不自动续跑 |
| `intervalMs` | `3600000` | 周期检查间隔（ms），`0` = 关闭（正值配置下限钳制为 `1000`）。每间隔向值守中的会话触发一次统一注入判定（仅当会话空闲、模型近 60s 无 busy、未命中完成标记/复查轮外、且在值守窗口内、最后一条 assistant 消息非"疑似未完成"——提问结尾 / 工具调用在途 / 短确认回复） |

## 验证驱动 Loop 与哨兵（v0.4.0 起，v0.5.0 扩展）

| 键 | 默认 | 说明 |
|---|---|---|
| `verifyCommand` | 空 | 验证命令；**空 = 关闭验证驱动 Loop**（行为与仅完成标记一致）。非空时仅当检测到完成信号（完成标记 / `<promise>LOOP_DONE</promise>`）才运行该命令，按 **exit code** 判定完成 |
| `verifyTimeoutMs` | `120000` | 单次验证超时；钳制 `1000`..`3600000`（1s..3600s） |
| `verifyMaxIterations` | `50`（**v0.5.2 默认值变更**，原为 `0`） | 失败轮次上限；`0` = 不限；钳制 `0`..`10000` |
| `verifyCwd` | 空 | 验证工作目录；空 = 会话/项目目录（`ctx.location.directory`） |
| `selfEchoWindowMs` | `10000` | 自回声窗口：窗口内与上次注入文本相同的入站「用户」消息视为自身回声，不计入真实用户轮 |
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

## 版本变更说明

### v0.5.3

- `maxConsecutive` **负值不再静默取消上限**：负值回退默认 `20`；`0` 仍表示不限。
- 墙钟预算（`watchTimeoutMs`）**按轮次计量**：真实用户消息开启新一轮时预算重算（此前按首次 `/autocontinue on` 累计）。
- 新增第 8 个停止原因 `title-excluded`（短语 `title excluded`）：此前标题排除路径无 `stopReason`，footer 只能显示裸 `[AC ⏹ N]`。

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
