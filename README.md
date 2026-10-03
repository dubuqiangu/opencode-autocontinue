# opencode-autocontinue

OpenCode V2 插件：自动续跑被非用户原因中断、但整体任务尚未完成的会话。
模型报错（如 `bad_response_status_code`）、stage-complete 后的空闲、网络抖动、工具失败——只要会话在值守名单里，插件就会在判定通过后注入续跑消息，直到任务完成或触发停止条件。

## 特性

- **每会话手动开关**：`/autocontinue on|off|status`（别名 `/ac`）
- **TUI 可见状态**：footer 常驻指示 `[AC ●]` 值守中 / `[AC ✓]` 完成 / `[AC ⏸ N]` 已停（N=续跑次数）
- **两类恢复**：
  - 错误恢复：`session.error` / assistant 消息错误 → 判定可重试 → 延迟注入
  - 空闲恢复：`session.idle`（stage-complete）→ 判定通过后注入续跑
- **第一道防线 retry hook**：瞬时模型错误改写为可重试 + 指数退避（2s→4s→… 封顶 60s）
- **完成检测**：助手消息含完成标记（默认 `[任务完成]` 等）→ 标记 done 停止续跑
- **循环防护**：每会话最大连续续跑次数（默认 20）+ 最小注入间隔（默认 30s）
- **时段窗口**：`startTime` / `endTime`（每日 HH:MM），窗口外不续跑
- **排除规则**：用户停止、标题含关键字（默认 "测试"）、用户最近消息后的宽限期（默认 5 分钟）
- **持久化**：值守名单写入 `ctx.storage`，重启后仍在

## 安装

```bash
opencode plugin add github:<owner>/opencode-autocontinue
```

重启 opencode。验证：`opencode plugin list` 中能看到 `opencode-autocontinue`。

## 使用

```text
/autocontinue on       开启当前会话值守
/autocontinue off      关闭当前会话值守
/autocontinue status   查看当前会话值守状态
```

开启后 footer 出现 `[AC ●]`。续跑注入后计数递增，助手消息出现完成标记 → `[AC ✓]`。

## 配置

全局配置：`~/.config/opencode/opencode-autocontinue.jsonc`
项目级覆盖：`.opencode/opencode-autocontinue.jsonc`（深合并，优先级更高）

```jsonc
{
  // 总开关（OC_AUTOCONTINUE=0 环境变量也可整体禁用）
  "enabled": true,
  // 续跑消息模板，支持 {time} 和 {remaining}
  "message": "继续执行。审视已完成的功能是否存在bug，未实现的功能是否有安排好的执行计划",
  // 时段窗口（本地 HH:MM，空=不限制）
  "startTime": "",
  "endTime": "23:30",
  // 空闲后延迟注入
  "idleDelayMs": 15000,
  // 同会话两次注入最小间隔
  "minIntervalMs": 30000,
  // 最大连续续跑次数（0=不限制）
  "maxConsecutive": 20,
  // 完成标记（任一命中即停）
  "completionMarkers": ["[任务完成]", "[task done]"],
  // 或自定义正则（优先于 completionMarkers）
  "markerRegex": "",
  // 视为可恢复的错误特征（大小写不敏感）
  "errorPatterns": ["bad_response_status_code", "ECONNRESET", "timeout"],
  // 永不自动续跑的排除特征（用户主动中止等）
  "excludePatterns": ["MessageAbortedError", "operation was aborted"],
  // 标题含这些关键字不续跑
  "excludeTitleKeywords": ["测试"],
  // 用户真实消息后的宽限期（毫秒）
  "userGraceMs": 300000
}
```

## 卸载

```bash
opencode plugin remove <id>
```

## 验证

- 单元测试：`node --test test/server.test.ts`（25 个用例，覆盖解析/判定矩阵/节流/时段/排除/完成标记）
- 语法：`node --check src/*.ts` + esbuild 打包通过
- 实机：D1/D2/D3 阶段见 tasks.md

## 设计

架构、事件流、目录树、交互顺序图见 `DESIGN.md`。