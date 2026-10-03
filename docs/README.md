# opencode-autocontinue 文档

OpenCode V2 插件：自动续跑因非用户原因中断、但整体任务尚未完成的会话。模型报错（`bad_response_status_code` 等）、stage-complete 后的空闲、网络抖动、工具失败——只要会话在值守名单里，判定通过后注入续跑消息，直到任务完成或触发停止条件。

## 文档地图

| 分类 | 文件 | 内容 |
|---|---|---|
| **使用** | [guides/install.md](guides/install.md) | 安装 / 更新 / 验证 / 卸载 / 热重载注意事项 |
| | [features/commands.md](features/commands.md) | `/autocontinue on\|off\|status` 命令与 RPC 契约 |
| | [features/footer.md](features/footer.md) | footer 状态指示 `[AC ●]` / `[AC ✓]` / `[AC ⏸ N]` |
| | [features/engine.md](features/engine.md) | 自动续跑引擎：retry 第一道防线、错误/空闲注入、完成判定与停止条件 |
| | [features/config.md](features/config.md) | 配置系统：全局 + 项目覆盖、JSONC 解析、全部配置项 |
| **架构** | [architecture/overview.md](architecture/overview.md) | 项目概述、加载机制、总体数据流、验证方式 |
| | [architecture/events-and-state.md](architecture/events-and-state.md) | 事件词汇、事件解析、状态结构与持久化、防重、交互时序 |
| | [architecture/module-layout.md](architecture/module-layout.md) | 模块化代码结构与职责划分 |
| | [architecture/runtime-lessons.md](architecture/runtime-lessons.md) | 运行时问题取证记录 |
| **决策** | [decisions/known-issues.md](decisions/known-issues.md) | 边界情况与已知限制 |
| | [decisions/roadmap.md](decisions/roadmap.md) | 未来扩展与未实现项记录 |
| | [decisions/changelog.md](decisions/changelog.md) | 版本变更记录 |

## 快速链接

- 装机：`opencode plugin add github:<owner>/opencode-autocontinue` → 详见 [安装指南](guides/install.md)
- 上手：会话内 `/autocontinue on`，footer 出现 `[AC ●]` → 详见 [命令](features/commands.md)
- 当前状态：阶段 D（实机验证）进行中 → 详见 [任务清单](../tasks.md) 与 [变更记录](decisions/changelog.md)