# opencode-autocontinue — tasks

每项小而可独立验证，标注验证方式。
文档地图见 [docs/README.md](docs/README.md)，设计意图见 [DESIGN.md](DESIGN.md)。

## 当前状态

- **已发布版本**：0.5.4（本轮发布；`src/config.ts` 有运行时 API 变更，按发布规则 bump）
- **上一版本**：0.5.3（commit `ece2e56`）
- **本轮修复内容概述**（本轮无用户可见行为变更）：
  - 全局配置路径可注入：`loadConfig` 新增可选第二参数 `LoadConfigOptions`，可指定读取哪个全局配置文件；不传时行为与 v0.5.3 完全一致
  - 测试不再改写 `USERPROFILE` / `HOME` 这类进程级环境变量来隔离真实用户配置——进程级全局状态在同进程并行跑测试时会互相污染
  - 测试夹具去重：`test/server.test.ts` 自带的 `FakeStorage` / `makeFakeSession` / 引擎注册表删除，统一改用共享夹具 `test/support/harness.ts`，仓库内不再有第二份实现
  - 测试解除文案硬编码：断言改为与配置常量比对，断言的是**行为**（注入的就是配置的那条消息）而不是文案本身

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
- 2026-11-08（v0.5.4 本轮）：全局配置路径可注入（`loadConfig` 新增可选 `LoadConfigOptions`，不传时行为不变）、测试夹具统一到 `test/support/harness.ts`、测试断言改为与配置常量比对（不再硬编码文案）。本轮无用户可见行为变更；验证由编排者统一执行。
