# Stage A — DSH 宿主 API 核验表

核验环境：DSH Desktop（profile `desktop`，`DSH_PROFILE_DIR=C:\Users\30759\.dsh\profiles\desktop`），
实现 checkout 位于 `app.asar`（shell/glob/pwsh 不可读，仅 Host 自身可读）。
核验手段：`cordis_inspect_list` + `cordis_inspect_query`（实时 Host Service / Event 契约），
以及读取已安装真实插件 `dsh-notify@0.1.7`、`dsh-session-search` 的源码与 manifest。
以下每条结论都来自上述实时契约或真实源码，**无一条来自假定**。

## A.1 插件本体形态

| 项 | 结论 | 证据 |
| :--- | :--- | :--- |
| 入口导出 | `export const name`、`export const inject`、`export function apply(ctx, config)` | `dsh-notify/lib/index.js` |
| 依赖注入 | `export const inject = []`（空数组=不强制等待服务）；也可 `inject: ['jobs']` 硬依赖 | `Service.listService.access` 给出两种表达式 `ctx.get("x")` / `ctx.x` |
| 配置 | `apply` 第二参数即该行 `cordis.patch.yml` 的 `config` 字段（按对象合并覆盖），插件内自行 normalize | `dsh-notify` 注释与 `normalizeConfig` |
| 清理 | `ctx.effect(() => async () => { ... })` 注册卸载器；`ctx.on(...)` 自身返回 disposer | `dsh-notify` apply 尾部 |
| 打包 | `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`；patch 为 `- insert: [{ id, name }]` | `dsh-session-search`、`dsh-notify` 两个真实包 |
| 运行时校验库 | `schemastery` 随宿主随包提供；`zod@4.6.5` 在 profile node_modules 中可用（**实现选 zod 4**） | `node_modules/@deepseek-ai/schemastery`、`node_modules/zod` |

## A.2 工具注册（`defineTool` 存在，但插件侧不可导入）

> 2026-10-27 Stage A 实现期修正：本节早先版本记为「`defineTool` 不存在」，**该结论错误**。
> 重新核验 `app.asar` 后确认：`defineTool` 由 `@deepseek-ai/dsh-tools@0.2.1-rc.3` 导出，
> 该包随宿主随包提供（asar 内 `node_modules/@deepseek-ai/dsh-tools`），
> `dsh-better-edit` 等已装插件确实在 `import { defineTool } from "@deepseek-ai/dsh-tools"`。
> 但对 profile 插件而言这是**宿主内部路径**：从 profile `node_modules` 解析 `@deepseek-ai/dsh-tools`
> 得到 `ERR_MODULE_NOT_FOUND`（`@deepseek-ai/cordis` 同样）。故对第三方插件仍属**不可依赖**。

| 项 | 结论 |
| :--- | :--- |
| 注册接口 | `ctx.tools.register(definition: ToolDefinition): () => void` |
| `ToolDefinition` | `{ name, description, parameters: Record<string, unknown>（原生 JSON Schema）, output: { schema: JsonSchemaNode, render(args, value): ContentBlock[] }, execute(args, exec): Promise<unknown>, isConcurrencySafe?, timeoutMs?, presentCall?/presentResult? }` |
| `defineTool` 归属 | 宿主包 `@deepseek-ai/dsh-tools` 导出；**插件侧不可解析** ⇒ 不作为实现依赖 |
| `defineTool.parameters` DSL | 每属性 `{ type, required: true, description }`，经 `parameterSchemaSpecToJsonSchema` 编译为 `{type:'object', properties, required[]}`；`output.schema` 走 `valueSchemaSpecToJsonSchema` |
| 返回 | 精确的注销 disposer（HMR/卸载安全） |
| 作用域 | 在 `agent.ctx` 注册=仅该 agent 可见；纯上下文=全局 |
| 实现决策 | 用 `ctx.tools.register` + **原生 JSON Schema** 写 `parameters`，运行时校验用自带 `zod@4`。避开不可解析的宿主内部包，同时保留严格校验与 disposer 语义。 |

## A.3 systemPrompt 动态注入

