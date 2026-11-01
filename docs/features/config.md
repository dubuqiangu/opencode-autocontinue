# 配置系统

两层配置，deep merge，项目级优先。加载器（`src/config.ts`）：JSONC 解析（注释 + 尾逗号），**单引号字符串自动归一为双引号**，BOM 容错；坏文件回退默认值。

| 层级 | 路径 |
|---|---|
| 全局 | `~/.config/opencode/opencode-autocontinue.jsonc` |
| 项目覆盖 | `.opencode/opencode-autocontinue.jsonc`（优先级更高） |

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（`OC_AUTOCONTINUE=0` 环境变量可整体禁用） |
| `message` | `继续执行。按既定计划推进；遇到问题先自查修复，勿中断整体任务。` | 统一注入消息模板，支持 `{time}` `{remaining}`。所有注入（错误恢复 / 空闲续跑 / 周期检查 / 验证失败续跑）共用此消息 |
| `startTime` / `endTime` | 空 / 空 | 每日值守时段（本地 HH:MM，空=不限制）。**跨午夜窗口**（`endTime` 时刻早于 `startTime`，如 22:00→08:30）：`endAt` 会在当天已过时滚动到次日；非跨日窗口当天已过即停止。跨午夜起点闸（`startGateClosed`）：次日 `00:00`..`startTime` 之间窗口仍视为开启 |
| `idleDelayMs` | `15000` | 空闲后延迟注入 |
| `minIntervalMs` | `30000` | 同会话最小续跑间隔 |
| `maxConsecutive` | `20` | 单轮值守最大注入次数（0=不限制）。任一注入（错误恢复/周期检查/完成复查/验证失败）都计入 |
| `watchTimeoutMs` | `0` | 单轮值守最长时长（ms），超时自动 `stopped`。`0` = 无期限（区别于每日 `endTime` 窗口） |
| `completionMarkers` | `["[任务完成]", "[夜间任务完成]", "[task done]", "<promise>DONE</promise>", "<promise>LOOP_DONE</promise>"]` | 完成标记。**任一命中触发完成流程**（见 `finalCheckEnabled`）。**空数组 `[]` = 不检测完成标记**（会话持续值守） |
| `markerRegex` | 空 | 完全自定义完成标记正则（优先于 `completionMarkers`） |
| `finalCheckEnabled` | `true` | 完成标记命中后，注入 `finalCheckMessage` 进入复查轮（confirming）；复查完成（再次命中标记）才 `done`。`false` = 标记命中直接 `done` |
| `finalCheckMessage` | `请整体检查一遍项目是否存在遗漏或 bug，并同步整理项目相关文档。检查完毕确认无误后，输出完成标记。` | 复查轮注入的话术（整体检查 + 文档整理） |
| `errorPatterns` | `["bad_response_status_code", "ECONNRESET", "timeout", ...]` | 视为可恢复的错误特征（大小写不敏感子串）。匹配串含 `type: message (status: N)`，纯 5xx 裸状态（如 status 503 无 message）也能命中 `"(status: 5"` / `"429"` |
| `excludePatterns` | `["MessageAbortedError", "operation was aborted"]` | 永不自动续跑（用户主动中止） |
| `excludeTitleKeywords` | `["测试"]` | 标题含这些词不续跑 |
| `userGraceMs` | `15000` | 用户最近发真实消息后 N ms 内不自动续跑 |
| `intervalMs` | `3600000` | 周期检查间隔（ms），`0` = 关闭（正值配置下限钳制为 `1000`）。每间隔向值守中的会话触发一次统一注入判定（仅当会话空闲、模型近 60s 无 busy、未命中完成标记/复查轮外、且在值守窗口内、最后一条 assistant 消息非"疑似未完成"——提问结尾 / 工具调用在途 / 短确认回复） |

## 验证驱动 Loop 与哨兵（v0.4.0 起，v0.5.0 扩展）

| 键 | 默认 | 说明 |
|---|---|---|
| `verifyCommand` | 空 | 验证命令；**空 = 关闭验证驱动 Loop**（行为与仅完成标记一致）。非空时仅当检测到完成信号（完成标记 / `<promise>LOOP_DONE</promise>`）才运行该命令，按 **exit code** 判定完成 |
| `verifyTimeoutMs` | `120000` | 单次验证超时；钳制 `1000`..`3600000`（1s..3600s） |
| `verifyMaxIterations` | `0` | 失败轮次上限；`0` = 不限；钳制 `0`..`10000` |
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
  "watchTimeoutMs": 0,
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
  "verifyMaxIterations": 0,
  "abortSentinelTag": "loop-abort",
  "pauseSentinelTag": "loop-pause",
  "observeToolFailures": false
}
```

## 环境变量

`OC_AUTOCONTINUE=0` 完全禁用插件。
