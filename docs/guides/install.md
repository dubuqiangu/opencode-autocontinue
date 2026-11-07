# 安装 / 验证 / 更新 / 卸载

面向第一次使用本插件的用户：从零开始，按顺序照抄即可。

## 1. 前置要求

开始之前，先确认下面 5 条都满足：

| # | 要求 | 怎么确认 |
|---|---|---|
| 1 | **OpenCode ≥ V2** | 插件依赖 V2 的 TUI 插件接口与 RPC 事件，V1 不支持 |
| 2 | **`opencode` 命令在 PATH 里** | 终端执行 `opencode --version` 能打印版本号 |
| 3 | **能访问 GitHub** | 安装源是 GitHub 上的公开仓库 |
| 4 | **按用户全局安装** | 插件装在你的用户目录下，**不会**往你的项目仓库里写任何文件；卸载同样只清理用户目录 |
| 5 | **插件只监听你主动开启的会话** | 装好后不会自动接管任何会话，必须在具体会话里执行 `/autocontinue on` 才开始值守 |

## 2. 一键安装

在任意目录执行（Windows / macOS / Linux 通用）：

```sh
opencode plugin add github:dubuqiangu/opencode-autocontinue
```

安装完成后**必须重启 opencode** 才会生效：

```sh
opencode service restart
```

> ⚠️ **重启会打断当前会话。** 执行前请先确认当前正在跑的会话可以安全中断，或先手动保存需要保留的内容。不想用 `service restart` 的话，直接退出 opencode 再重新打开也可以。

## 3. 验证清单

按顺序逐条打勾，全部通过即安装成功。

### 3.1 终端侧

- [ ] 执行 `opencode plugin list`，输出里能看到一行 `autocontinue <commit>`（`<commit>` 是短 commit 号；有这一行说明宿主已注册插件）

### 3.2 界面侧

- [ ] 重启 TUI 后，在会话内输入 `/autocontinue on`，右下角弹出 toast **`Watch enabled (watching)`**
- [ ] 同一会话底部状态行出现 **`[AC ●]`**
- [ ] 右侧栏出现 `Watch` 块，`⏱` 后面的时长在走动
- [ ] 会话内输入 `/autocontinue status`，toast 显示 **`Watching · watching · 0 injections`**
- [ ] 输入 `/autocontinue off`，toast 显示 **`Watch disabled`**，footer 的 `[AC ●]` 与右侧栏 `Watch` 块同时消失

### 3.3 开发者验证（可选）

仓库内提供了自动化验证脚本：

```sh
pwsh scripts/verify-install.ps1
```

> ⚠️ 这是**开发者工具**：要求你本地已经 clone 了本仓库、且 HEAD 已经推送到远端。普通终端用户**跑不了**，也不需要跑——请用上面 3.1 / 3.2 的手动清单。

## 4. 配置

配置文件是 JSONC（允许注释和尾逗号）。

| 层级 | Unix / macOS | Windows（PowerShell 写法） |
|---|---|---|
| 全局（按用户） | `~/.config/opencode/opencode-autocontinue.jsonc` | `$env:USERPROFILE\.config\opencode\opencode-autocontinue.jsonc` |
| 项目覆盖 | 仓库内 `.opencode/opencode-autocontinue.jsonc` | 仓库内 `.opencode/opencode-autocontinue.jsonc` |

> Windows 列为 **PowerShell 写法**（可直接粘贴到 PowerShell）；cmd 下请写用户目录的绝对路径。

- 两层配置 **deep merge**，**项目级优先**。
- 项目级路径里的 `.opencode` 是**仓库根目录下的 `.opencode`**，不是用户目录里的那个。

最小可用示例（复制粘贴即可）：

```jsonc
{
  // 插件总开关
  "enabled": true,
  // 续跑时注入给模型的话术
  "message": "继续执行。按既定计划推进；遇到问题先自查修复，勿中断整体任务。",
  // 单轮值守最多注入多少次（0 = 不限制）
  "maxConsecutive": 20
}
```

> ⚠️ **改完配置请完整重启 opencode 再验证。** 值守记录的起始时间、时段窗口截止时间等是在会话开始时定格的，重启能保证新配置从头生效。

全部配置键、默认值与含义见 [config.md](../features/config.md)。

## 5. 更新

```sh
opencode plugin update github:dubuqiangu/opencode-autocontinue
```

> ⚠️ **热重载限制**：`plugin update` 只更新磁盘上的插件包，运行中的 opencode 仍持有旧代码；`/reload` **不会**从磁盘重载插件。**每次更新后必须完整重启 opencode**（`opencode service restart` 或退出重开）。