| 项 | 结论 |
| :--- | :--- |
| 真实接口 | `ctx.systemPrompt.section(PromptSection)` / `ctx.systemPrompt.context(PromptContext)` |
| `PromptSection` | `{ name, order, text: string \| ((ctx: AssembleContext) => string), interpolate?, complete? }` |
| `PromptContext` | `{ name, order, text: string \| (fn), interpolate?, required? }` |
| 动态性 | `text` 可为**每次装配时求值的函数** ⇒ 支持每轮动态注入 |
| 排序 | `getSectionOrder(name)` / `getContextOrder(name)` 提供仓库中心化 order；自定义段可用固定数值 |
| 限制 | 同一层内重名抛错；`complete: true` 会独占整个 prompt（本插件不使用） |
| 结论 | **supported**。Level 1 轻量注入与 Stage G 摘要注入走 `context()`（运行时上下文，非永久 section，更省 token）。 |

## A.4 定时调度与后台任务（关键分歧点）

| 候选 | 真实契约 | 判定 |
| :--- | :--- | :--- |
| `ctx.jobs` | abstract 后台作业注册表。`JobKindMap` 当前只有 `'bash'`；`start(spec)` 需要 `owner`（SessionId）且必须有 attached controller；语义是**一次性长任务的输出环形缓冲**，无周期语义、无持久化调度、无跨会话绑定 | **不是通用周期调度器** ⇒ 周期调度 = **unsupported** |
| `ctx.schedule` | `create(sessionId, {title, prompt, after_seconds\|at\|every_seconds\|daily\|weekly\|cron})`，持久、绑定 Session、可 `list/catalog/delete/update/history`；触发方式=向该 Session 投递一条消息（会唤醒会话） | 持久周期能力 **supported**，但语义是"给会话发提醒"，不是宿主内后台 tick |
| `ctx.timer` | `interval(cb, delay): () => void`、`timeout`、`throttle`、`debounce`，全部 **fiber 绑定自动释放** | 宿主内周期 tick 的正解 ⇒ **supported** |

**结论**：插件内周期检查（Stage F）用 `ctx.timer.interval` 实现，默认 25 分钟，disposer 交给 `ctx.effect`；
`ctx.schedule` 仅作为可选的"跨重启持久提醒"增强，且必须由用户显式开启（默认关闭），因为它的代价是唤醒会话。
规格中"`jobs` 天然是周期调度器"的假设**不成立**，已在实现中纠正。

## A.5 会话上下文与工具活动读取

| 需要的数据 | 真实接口 | 等级 |
| :--- | :--- | :--- |
| 用户输入文本 | 事件 `session/event(session, event)`，`event.type === 'user/message'`，`data` 为 `UserMessage` | Grade A（原始文本） |
| 工具调用活动 | 事件 `session/event` 的 `'tool/call'`（`callId`,`name`,`arguments`）与 `'tool/result'`（`message`,`error`,`meta`） | Grade A |
| 轮次边界 | `'turn/start'`/`'turn/end'`、`'step/start'`/`'step/end'` | Grade A |
| 当前 Agent/Session | `exec.agent.id`（工具执行上下文）、`ctx.agents.list()/currentInitiator()` | supported |
| 历史会话内容 | `ctx.sessions.get(id)` → `Session.snapshotEvents()/ownEvents()/seq`；`ctx.sessionQuery`、`ctx.sessionPersistence` 可读持久日志 | supported（本插件第一版只用 live store） |
| 工作目录 | `ctx.workingDirectory.get(session)` / `.defaultDirectory`；`Session.header.cwd` | supported（**projectId 派生源**） |

**去重指纹来源**：`sessionId + callId`（工具事件，稳定唯一）；用户输入用 `sessionId + seq`；
手动记录用 `sessionId + 内容 SHA-256`。三者均可用真实字段构造，无需造假。

## A.6 门控（Level 3 硬阻断）

| 项 | 结论 |
| :--- | :--- |
| 真实接口 | 事件 `tools/pre-execute`（waterfall），`PreToolDecision = {kind:'allow'} \| {kind:'deny', reason, info?} \| {kind:'cancel'} \| {kind:'ask', reason?}` |
| 另有 | `ctx.tools.guard((exec) => string \| undefined)`（返回字符串即拒绝，单调、不可被强制放行） |
| 结论 | **supported**。Level 3 确实可以硬阻断非只读工具，规格要求的"降级为强提示"**不需要启用**。实现采用 `tools/pre-execute`（可给出结构化 reason 与卡片），并在 `exec.signal` 上正确响应取消。 |

## A.7 生命周期与 HMR

