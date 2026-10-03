# opencode-autocontinue

OpenCode V2 插件：自动续跑被非用户原因中断、但整体任务尚未完成的会话。

> ⚠️ **完整文档见 [docs/README.md](docs/README.md)**（文档地图 + 快速链接）。

## 一句话

会话在值守名单里时，模型报错、stage-complete 后的空闲、网络抖动、工具失败——判定通过后自动注入续跑消息，直到任务完成或触发停止条件。

## 快速上手

```text
opencode plugin add github:<owner>/opencode-autocontinue   # 安装
/autocontinue on                                           # 开启当前会话值守
```

- 安装 / 更新 / 卸载 / 验证：[docs/guides/install.md](docs/guides/install.md)
- 命令与配置：`/autocontinue on|off|status`（详见 [docs/features/](docs/features/commands.md)）
- 架构与设计：[docs/architecture/](docs/architecture/overview.md)