## 6. 卸载

```sh
opencode plugin remove github:dubuqiangu/opencode-autocontinue
```

卸载后插件不会残留任何定时器或事件订阅。若要连配置一起清掉，手动删除全局配置文件 `$env:USERPROFILE\.config\opencode\opencode-autocontinue.jsonc`（PowerShell 写法；Unix：`~/.config/opencode/opencode-autocontinue.jsonc`）。

## 7. 排障

### 7.1 `/autocontinue` 不在命令面板里

按顺序排查：

1. 执行 `opencode plugin list`，看有没有 `autocontinue <commit>`。
2. **没有** → 插件没装上，重新执行 `opencode plugin add github:dubuqiangu/opencode-autocontinue`。
3. **有，但命令不在面板里** → 多半是**装完没重启**。完整重启 opencode（`/reload` 不算）。
4. **重启后还是没有** → 打开日志找插件加载错误（路径见 7.5）。

### 7.2 插件在列表里、命令也能用，但没有任何反应

按可能性从高到低逐项检查：

1. **会话没有开启值守** —— 执行 `/autocontinue on`，确认 footer 出现 `[AC ●]`。插件**只监听你主动 on 的会话**。
2. **会话标题命中排除关键词** —— 默认 `excludeTitleKeywords` 含 `测试`，标题带这个词的会话不会被续跑。改标题，或在配置里调整该键。
3. **你刚发过消息** —— 用户宽限期默认 15 秒（`userGraceMs`），刚发完消息的 15 秒内不会自动续跑，等一会儿再观察。
4. **模型正忙** —— 模型正在生成或刚结束（60 秒内）时不会被打断注入。
5. **撞上了护栏** —— 值守时段窗口、墙钟上限、注入次数上限、验证失败上限任一触发都会停止。footer 会显示 `[AC ⏹ N · <phrase>]`，查 7.4 的对照表。

### 7.3 footer 一直不出现 / 不动

- **footer 只在值守会话渲染**。没执行过 `/autocontinue on`，或已经执行过 `/autocontinue off`，footer 与右侧栏都不会出现（不占位）。
- footer 出现但 `[AC ●]` 不动，先看右侧栏：`⏱` 时长在走说明值守中；`🎯` 后面是状态（`watching` / `confirming`）。

### 7.4 想知道「为什么停了」

footer 停止时的两种显示：

| 显示 | 含义 |
|---|---|
| `[AC ⏹ N]` | 已停止，N = 已续跑次数，但没有可显示的原因短语 |
| `[AC ⏹ N · <phrase>]` | 已停止，`·` 后面是原因短语，见下表 |

`/autocontinue status` 在 stopped 轮同样会追加 ` · <phrase>`。

**8 个停止原因短语对照表：**

| 短语（英文原文） | 一句话解释 |
|---|---|
| `window closed` | 值守时段窗口到点了（到达 `endTime`，或跨午夜窗口结束）。 |
| `watch timeout` | 单轮值守超过墙钟上限（`watchTimeoutMs`，默认 24 小时）。 |
| `injection cap` | 注入次数达到上限（`maxConsecutive`，默认 20 次）。 |
| `verify limit` | 验证命令连续失败轮次达到上限（`verifyMaxIterations`，默认 50 轮）。 |
| `interrupted while idle` | 空闲等待期间被中断（模型报错、网络抖动等导致会话中断）。 |
| `stopped by user` | 你主动中止了这一轮（Esc / 手动停止）。 |
| `abort sentinel` | 模型输出了 `<loop-abort>…</loop-abort>` 中止哨兵，插件据此停止。 |
| `title excluded` | 会话标题命中 `excludeTitleKeywords`（默认含 `测试`），插件不对该会话续跑。 |

> 完成（`[AC ✓]`）与暂停（`[AC ⏸]`）**不带**短语。`⏸` 表示**暂停**（等模型输出 `<loop-pause>…</loop-pause>`，你发新消息后恢复），**不是**停止。

### 7.5 日志路径

| 平台 | 路径 |
|---|---|
| Windows（PowerShell 写法） | `$env:USERPROFILE\.local\share\opencode\log\opencode.log` |
| Unix / macOS | `~/.local/share/opencode/log/opencode.log` |

> Windows 列为 **PowerShell 写法**（可直接粘贴到 PowerShell）；cmd 下请写用户目录的绝对路径。

在日志里搜 `opencode-autocontinue`，过滤出插件自己的报错行。常见的加载失败表现是：RPC 注册失败、TUI 组件启动失败、找不到宿主提供的 `session.synthetic` 能力。
