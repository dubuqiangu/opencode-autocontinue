# 边界情况与已知限制

## 边界处理

| 场景 | 处理 |
|---|---|
| `session.error` 与 `message.updated(error)` 同时到达 | `pendingContinue` 去重，只在 idle 时统一发送 |
| 会话运行中收到错误/空闲 | `session.status` 非 idle 时绝不注入，轮询等待 |
| 当天已过 endTime 才 on | watch 时冻结 endAt，立即停止值守，不滚动到次日 |
| 用户主动中止 | `MessageAbortedError` / `operation was aborted` / `session.interrupt` → 停止但保留值守标记（可重新 on） |
| 服务重启 | storage 仍在，内存态（定时器/在途）丢失，从 storage 恢复值守列表 |
| 插件卸载/热重载 | cleanup 返回 dispose：拆定时器、退订、注销 slot |

## 已知限制

1. 不做 AI 判断"任务是否完成"——用完成标记 + 最大次数兜底，可能误判（完成标记未命中时靠次数/时段停止）
2. `session.error` 事件载荷形状随版本变动，双兼容解析 + 单测锁定当前版本，宿主升级后需回归
3. retry hook 的错误分类依赖 opencode 判定，仅影响单次模型调用；最终失败仍走续跑兜底
4. 插件需 opencode 服务存活；服务重启后定时器/在途态丢失，从 storage 恢复值守名单
5. 值守范围只限用户主动 `/autocontinue on` 的会话，不做全局自动跑