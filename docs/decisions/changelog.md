# 变更记录

| 日期 | 版本/阶段 | 变更 |
|---|---|---|
| 2026-10-03 | A–C 完成 | 骨架 + RPC + server 核心（config/state/events/engine/prompt）+ TUI（slash 命令 + footer slot）全部实现；`node --test test/server.test.ts` 25/25 pass；esbuild 打包通过 |
| 2026-10-03 | 阶段 D | 待实机验证：本地 file:// 加载、续跑注入实测、卸载干净性 |
| 2026-10-03 | 阶段 E | 待发布：推送前脱敏扫描、GitHub 发布、plugin update 验证 |
| 2026-10-03 | 文档 | 文档体系重构：DESIGN.md 单文件 → `docs/` 总览 + guides/features/architecture/decisions 分类分文件，根 README 瘦身为入口页。纯文档变更，无代码改动 |