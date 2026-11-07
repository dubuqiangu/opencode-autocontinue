# 边界情况与已知限制

## 边界处理

| 场景 | 处理 |
|---|---|
| `session.error` 与 `message.updated(error)` 同时到达 | `pendingContinue` 去重，只在 idle 时统一发送 |
| 会话运行中收到错误/空闲 | `session.status` 非 idle 时绝不注入，轮询等待 |
| 当天已过 endTime 才 on | watch 时冻结 endAt，立即停止值守，不滚动到次日 |
| 用户主动中止 | `session.execution.interrupted`（V2）/ `session.idle` 且 `outcome="interrupted"`（V1，Esc 手工停止）→ 停止但保留值守标记（可重新 on）。`MessageAbortedError` / `operation was aborted` 属 `excludePatterns`（不自动续跑的错误特征），并非停止来源 |
| 服务重启 | storage 仍在，内存态（定时器/在途）丢失，从 storage 恢复值守列表 |
| 插件卸载/热重载 | cleanup 返回 dispose：拆定时器、退订、注销 slot |
| 跨午夜值守窗口 | 自动滚动到次日（22:00→08:30 在 23:00 开启不会立即停止）；次日 `00:00`..`startTime` 之间窗口仍视为开启（`startGateClosed`，v0.5.1） |
| 空完成标记配置 | `completionMarkers: []` 不检测完成，会话持续值守（不会瞬间判完成） |
| 单引号 JSONC 配置 | 解析器自动归一为双引号，配置生效（不会静默丢弃） |
| 纯 5xx 裸状态错误 | 匹配串含 `(status: N)`，`"(status: 5"` 可命中 5xx；裸 `"5"` 已于 v0.2.2 收紧为 `"(status: 5"`，`"429"` 命中 429 |

## 已知限制

1. 不做 AI 判断"任务是否完成"——用完成标记 + 最大次数兜底，可能误判（完成标记未命中时靠次数/时段停止）（v0.2.0 起）
2. `session.error` 事件载荷形状随版本变动，双兼容解析 + 单测锁定当前版本，宿主升级后需回归（v0.3.11 起）
3. retry hook 的错误分类依赖 opencode 判定，仅影响单次模型调用；最终失败仍走续跑兜底（v0.2.0 起）
4. 插件需 opencode 服务存活；服务重启后定时器/在途态丢失，从 storage 恢复值守名单（v0.2.0 起）
5. 值守范围只限用户主动 `/autocontinue on` 的会话，不做全局自动跑（v0.2.0 起）
6. **验证输出反射（部分缓解）**：assistant 若逐字引用不可信的验证命令输出（其中可能含哨兵/完成标记文本），该文本会被反射进控制流——哨兵/完成标记检测只读 assistant 消息文本，无法区分「模型自己说的」与「模型转述的验证输出」。verify 模式把完成判定绑定到命令 exit code，部分消解该风险；非 verify 模式仍以文本标记为准。完整缓解需要脆弱的启发式，故不引入（v0.4.0 起）
7. **事件路径不判哨兵（延迟，非漏判）**：assistant 事件路径不评估哨兵（`<loop-abort>` / `<loop-pause>`），依赖随后的 `session.idle` 经 `maybeInject` 兜底，最多延迟一个 `intervalMs`（默认 1h）；完成检测同样靠 idle → `maybeInject` 复查兜底（v0.4.0 起，v0.5.0 扩到 abort/pause 哨兵）
8. **挫败感触发是启发式（P2，v0.5.2）**：`frustrationTriggers` 对真实用户消息做**大小写不敏感的子串**匹配，可能**误判**（正常抱怨被当成质量不满）或**漏判**（换一种说法表达不满）。默认关闭（`frustrationTriggers: []`），词表需用户自行维护
9. **上界可被显式关闭（P3，v0.5.2）**：`watchTimeoutMs: 0` / `verifyMaxIterations: 0` 仍表示无限；默认值已改为 24h / 50，但显式写 `0` 可恢复无限值守，误配置时需要留意
10. **停止原因粒度**：`stopReason` 只说明「为什么停」，不说明「任务是否真的完成」；被护栏停掉的任务仍需人工确认（v0.5.2）
11. **24h 默认墙钟上限会结束长值守**：`watchTimeoutMs` 自 v0.5.2 起默认 24h，长任务（如跨天批量处理）会在 24h 后被停掉，需显式写 `watchTimeoutMs: 0` 恢复无限。v0.5.3 起该预算**按轮次**计量（真实用户消息开启新一轮即重算），此前按首次 `/autocontinue on` 累计（v0.5.2 / v0.5.3）
12. **Windows 上本地 `file://` 注册路径格式**：必须是三斜杠 + 正斜杠（如 `file:///D:/path/to/repo`），写成两斜杠或反斜杠会加载失败；终端用户推荐用 `opencode plugin add github:dubuqiangu/opencode-autocontinue` 而非本地路径注册（v0.2.0 起）
13. **标题排除的停止原因**：v0.5.3 起标题命中 `excludeTitleKeywords` 会停止并给出 `title excluded` 原因，不再是无原因的裸停止；此前该路径只置 `stopped`、清空 `stopReason`，footer 只显示裸 `[AC ⏹ N]`（v0.5.3）
