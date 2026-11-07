# 总体架构

## 项目概述

OpenCode V2 服务端 + TUI 插件：自动续跑因非用户原因中断、但整体任务尚未完成的会话。模型报错、阶段完成后的空闲、网络抖动、工具失败——只要会话在值守名单里，判定通过后注入续跑消息，直到任务完成或触发停止条件。

**设计边界（不做）**：

- 不做 AI 判断"任务是否完成"（用完成标记 + 次数兜底，更可控、零额外模型成本）
- 不接管 opencode-bridge 的运行时（只对会话层面续跑）
- 不做 TUI 复杂面板；只做 footer 状态指示 + 右侧栏 Watch 块 + toast 反馈
- 只对用户主动值守的会话生效（`/autocontinue on|off`），不做全局自动跑

## 运行环境与加载机制

1. **发现**：OpenCode 启动时读取 `package.json` 的 `exports`——`"."` → `src/index.ts`（server 插件）、`"./tui"` → `dist/tui.js`（TUI 插件，预构建 bundle；v0.3.9 起对齐 usage-meter/OMO-Slim 交付路径）
2. **server 入口**：`Plugin.define({id, setup})`，注册 retry hook + 事件订阅 + RPC
3. **TUI 入口**：slash 命令 + footer 状态 slot + 右侧栏 Watch 块（`@jsxImportSource @opentui/solid`）
4. **生命周期**：`setup(context)` 执行一次；返回清理函数在卸载/重载时执行
5. **热重载限制**：`plugin update` 后必须完整重启（详见 [runtime-lessons.md](runtime-lessons.md)）

## 三层数据流

```
OpenCode 后台服务（事件总线）
  session.error / session.idle / message.updated / retry hook
        │ ctx.event.subscribe / ctx.session.hook
        ▼
server 插件（权威逻辑）
  retry hook → 错误改可重试+退避
  值守列表（ctx.storage 持久化）→ 判定 → 延迟/节流/次数/时段
  session.synthetic（优先）/ session.prompt（回退）→ 注入续跑消息
        │ autocontinue.state.changed 事件（RPC）
        ▼
TUI 插件
  footer.status slot → [AC ●] / [AC ✓] / [AC ⏸] / [AC ⏹ N] / [AC ⏹ N · 短语]
  sidebar.content slot → Watch 块（⏱ 时长 / 🔄 注入次数 / 🎯 状态 / 🔍 verifying / 🚫 rejections / 🛠 tool failures）
  /autocontinue 命令 → toast 反馈
```

- **server**：权威逻辑所在，只监听事件 + 提供 RPC
- **TUI**：命令入口 + 状态展示；命令经 RPC 完成开关，再 toast + footer 展示
- **RPC**：同进程内 `ctx.rpc()` 直接调用；跨进程用 HTTP client

## 验证方式

- **语法快检**：`node --experimental-strip-types --check src/<file>.ts`（逐文件执行；PowerShell 不展开 `src/*.ts` 这类 glob，所以不要写成通配一条命令）
- **单元测试**：`npm test` —— 跑全部 12 个测试文件、251 个用例（server / config-safety / tui-delivery / verify-safety / session-resolution / index / rpc-contract / config-load / round-budget / keep-alive / guardrail-off / title-exclusion），覆盖解析、判定矩阵、节流、时段、排除、完成标记、并发、跨日窗口、验证 Loop、哨兵、配置健壮性、多字节解码、挫败感触发、停止原因，以及 **RPC 契约**、**server 入口装配**、**停止原因在 server 与 TUI 两侧的一致性**；跑完自行退出，不需要 `--test-force-exit`
- **TUI 打包**：`npm run build:tui`（esbuild bundle `src/tui.tsx` → `dist/tui.js`，`@opencode/*`/`@opentui/*`/`solid-js` 全 external）。`dist/tui.js` 是 **TUI 侧的交付载体**——`exports["./tui"]` 指向它，改了 `src/tui.tsx` 不重新打包，TUI 侧不会生效
- **真机**：`opencode plugin add github:dubuqiangu/opencode-autocontinue` → 完整重启 opencode → 会话内 `/autocontinue on`，然后确认 footer 出现 `[AC ●]`、`/autocontinue status` 正常、`/autocontinue off` 能关闭；错误/空闲注入与完成标记停止见 [任务清单](../../tasks.md)
