# opencode-autocontinue — DESIGN

V2 服务端 + TUI 插件：自动续跑"总任务未完成就被中断"的会话。

> ⚠️ **本文档已迁移到 `docs/`**，以下仅为入口摘要。完整内容见：
>
> - 总入口：[docs/README.md](docs/README.md)（文档地图 + 快速链接）
> - 架构：`docs/architecture/overview.md` / `events-and-state.md` / `module-layout.md` / `runtime-lessons.md`
> - 功能：`docs/features/commands.md` / `footer.md` / `engine.md` / `config.md`
> - 决策：`docs/decisions/known-issues.md` / `roadmap.md` / `changelog.md`

## 一句话摘要

会话因任何非用户原因中断（模型错误 `bad_response_status_code` 等、阶段完成空闲、网络抖动、工具失败）而**总任务未完成**时，自动注入用户可自定义的续跑消息，让 agent 继续。默认消息：

```
继续执行。审视已完成的功能是否存在bug，未实现的功能是否有安排好的执行计划
```

值守由会话内 `/autocontinue on|off` 手动开启，footer 显示 `[AC ●]` / `[AC ✓]` / `[AC ⏸ N]` 状态；停止条件为完成标记 / 最大连续续跑次数 / 值守时段窗口 / 用户 off。