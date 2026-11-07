# opencode-autocontinue — tasks

每项小而可独立验证，标注验证方式。
文档地图见 [docs/README.md](docs/README.md)，设计意图见 [DESIGN.md](DESIGN.md)。

## 当前状态

- **已发布版本**：0.5.3（本轮发布；改动 `src/` 运行时行为，按发布规则 bump）
- **上一版本**：0.5.2（commit `1ad769b`）
- **本轮修复内容概述**：
  - `maxConsecutive` 负值不再静默取消注入上限——负值回退默认 20，`0` 仍表示不限
  - 墙钟预算改为**按轮次计量**——真实用户消息开启新一轮时，`watchTimeoutMs` 预算重新计算，不再从首次值守起无限累加
  - 停止原因新增第 8 种短语 `title excluded`（会话标题命中 `excludeTitleKeywords` 而停止），并可在 footer 与 `status` toast 中观测
  - 停止原因取值收敛为**单一真源**（`src/rpc.ts` 持有 8 值定义），并加测试守卫确保 RPC 契约 / 状态存储 / 界面文案三者一致
  - 单测定时器泄漏修复：`npm test` 跑完自行退出，不再需要 `--test-force-exit`
  - `package.json` 新增 `test` script，`npm test` 可直接使用
  - 文档层校正与结构化：入口页、安装/更新/卸载命令占位符、断链修复、changelog 按版本分节、设计稿拆分三份

## 阶段 A：骨架与 RPC ✅

- [x] A1 创建包骨架 `opencode-autocontinue/`
      - `package.json`（type=module, exports `.`→`src/index.ts`, `./tui`→`src/tui.tsx`）
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

## 阶段 D：验证收敛 ⏳ 实机验证未完成

- [x] D1 安装方式（任务1）✅ 已按 usage-meter 同构改为包管理：
      - `opencode plugin add github:dubuqiangu/opencode-autocontinue`（已移除 file:// 条目，避免双重加载）
      - `plugin list` → `autocontinue ba2c3fd` = GitHub HEAD
- [ ] D1b 跨午夜值守窗口与侧栏实机验证
      - 验证：配置 `startTime`/`endTime` 为跨午夜窗口（如 22:00→08:30），确认窗口开/关两侧行为正确；侧栏 Watch 块 `⏱` 走动、`off` 立即消失
- [ ] D2 续跑实测：真实造错/空闲 → 续跑消息注入；完成标记 → 停
      - 验证：观察会话历史 + footer + 侧栏 Watch 块；验证命令的 TOCTOU 复检路径（验证前快照比对）在实机上确认生效
- [ ] D3 卸载/重装干净，无残留订阅
      - 验证：`plugin remove` 后无报错；重装后 `stopReason` 短语（如 `window closed` / `title excluded`）在 footer 与 `/autocontinue status` toast 中按预期显示

## 阶段 E：发布 ✅ 已完成（v0.3.x 发布窗口）

- [x] E1 推送前脱敏扫描（git ls-files：凭据形状/隐私路径/运行产物）
      - `scripts/sanitize-scan.ts` 跑通：credential/privacy CLEAN，无运行产物入库
- [x] E2 推送 GitHub → `dubuqiangu/opencode-autocontinue`（public）
      - `git push origin master`：c475d51..ba2c3fd，远端 HEAD = ba2c3fd
- [x] E3 `opencode plugin update` 验证 = GitHub HEAD
      - `plugin list` → `autocontinue ba2c3fd` ✅

## 阶段 F：机理移植（参考 `MichengAI/dsh-pua`）✅ 已交付

设计稿见 [docs/architecture/provenance-and-loop.md](docs/architecture/provenance-and-loop.md)，
现行机制规格见 [docs/architecture/loop-mechanisms.md](docs/architecture/loop-mechanisms.md)。

- [x] F1 注入溯源（修真实 bug：`maxConsecutive` 失效 + 误 arm `userGraceMs`）—— **v0.4.0 交付**
      - 注入优先 `session.synthetic`（带 `metadata{origin}`），回退 `session.prompt`（带 `metadata`）
      - 引擎仅对**真实用户消息**调 `resume()`/写 `lastUserMessageAt`
      - 验证：单测溯源判定矩阵（真实用户 / 插件注入 / prompt 回退）+ 实机查 `session_message.type`
- [x] F2 验证驱动续跑 Loop —— **v0.4.0 交付**
      - 新模块 `src/verify.ts`（`runVerification` / `verificationArgv` / `buildVerifyDetail`）
      - config：`verifyCommand` / `verifyTimeoutMs` / `verifyMaxIterations` / `verifyCwd`
      - 引擎：完成改按 exit code 判定；cap 前置但先跑一次验证（pass→done，否则 stopped）
      - 验证：假 spawn 单测（pass/fail/timeout）+ 实机（恒真/恒假命令）
- [x] F3 升级式续跑提示 + 终止哨兵 —— **v0.5.0 交付**
      - config：`escalationMessages[]` / `abortSentinel` / `pauseSentinel` / `doneSentinel`
      - 按轮次分桶选提示；哨兵成对匹配；优先级 abort/pause > done > 续跑
      - 验证：分桶单测 + 哨兵匹配单测

## 附：已完成验证记录

- 2026-10-03：src/*.ts 全部 `node --check` 通过；esbuild 打包通过（server 7 文件 + tui.tsx JSX）
- 2026-10-03：`node --test test/server.test.ts` → 25/25 pass
- 已实现：DESIGN.md 目录树 + 交互顺序图；README.md；tsconfig.json
- 2026-11-07（v0.5.3 本轮）：入口层文档全面校正（footer / 侧栏 / toast 实际形态、5 类停止护栏、8 个停止原因、`userGraceMs` 默认 15 秒、默认续跑消息文案、正确开发命令）；墙钟预算改为按轮次计量；停止原因新增 `title excluded`；单测定时器泄漏修复并新增 `test` script。验证由编排者统一执行（`npm test` / `npm run build:tui` / `node --experimental-strip-types --check src/<file>.ts`）。
