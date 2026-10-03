# 配置系统

两层配置，deep merge，项目级优先。加载器（`src/config.ts`）：JSONC 解析（注释 + 尾逗号），BOM 容错；坏文件回退默认值。

| 层级 | 路径 |
|---|---|
| 全局 | `~/.config/opencode/opencode-autocontinue.jsonc` |
| 项目覆盖 | `.opencode/opencode-autocontinue.jsonc`（优先级更高） |

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（`OC_AUTOCONTINUE=0` 环境变量可整体禁用） |
| `message` | `继续执行。审视已完成的功能是否存在bug，未实现的功能是否有安排好的执行计划` | 续跑消息模板，支持 `{time}` `{remaining}` |
| `startTime` / `endTime` | 空 / `23:30` | 每日值守时段（本地 HH:MM，空=不限制） |
| `idleDelayMs` | `15000` | 空闲后延迟注入 |
| `minIntervalMs` | `30000` | 同会话最小续跑间隔 |
| `maxConsecutive` | `20` | 最大连续续跑次数（0=不限制） |
| `completionMarkers` | `["[任务完成]", "[task done]"]` | 完成标记，任一命中即停 |
| `markerRegex` | 空 | 完全自定义完成标记正则（优先于 `completionMarkers`） |
| `errorPatterns` | `["bad_response_status_code", "ECONNRESET", "timeout"]` | 视为可恢复的错误特征（大小写不敏感子串） |
| `excludePatterns` | `["MessageAbortedError", "operation was aborted"]` | 永不自动续跑（用户主动中止） |
| `excludeTitleKeywords` | `["测试"]` | 标题含这些词不续跑 |
| `userGraceMs` | `300000` | 用户最近发真实消息后 N ms 内不自动续跑 |

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
  "markerRegex": ""
}
```

## 环境变量

`OC_AUTOCONTINUE=0` 完全禁用插件。