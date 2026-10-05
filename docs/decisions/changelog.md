# 变更记录

| 日期 | 版本/阶段 | 变更 |
|---|---|---|
| 2026-10-03 | A–C 完成 | 骨架 + RPC + server 核心（config/state/events/engine/prompt）+ TUI（slash 命令 + footer slot）全部实现；`node --test test/server.test.ts` 25/25 pass；esbuild 打包通过 |
| 2026-10-03 | 阶段 D | 待实机验证：本地 file:// 加载、续跑注入实测、卸载干净性 |
| 2026-10-03 | 阶段 E | 待发布：推送前脱敏扫描、GitHub 发布、plugin update 验证 |
| 2026-10-03 | 文档 | 文档体系重构：DESIGN.md 单文件 → `docs/` 总览 + guides/features/architecture/decisions 分类分文件，根 README 瘦身为入口页。纯文档变更，无代码改动 |
| 2026-10-03 | 审计修复 | 深度审查修复（S1-S5 + M3/M4/M5/M7）：TUI 跨会话信号污染、off 后 footer 残留、跨午夜窗口、空 markers 匹配一切、inFlight 竞态、单引号 JSONC、resume 闩锁、error status 匹配。单测 25→35，esbuild 双绿 |
| 2026-10-04 | 0.2.0 | TUI 值守块修复：每会话独立状态表替代全局信号（多会话同时值守互不覆盖）；动态读全部移入 createMemo（侧栏/footer 立即刷新，无需切 session）；RPC status 输出 schema 全声明字段（`since` 透传，侧栏时长正确显示）；slash `status` 直接读 RPC 结果；`currentSessionIDFrom` 优先 slot 缓存的 lastSlotSessionID；TUI 显示全英文（Watch / resumes）。另修复 RPC client contract 必须声明 methods（`rpc.set is not a function` 根因） |
| 2026-10-05 | 0.2.1 | 新功能：保活心跳（`intervalMs` / `intervalMessage`，默认 1h）——值守会话周期性注入固定话术，模型 busy / 恢复注入在途 / 完成标记 / 非值守时跳过，不递增 `consecutive`；watch/unwatch/停止路径启停定时器。修复：`lastInjectedAt: undefined` 触发 RPC schema 校验失败（`Expected number`）导致 status 报错与切会话后标记消失（序列化时省略 undefined 字段）；footer/侧栏 JSX 改直接读 memo getter（`{label()}`/`{content()}`）修复 `/autocontinue on` 后图标不立即出现（usage-meter v0.7.8 同款）；`⏱` 时长支持 天/小时 单位（`613m` → `10h 13m`） |
| 2026-10-05 | 0.2.2 | 深度审查修复（oracle 全量审查：无 P0，2 P1 / 10 P2 / 10 P3）：**P1-1** 心跳补值守窗口检查（`startTimeNotReached` / `endAt` 已过→停止，不再窗口外注入）；**P1-2** 心跳与注入共用 `inFlight` 锁跨 await（完成标记检查窗口期不再双注入）；**P2** hydrate 归一化旧数据防 schema 失败、注入前复查 userGrace、`message.updated` 兼容扁平 `event.info`、完成检测节流 2s、`pendingContinue` 闩锁超时（idleDelayMs/30s 兜底）、resume 重算已过窗口、`clearTimer` 公开供 off 路径清理；**P3** 标题空串不缓存、`intervalMs` 下限钳制 1s、无窗口 `{remaining}` 渲染"不限"、`errorPatterns` 的裸 `"5"` 收紧为 `"(status: 5"`、persist 串行化、titleCache 随 unwatch 清理。单测 41→49 |