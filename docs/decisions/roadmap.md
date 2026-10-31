# 未来扩展与未实现记录

## 已实现（原规划落地）

| 方向 | 形态 |
|---|---|
| 会话级手动开关 | `/autocontinue on\|off\|status`（每会话独立，多会话同时值守互不覆盖） |
| footer 状态指示 | `[AC ●]` / `[AC ✓]` / `[AC ⏸ N]` |
| 右侧栏值守块 | `Watch` 块：⏱ 时长 + 🔁 续跑次数 + 🎯 状态（全英文） |
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
按价值排序实施：① 注入溯源（修真实 bug）→ ② 验证驱动续跑 Loop → ③ 升级式提示 + 终止哨兵。
不移植 dsh-pua 的宿主专属机制（两事件 surface-replace / 状态折叠 / integrity guard / i18n）。

## 未来方向（已评估，未实现）

| 方向 | 说明 |
|---|---|
| 全局默认值守 | 需配置项 `defaultEnabled` 之类，当前只做每会话手动开关 |
| 值守会话列表 UI | 右栏/面板展示所有值守会话状态 |
| 更细的完成判定 | AI 辅助判断任务完成（当前刻意不做，零模型成本） |
| 失败观测计数器 | dsh-pua 的 `rejections` 分级（≥3 换根因 / ≥5 换方案），随 F2 落一半 |