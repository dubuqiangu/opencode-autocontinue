# 未来扩展与未实现记录

## 已实现（原规划落地）

| 方向 | 形态 |
|---|---|
| 会话级手动开关 | `/autocontinue on\|off\|status`（每会话独立，多会话同时值守互不覆盖） |
| footer 状态指示 | `[AC ●]` / `[AC ✓]` / `[AC ⏸]`(paused) / `[AC ⏹ N]` |
| 右侧栏值守块 | `Watch` 块：⏱ 时长 + 🔁 续跑次数 + 🎯 状态（全英文），v0.5.0 起附加 `🔍 verifying` / `🚫 N rejection(s)` / `🛠 N tool failure(s)` |
| 自动续跑引擎 | retry 第一道防线 + 错误/空闲注入 + 完成/次数/时段停止 |
| 配置系统 | 全局 + 项目覆盖，deep merge，JSONC/BOM 容错 |
| 值守持久化 | `ctx.storage`，跨重启恢复 |

## 待实机验证（阶段 D）

| 项 | 状态 |
|---|---|
| D1 `/autocontinue on\|status\|off` 命令链路 | ✅ 已真机确认（on → toast "Watch enabled"、server kv 写入、event 无异常；off 正常移除） |
| D1b 侧栏 Watch 块活图验证（v0.3.9/v0.3.10） | ⏳ 待重启 TUI 后确认：on 立即出现 + ⏱ 每秒走动、off 立即消失、点击标题折叠且不被重挂载重置 |
| D2 真实造错/空闲 → 续跑注入；完成标记 → 停 | ⏳ 待实机 |
| D3 卸载/重装干净，无残留订阅 | ⏳ 待实机 |

详见 [任务清单](../tasks.md)。

## 待发布（阶段 E，用户决策门）

- E1 推送前脱敏扫描 → E2 发布 → E3 `plugin update` 验证 GitHub HEAD

## 机理移植（参考 `MichengAI/dsh-pua`）

设计稿：[docs/architecture/provenance-and-loop.md](../architecture/provenance-and-loop.md)。

- **第一轮（v0.4.0）**：① 注入溯源（修真实 bug）→ ② 验证驱动续跑 Loop（opt-in）→ ③ 升级式提示 + ④ 终止哨兵 `LOOP_DONE`。
- **第二轮（v0.5.0，§7）**：① 验证输出采集上限（修真实缺陷）→ ② abort/pause 哨兵 + `paused` 状态 → ③ 升级提示阈值化 + 轮次压力梯 → ④ 验证状态进 TUI/RPC → ⑤ 工具失败观测计数器（opt-in）→ B graceMs + 范围钳制。
- **第三轮（v0.5.1，§8）**：全项目审查修复——跨午夜起点闸（`startGateClosed`）、验证前 TOCTOU 快照复检、非有限数值拒绝、字符串感知 JSONC 尾逗号、`state.changed` 携带 `toolFailureCount`、V1 工具结果观测、abort 哨兵优先于后台守卫、verify grace 定时器清理 + 增量 UTF-8 解码、死代码删除（`resetInjectionCount`）+ 补测。
- **第四轮（v0.5.2，§9）**：dsh-pua 风格机制取证与取舍——P1 文档记录（不移植清单扩充）、P2 缩减版挫败感触发（opt-in，默认关闭）、P3 无人值守护栏（默认上界 24h / 验证轮次 50 + 停止原因可观测）。
- **主动不移植**：两事件 surface-replace、tool-order 自愈、延后写重试、integrity guard、subagent 继承、clear/compact 特判（宿主专属或用途不符）；v0.5.0 另否决「删 V1 兼容死路径」（测试 + changelog 已锁定为有意兼容）。
- **风格机制（dsh-pua「风味 / 模式」轴，§9.2）**：风味/人设（15 套大厂味 + 味道路由）、方法论预设、角色层级（P7/P9/P10/verifier/self-reviewer）、i18n、降压与换框协议、钉味提醒库、feedback 问卷 —— 判定不移植：前三类需要 systemPrompt / commands / agent 注册（我方宿主无此 API），降压与换框需要模型侧判断，钉味的行为诉求已被验证门控（exit code）覆盖，feedback 需要 transcript 路径；我方 `message` / `finalCheckMessage` / `escalation*` 文案槽已能承载其行为内容。
- **缩减后借鉴（v0.5.2）**：挫败感触发 —— 只取其「真实用户抱怨 → 质量纠偏」这一可机械判定的部分，缩减为 opt-in（默认关闭）：命中后把一句质量不满提醒**追加到下一次本来就要发的注入**末尾，不新开一轮。

## 未来方向（已评估，未实现）

| 方向 | 说明 |
|---|---|
| 全局默认值守 | 需配置项 `defaultEnabled` 之类，当前只做每会话手动开关 |
| 值守会话列表 UI | 右栏/面板展示所有值守会话状态 |
| 更细的完成判定 | AI 辅助判断任务完成（当前刻意不做，零模型成本） |
| ~~失败观测计数器~~ | ✅ v0.5.0 落地为 `observeToolFailures`（opt-in，仅观测） |
| 删 V1 兼容死路径 | `message.updated`/`session.error`/`info.role`——当前有意保留；若清理需同步改测试与 changelog，并先征得同意 |
