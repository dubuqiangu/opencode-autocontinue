# opencode-autocontinue — 设计意图与当前实现对照

本文只回答两个问题：**这个插件为什么存在**，以及**现在的代码是怎么落地的**。
具体机制规格以 [docs/architecture/loop-mechanisms.md](docs/architecture/loop-mechanisms.md) 为准，
模块与文件职责以 [docs/architecture/module-layout.md](docs/architecture/module-layout.md) 为准。

## 1. 它解决什么问题

OpenCode 的会话经常在总任务没做完时中断：模型返回 `bad_response_status_code`、阶段完成后的长时间空闲、网络抖动、工具失败。人在场时可以手动敲一句「继续」；人不在场时，这段等待可能长达几小时甚至一整夜。

本插件的定位是**看门狗**：它不判断「任务是否完成」，只在**会话已经断掉、且没有人接手**时，替人补一句续跑消息，把会话推回工作状态。

三条边界从一开始就定死：

- 不做 AI 侧的完成判断——用完成标记 + 各类上限兜底，零额外模型成本，行为可预测。
- 不接管宿主的其他运行时，只在会话层面补消息。
- 只对用户显式开启值守的会话生效，不做全局自动跑。

## 2. 三层结构

```
事件订阅层   订阅 session.error / session.idle / message.updated，挂 retry 钩子
     ↓
引擎层       判定「该不该注入」「现在能不能注入」「注入什么」，负责调度与闸门
     ↓
状态存储层   ctx.storage 持久化每会话值守状态，内存态持锁（inFlight / pending / verifying）
     ↓
TUI 呈现层   footer 指示 + 右侧栏 Watch 块 + slash 命令 toast（只读展示与开关入口）
```

分层的意义是：**判定逻辑只有一处**。TUI 不做任何决策，server 也不认识界面。两侧通过 RPC 契约
（`set` / `status` / `list` + `state.changed` 事件）交换状态，因此同一个会话在多终端、
多面板下呈现一致，改判定不会牵动界面。

## 3. 注入判定链

事件驱动注入走一条固定顺序的判定链，任一环不满足就不注入：

1. **值守名单**——该会话是否被 `/autocontinue on` 开启
2. **排除项**——是否命中用户主动中止、标题排除关键词等不该续跑的信号
3. **时段窗口**——`startTime` ~ `endTime` 是否开着（支持跨午夜窗口）
4. **节流**——距上次注入是否已过 `minIntervalMs`
5. **用户宽限期**——用户刚发过真实消息则让路（`userGraceMs`，默认 15 秒）
6. **非 busy**——会话是否正在跑（busy / retry / 活跃流式输出）

全部通过后注入。注入优先走 `session.synthetic`（带来源标记，便于区分「插件注入」和「真人发言」），
宿主不支持该 API 时回退 `session.prompt`。注入前有单实例在途锁与双事件去重，不会打断正在跑的会话。

另有 **retry 钩子**作为更靠前的一道防线：命中 `errorPatterns` 时直接把这次调用改成可重试并指数退避，
在调用层就把失败消化掉，根本不产生续跑消息。

## 4. 停止条件与停止原因

值守会在下列任一条件成立时停止，共 5 类护栏：

| 护栏 | 配置项 | 默认 |
|---|---|---|
| 完成标记 | `completionMarkers` | `[任务完成]` 等 |
| 注入上限 | `maxConsecutive` | 20 |
| 值守时段窗口 | `startTime` / `endTime` | 不限 |
| 墙钟上限 | `watchTimeoutMs` | 24 小时 |
| 验证轮次上限 | `verifyMaxIterations` | 50 |

停止时状态为 `stopped`，并记录一个停止原因短语，共 8 种：

`window closed` / `watch timeout` / `injection cap` / `verify limit` / `interrupted while idle` / `stopped by user` / `abort sentinel` / `title excluded`

`paused` 是另一种终态，表示被暂停哨兵挂起，不等于停止。

## 5. 当前实现锚点

| 想知道的 | 去哪读 |
|---|---|
| 每个判定环节的准确规格 | [docs/architecture/loop-mechanisms.md](docs/architecture/loop-mechanisms.md) |
| 某个机制为什么这么定、哪些方案被否决 | [docs/architecture/provenance-and-loop.md](docs/architecture/provenance-and-loop.md) |
| 机制来源与各版本落地记录 | [docs/architecture/loop-evidence.md](docs/architecture/loop-evidence.md) |
| 文件与模块职责划分 | [docs/architecture/module-layout.md](docs/architecture/module-layout.md) |
| 事件词汇与状态结构 | [docs/architecture/events-and-state.md](docs/architecture/events-and-state.md) |
| 用户可见的配置项与命令 | [docs/features/config.md](docs/features/config.md)、[docs/features/commands.md](docs/features/commands.md) |