| 项 | 结论 |
| :--- | :--- |
| 卸载/热重载 | Cordis fiber 卸载会执行所有 `ctx.effect` disposer；`ctx.on` 返回的 disposer、`ctx.timer.*` 返回的 disposer、`ctx.tools.register` 返回的 disposer、`ctx.systemPrompt.*` 返回的 disposer 全部 fiber 绑定 |
| 进程重启 | 内存态（去重集合、待决干预缓存）不持久；**所有结构性状态必须落盘**（见 Stage B），重启后从磁盘恢复 |
| 要求 | 所有注册必须保留并显式 disposer，禁止裸 `setInterval`；落盘写入需可中断且不破坏 CAS |

## A.8 需求驱动而实现时发现的能力缺口

| 缺口 | 影响 | 处理 |
| :--- | :--- | :--- |
| 无"会话内持久 key-value 存储"服务 | 插件状态需自管 | 用 `ctx.fs`（abstract，含 `writeText/editText/stat/listDir`）实现 `projectId` 隔离的文件存储，路径挂在 `ctx.workingDirectory` 得出的项目根下 |
| `ctx.fs.writeText` 带 `expected` 版本意图 | 可作为文件级 CAS 底层 | 数据层仍以**自管 `version` 整数 + 写前读校验**实现应用层 CAS（`FsWriteIntent` 语义由 `dsh-better-edit` 使用，不宜依赖其细节） |
| 工具 `execute` 返回任意值但需 `output.render` | 结果需渲染为 ContentBlock | 统一用 `text` block 渲染 JSON/Markdown |
| 无 LLM 调用接口给插件用于"模型判断" | 分析层不能用模型 | 分析层为**纯确定性程序**（规则+阈值+历史窗口）；模型只通过工具参数提供解释与候选判断，程序做校验后才落库（符合 0.2 原则） |
| 宿主不提供可解析的 TS 类型包 | `tsc --strict` 缺少 `Context`/`ToolDefinition` 声明 | 在 `src/host.ts` 维护**窄结构类型**（仅声明插件真正用到的成员），全部来自上述实时契约核查，不引入运行时不可解析的 import |
| 无插件侧 bundler（esbuild 等未安装） | TS 需自带编译链 | `metacog/` 本地装 `typescript@5.9.3` + `@types/node@22`，`npm run build` → `lib/`，宿主加载 `lib/index.js` |

## A.9 Stage A 落地与本节的对应关系

| 本节结论 | 落地位置 |
| :--- | :--- |
| A.1 入口形态 | `src/index.ts`：`name` / `inject = ['tools']` / `apply(ctx, config)` |
| A.2 工具注册 | 后续 Stage C/D 使用 `ctx.tools.register` + 原生 JSON Schema |
| A.3 systemPrompt | `src/host.ts` 声明 `systemPrompt.section/context`；Stage G 接入 |
| A.4 周期调度 | `src/host.ts` 声明 `timer.interval`；Stage F 接入，`ctx.jobs` 不用于周期调度 |
| A.6 门控 | `tools/pre-execute` waterfall + `ctx.tools.guard`；Stage D 的 Level 3 用其硬阻断 |
| A.7 生命周期 | `apply` 内单一 `ctx.effect` teardown，`Mount.claim` 统一收口所有 disposer |
| A.8 校验库 | `src/config.ts` 用 `zod@4`；配置非法值硬报错，未知键忽略 |

## A.10 结构化输出 schema 只接受 JSON Schema 的一个子集

宿主在启动子 agent 前会先编译传入的 `outputSchema`，遇到不支持的形状直接抛 `JsonSchemaError`，不降级。这一条曾让整个推导功能不可用。

已实测的不支持项：

- `type` 写成数组，例如 `type: ['string', 'null']`，报
  `unsupported JSON schema: ... .type must be a single type string (type arrays are not supported)`。

可空字段因此只能用显式编码，并在边界归一化：

| 位置 | 线上编码 | 归一化点 |
| :--- | :--- | :--- |
| `DERIVATION_JSON_SCHEMA` 的 `parentTempId` | 根目标传 `""` | `tree-lifecycle.ts` 映射为 `null` |
| `contradiction_observe.intensity` | `0` 表示「无法判断」 | 落库为 `null` |
| `contradiction_tree_edit.intensity` | `0` 表示清空 | 落库为 `null` |

`test/schema-shape.test.mjs` 会遍历全部工具的 `parameters` 与推导 schema，一旦重新出现 type 数组即失败。
