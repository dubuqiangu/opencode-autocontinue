# 安装 / 更新 / 验证 / 卸载

适用于 OpenCode ≥ V2。

## 一键安装

任意目录执行一条命令，克隆、依赖安装、注册全部自动完成：

```sh
opencode plugin add github:<owner>/opencode-autocontinue
```

**重启 opencode** 即可生效。

## 备选安装方式（本地开发）

开发阶段以本地路径注册（已实测，配置已备份）：

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file://<本仓库的绝对路径>"]
}
```

## 验证

1. 重启 opencode（或 `opencode service restart` 后重开 TUI）
2. `opencode plugin list` 中能看到 `opencode-autocontinue`
3. 会话内 `/autocontinue on` → toast「值守已开启」+ footer 出现 `[AC ●]`
4. `/autocontinue status` 显示值守状态；`/autocontinue off` 移除

若命令无效：日志 `~/.local/share/opencode/log/opencode.log` 过滤插件加载错误。

## 更新

```sh
opencode plugin update github:<owner>/opencode-autocontinue
```

> ⚠️ **热重载限制**：`plugin update` 只更新磁盘包，运行中的宿主仍持有旧代码；`/reload` 会拆除旧实例的订阅与定时器，但不从磁盘重载插件。**每次更新后必须完整重启 opencode。** 详见 [runtime-lessons.md](../architecture/runtime-lessons.md)。

## 卸载

```sh
opencode plugin remove github:<owner>/opencode-autocontinue
```

卸载后应无残留 interval/订阅（cleanup 返回 dispose）。