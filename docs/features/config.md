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
| `message` | `继续执行。审视已完成的功能是否存在bug，未实现的功能是否有安排好的执行计划` | 续跑消息模板，支持 `{time}` `{remaining}` |
| `startTime` / `endTime` | 空 / `23:30` | 每日值守时段（本地 HH:MM，空=不限制）。**跨午夜窗口**（`endTime` 时刻早于 `startTime`，如 22:00→08:30）：`endAt` 会在当天已过时滚动到次日；非跨日窗口当天已过即停止 |
| `idleDelayMs` | `15000` | 空闲后延迟注入 |
| `minIntervalMs` | `30000` | 同会话最小续跑间隔 |
| `maxConsecutive` | `20` | 最大连续续跑次数（0=不限制） |
| `completionMarkers` | `["[任务完成]", "[task done]"]` | 完成标记，任一命中即停。**空数组 `[]` = 不检测完成标记**（会话持续值守） |
| `markerRegex` | 空 | 完全自定义完成标记正则（优先于 `completionMarkers`） |
| `errorPatterns` | `["bad_response_status_code", "ECONNRESET", "timeout"]` | 视为可恢复的错误特征（大小写不敏感子串）。匹配串含 `type: message (status: N)`，纯 5xx 裸状态（如 status 503 无 message）也能命中 `"5"` / `"429"` |
| `excludePatterns` | `["MessageAbortedError", "operation was aborted"]` | 永不自动续跑（用户主动中止） |
| `excludeTitleKeywords` | `["测试"]` | 标题含这些词不续跑 |
| `userGraceMs` | `300000` | 用户最近发真实消息后 N ms 内不自动续跑 |
| `intervalMs` | `3600000` | 保活心跳间隔（ms），`0` = 关闭（配置下限钳制为 `1000`）。每间隔向值守中的会话注入一次 `intervalMessage`（仅当会话空闲、模型近 60s 无 busy、无恢复注入在途、未命中完成标记、且在值守窗口内）；**不递增 `consecutive`**（心跳≠重试） |
| `intervalMessage` | `继续执行。按既定计划推进；遇到问题先自查修复，勿中断整体任务。` | 保活心跳话术，独立于 `message` |

## 完整示例

```jsonc
{
  "enabled": true,
  "message": "继续执行。审视已完成的功能是否存在bug，未实现的功能是否有安排好的执行计划",
  "endTime": "08:30",
  "startTime": "22:00",
  "idleDelayMs": 15000,
  "minIntervalMs": 30000,
  "maxConsecutive": 20,
  "completionMarkers": ["[任务完成]", "[夜间任务完成]", "[task done]", "<promise>DONE</promise>"],
  "errorPatterns": ["bad_response_status_code", "bad request", "429", "5", "ECONNRESET", "ECONNREFUSED", "timeout", "aborted by", "ContextOverflow", "too large to compact"],
  "excludePatterns": ["MessageAbortedError", "operation was aborted"],
  "excludeTitleKeywords": ["测试"],
  "userGraceMs": 300000,
  "intervalMs": 3600000,
  "intervalMessage": "继续执行。按既定计划推进；遇到问题先自查修复，勿中断整体任务。",
  "markerRegex": ""
}
```

## 环境变量

`OC_AUTOCONTINUE=0` 完全禁用插件。