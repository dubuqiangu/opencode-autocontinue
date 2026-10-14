# 运行时问题取证记录

真实环境暴露的问题、根因与修复。

## 事件载荷形状：sessionID 平铺/嵌套双兼容

V2 事件 `event.sessionID` 平铺，但载荷形状随版本变动。实现用 `sessionIDFromEvent` 双兼容解析（平铺/嵌套都取得到），单测锁定当前版本。宿主升级后需回归。

## keymap 作用域：Keymap.Provider is missing

TUI 的 slash 命令若在 `setup()` 直接注册 keymap 会抛 `Keymap.Provider is missing`（usage-meter v0.6.4 实测坑）。keymap 层必须从 `app` slot render（组件作用域）注册，一次性 guard，失败置 `null` 防重复注册。

## 热重载限制：plugin update 后必须完整重启

`opencode plugin update` 只更新磁盘包，运行中宿主仍持旧代码；`/reload` 会拆除旧实例的定时器与订阅，但不从磁盘重载插件。表现为续跑引擎停摆。**每次更新后必须完整重启 opencode。**

## retry hook 的语义边界

retry hook 的 `bad_response_status_code` 分类依赖 opencode 对错误类型的判定；retry 决策仅影响"该次模型调用"，最终失败仍走会话级续跑兜底——两层是互补而非替代。

## JSX 函数组件的 props 包装层：「No current session」

`<FooterIndicator slotProps={X}/>` 调用组件时传的是 props 包装对象 `{slotProps: X}`，不是裸 slot props。v0.3.6 前实现直接在包装层读 `.sessionID`——恒 undefined，`lastSlotSessionID` 从不缓存，`/autocontinue` 命令执行时三级回退（slotProps → 缓存 → router）全空，报「No current session」。修复：先解包再读（对齐 usage-meter `FooterStatus` 实证形状）；v0.3.7 将解析链抽成纯模块 `session-resolution.ts` 并加 4 把单测锁（包装错位坑 + 回退次序）。教训：JSX 组件函数的参数是 props 对象，透传 slot props 必须先解包，且解包形状要进单测。

## 经验沉淀

- 静默 try/catch 会吞掉注册类失败的可见性——注册动作要么成功要么显式日志
- 事件载荷形状以实测 + 单测锁定为准，不能只看 SDK 类型定义
- 每个版本必须真机验证后再叠加新功能