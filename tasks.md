# opencode-autocontinue — tasks

从 DESIGN.md 生成。每项小而可独立验证，标注验证方式。
文档地图见 [docs/README.md](docs/README.md)。

## 阶段 A：骨架与 RPC ✅

- [x] A1 创建包骨架 `opencode-autocontinue/`
      - `package.json`（type:module, exports `.`→`src/index.ts`, `./tui`→`src/tui.tsx`）
      - `.gitignore`（node_modules, dist, *.local.md）
      - 验证：`node -e "console.log(require('./package.json').name)"` 输出正确
- [x] A2 `src/rpc.ts`：定义 RPC `autocontinue`
      - methods: `set{enabled}`、`status{perSession}`、`list`
      - events: `state.changed{sessionID,state,consecutive}`
      - 验证：esbuild 打包通过
- [x] A3 `src/index.ts`：server 入口，注册 RPC + 空 setup
      - 验证：esbuild 打包通过

## 阶段 B：server 核心逻辑 ✅

- [x] B1 配置加载器 `src/config.ts`
      - 读全局 `~/.config/opencode/opencode-autocontinue.jsonc` + 项目 `.opencode/` 覆盖，deep merge
      - JSONC 解析（注释+尾逗号，参考已核实实现）
      - 验证：`node --check` + 单测（node:test）解析默认+覆盖+坏文件
- [x] B2 值守状态存储 `src/state.ts`
      - `ctx.storage` 持久化 watched map；内存态含 inFlight/pending 锁
      - 验证：单测（内存态逻辑）+ 集成（storage mock）
- [x] B3 事件解析 `src/events.ts`
      - `sessionIDFromEvent` 双兼容（平铺/嵌套）
      - error 提取、assistant 文本提取、完成标记正则
      - 验证：单测覆盖 V2 载荷样例
- [x] B4 判定与调度 `src/engine.ts`
      - retry hook：瞬时错误改可重试+指数退避
      - 错误/空闲 → 判定（值守?排除?时段?节流?用户宽限?）→ 延迟注入
      - 完成标记/次数/时段/off → 停止
      - 单实例 inFlight 锁、双事件去重、busy 轮询
      - 验证：单测（用注入时钟 mock 判定矩阵）+ esbuild
- [x] B5 续跑注入 `src/prompt.ts`
      - `session.prompt` 注入自定义消息（模板 `{time}` `{remaining}` 渲染）
      - 验证：单测模板渲染 + 集成 mock prompt

## 阶段 C：TUI ✅

- [x] C1 `src/tui.tsx`：slash 命令 `/autocontinue on|off|status` 调 RPC
      - toast 反馈；命令后刷新 footer
      - 验证：esbuild `--loader:.tsx=tsx --jsx=automatic`
- [x] C2 footer 状态 slot：`prompt.footer.status` 显示值守状态
      - 订阅 RPC `state.changed` 事件刷新；当前会话 title 排除词高亮
      - 验证：esbuild 通过

## 阶段 D：验证收敛 ⏳ 待实机

- [ ] D1 本地 `file://` 加载，重启 opencode
      - 已在 `opencode.json` 注册 `file:///D:/workSpace/python/aicode/opencode/opencode-autocontinue`（已备份 .bak.20261003_125721）
      - `/autocontinue on` → toast+footer 出现；`status` 正确；`off` 移除
      - 验证：实测 TUI（需重启 opencode 后）
- [ ] D2 续跑实测：真实造错/空闲 → 续跑消息注入；完成标记 → 停
      - 验证：观察会话历史 + footer
- [ ] D3 卸载/重装干净，无残留订阅
      - 验证：`plugin remove` 后无报错

## 阶段 E：发布（用户决策门）⏳ 待用户确认推送

- [x] E1 推送前脱敏扫描（git ls-files：凭据形状/隐私路径/运行产物）
      - `scripts/sanitize-scan.ts` 跑通：credential/privacy CLEAN，无运行产物入库
      - 已本地提交 90ccd47（17 文件，2001 insertions）
- [ ] E2 用户确认推送 → git push + README 同步
- [ ] E3 `opencode plugin update` 验证 = GitHub HEAD

## 附：已完成验证记录

- 2026-10-03：src/*.ts 全部 `node --check` 通过；esbuild 打包通过（server 7 文件 + tui.tsx JSX）
- 2026-10-03：`node --test test/server.test.ts` → 25/25 pass
- 已实现：DESIGN.md 目录树 + 交互顺序图；README.md；tsconfig.json