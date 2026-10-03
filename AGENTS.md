# 项目级工作规则(opencode-autocontinue)

本文件是本插件仓库的项目级约束。全局规则见用户全局 AGENTS.md（GitHub 前置搜索、
推送前脱敏扫描、命名见名知意、代码组织等，此处不重复）。

仓库概况：OpenCode V2 插件，自动续跑被中断的会话（模型报错、阶段性空转、网络抖动）。
`src/` 共 5 个 TS 模块 + 1 个 TUI 组件，`test/server.test.ts` 35 个用例。

- 单测：`node --test test/server.test.ts`
- 语法快检：`node --experimental-strip-types --check src/<file>.ts`

## 1. `edit` 工具纪律（`Could not find oldString` 专项）

`edit` 要求 `oldString` 与磁盘内容**逐字节一致**。不满足时报
`Could not find oldString ... must match exactly, including whitespace and
indentation`——这个报错读起来像"内容写错了"，实际绝大多数是重建失真。

本仓库是这条规则的重点受害者：**2026-10-04 之前，`src/` 下 6 个文件加 1 个测试文件
全部以 CRLF 提交**（`src/rpc.ts` 还是混合换行）。换行差异只有每行两个字节，肉眼与
`git diff` 都看不出来，却会让正确的 `oldString` 匹配失败。已由 `.gitattributes`
的 `* text=auto eol=lf` 修复并归一，**新增文件不要再引入 CRLF**。

固定下列纪律：

1. **先 `read`，再 `edit`。** `oldString` 必须逐字节从 `read` 输出复制，禁止凭记忆补写。
2. **缩进按 `read` 里的实际列数抄。** 本仓库是 2 空格缩进；嵌套层级要数清楚——
   `try` / `for` / 回调函数体内的语句比外层多 2 格。
3. **空行必须原样保留。** `read` 把空行渲染成 `3: `（行号 + 尾随空格），该尾随空格
   不可见，转录时最容易丢失——段落之间的空行不得合并。
4. **`oldString` 用 3–8 行最小锚点。** 不跨文件头注释，不跨整段接口声明或函数体，
   越大越容易失真。
5. **同一文件一轮只发一次 `edit`。** 多处改动分轮串行，或直接 `write` 整文件重写；
   禁止在一个批次里对同一文件并发多个 `edit`（后发的会因前一个已改而失效）。
6. **失败后必须先 `read` 再重试。** 连续两次失败禁止第三次盲猜——第二次仍失败说明是
   理解偏差，不是字符差异。
7. **跨 subagent 写同一文件后必须重读。** fixer / designer 落盘后，本会话此前对同文件的
   任何 `oldString` 一律视为失效快照。
8. **怀疑改动可能已落地时先 `git status` + `git diff` 确认。** 若 `newString` 的内容已
   存在于文件里，说明改动已应用，不要再下发同一 edit。

### 排查口径

`Could not find oldString` 与"多处匹配 / 需更多上下文"是两种不同错误，前者只可能是
内容不一致。按这个顺序查：

1. **换行符**——先确认是 LF（`git ls-files --eol -- <file>`，应显示 `i/lf w/lf`）。
2. **缩进列数**——最常见。逐列比对，别凭观感。
3. **空行**——段落之间的空行是否被合并。
4. **文件是否已被改过**——`git status` 看工作树。
5. **BOM**——`src/engine.ts` 的 UTF-8 BOM 已于 2026-10-04 删除。BOM 是在
   `read` 输出里看不见、但确实存在于文件字节中的首字节；任何从第 1 行开始的
   `oldString` 都会因此匹配失败。

## 2. 发布

- 改动 `src/` 或 `package.json` 属运行时变更，发布时必须 bump `version`。
- 纯文档 / 工具改动（如 `.gitattributes`）不 bump。
- 推送前走全局 AGENTS.md §2 的脱敏扫描——**扫描独立成步，先读输出再推**。
