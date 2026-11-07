# opencode-autocontinue 文档

OpenCode V2 插件：自动续跑因非用户原因中断、但整体任务尚未完成的会话。模型报错（`bad_response_status_code` 等）、stage-complete 后的空闲、网络抖动、工具失败——只要会话在值守名单里，判定通过后注入续跑消息，直到任务完成或触发停止条件。

## 文档地图

| 分类 | 文件 | 内容 |
|---|---|---|
| **使用** | [guides/install.md](guides/install.md) | 安装 / 更新 / 验证 / 卸载 / 重启生效说明 |
| | [features/commands.md](features/commands.md) | `/autocontinue on\|off\|status` 命令与 RPC 契约 |
| | [features/footer.md](features/footer.md) | footer 状态指示 `[AC ●]` / `[AC ✓]` / `[AC ⏸]`(paused) / `[AC ⏹ N · 短语]`(stopped + 停止原因) + 右侧栏 Watch 块 |
| | [features/engine.md](features/engine.md) | 自动续跑引擎：retry 第一道防线、错误/空闲注入、完成判定与停止条件 |
| | [features/config.md](features/config.md) | 配置系统：全局 + 项目覆盖、JSONC 解析、全部配置项 |
| **架构** | [architecture/overview.md](architecture/overview.md) | 项目概述、加载机制、总体数据流、验证方式 |
| | [architecture/events-and-state.md](architecture/events-and-state.md) | 事件词汇、事件解析、状态结构与持久化、防重、交互时序 |
| | [architecture/module-layout.md](architecture/module-layout.md) | 模块化代码结构与职责划分 |
| | [architecture/provenance-and-loop.md](architecture/provenance-and-loop.md) | 决策与裁定索引：每项机制为什么这么定、哪些方案被否决 |
| | [architecture/loop-mechanisms.md](architecture/loop-mechanisms.md) | 现行机制规格：判定链、停止条件、注入与验证流程的准确描述 |
| | [architecture/loop-evidence.md](architecture/loop-evidence.md) | 取证与历史轮次：机制来源、比对结论与各版本落地记录 |
| | [architecture/runtime-lessons.md](architecture/runtime-lessons.md) | 运行时问题取证记录 |
| **决策** | [decisions/known-issues.md](decisions/known-issues.md) | 边界情况与已知限制 |
| | [decisions/roadmap.md](decisions/roadmap.md) | 已实现 / 真机待办 / 本轮进行中 / 未来方向 / 不移植清单 |
| | [decisions/changelog.md](decisions/changelog.md) | 版本变更记录 |

## 5 分钟上手

1. **装**：`opencode plugin add github:dubuqiangu/opencode-autocontinue`
2. **重启**：完整重启 opencode（`opencode service restart` 或退出重开；`/reload` 不会重载插件）
3. **开启值守**：在目标会话里输入 `/autocontinue on`
4. **确认生效**：底部 footer 出现 `[AC ●]`
5. **看状态**：输入 `/autocontinue status`，toast 显示 `Watching · watching · N injection(s)`
6. **关掉**：输入 `/autocontinue off`，footer 指示消失

## 快速链接

- 装机：`opencode plugin add github:dubuqiangu/opencode-autocontinue` → [安装指南](guides/install.md)
- 上手：会话内 `/autocontinue on`，footer 出现 `[AC ●]` → [命令](features/commands.md)
- 当前状态：v0.5.4 已发布（本轮为内部 API 扩展与测试可维护性改进，无用户可见行为变更）；真实待办只剩实机验证——D1b 跨午夜窗口与侧栏、D2 续跑实测（含验证 TOCTOU 复检）、D3 卸载重装干净（含 stopReason 短语显示） → [任务清单](../tasks.md)、[变更记录](decisions/changelog.md)
