# Stage 0 验证报告：子代理能力可用性

结论：**可用。推导层可以走 LLM 路线（设计文档 §4），无需降级到 §8。**

验证日期：2026-10-27
验证方式：静态检查 + 服务目录核验 + 运行时实测（三层交叉）

---

## 一、已验证为事实的项

### 1.1 服务存在且可从插件获取

宿主服务目录（`cordis_inspect_query` host `Service.listService`）中同时存在：

```
agents       — Agent 服务，currentInitiator(): Agent | undefined
subagents    — 子代理服务
```

两者都标注为可选访问：

```ts
optional: { expression: 'ctx.get("subagents")', requiresUndefinedCheck: true }
```

即：插件通过 `ctx.get('subagents')` 获取，`undefined` 表示不可用。
**这不是推测——它出现在宿主自己发布的服务目录里。**

### 1.2 运行时确实能派生子代理

子代理实测（会话 `5c258c9d` / `fa41e3f0`）：

| 步骤 | 实际返回 |
| :--- | :--- |
| 调用 `subagent` 工具 | `started subagent fa41e3f0-9775-4753-8997-9c75406e7eec` |
| `list_agents` 状态 | `[running] — probe` |
| 子代理回复 | 「收到」（两次：消息推送 + closing message） |

子代理真的启动了、执行了、回话了。这是运行时证据，不是文档推断。

### 1.3 配置允许两层派生

`~/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
- id: subagent
  name: "@deepseek-ai/dsh-subagent"
  config:
    maxActiveSubagents: 8
    maxDepth: 2
```

`maxDepth: 2` 意味着：用户会话（第 0 层）→ 插件派出（第 1 层）→ 该子代理还能再派一层（第 2 层）。
**插件调用一次子代理不会触顶。**

### 1.4 API 形态与设计文档一致

asar 内确认存在：`startActivation`、`currentInitiator`、`outputSchema`。

宿主目录给出的签名：

```ts
startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>

interface SubagentActivationSpec {
  provider: string
  label: string
  request: { prompt: ContentBlock[]; parent: Agent; outputSchema?: ObjectJsonSchema; ... }
  signal: AbortSignal
  delivery: 'parent' | 'caller'
}

interface SubagentActivation {
  childId: SessionId
  messageId?: MessageId
  result: Promise<SubagentResult>
  dispose(): Promise<void>
}

interface SubagentResult {
  output: readonly ContentBlock[]
  structured?: unknown      // ← outputSchema 校验后的对象
  stopReason: ...
}
```

`structured` 字段存在，这正是推导层需要的：让模型返回一个符合 schema 的对象，而不是散文。

---

## 二、仍未被直接验证的项

诚实标注，避免把"应该可以"当成"已验证"。

| 项 | 状态 | 影响 | 验证方式 |
| :--- | :--- | :--- | :--- |
| 插件 `apply` 内 `ctx.get('subagents')` 返回非 undefined | 未实测 | 若为 undefined 则必须降级 | 插件内加一行日志，重启后看 |
| `startActivation` 在插件上下文中可调用 | 未实测 | 同上 | 同上 |
| `parent` 的获取时机 | 未实测 | 工具执行时 `currentInitiator()` 应非空；定时器 tick 时可能为空 | 两处分别记录 |

**为什么没实测**：插件代码只在 DSH 启动时加载，改动需重启；而这几项只能在真实插件运行时观察。
本报告的三层验证已经把"不可能"排除，剩余的是"配置与时机"问题。

---

## 二之二、后续补充的两条决定性证据

初版报告把"结构化输出"与"服务契约"列为推断。后续验证将其升级为事实，
记录在此以免读者仍按旧结论理解。

### 证据 B：结构化输出已实测拿到

用 `workflow` 工具的 `agent()` + `schema` 实跑，schema 为：

```json
{ "type": "object", "properties": { "ok": { "type": "boolean" } },
  "required": ["ok"], "additionalProperties": false }
```

返回原件：

```json
{ "structured": { "ok": true }, "type": "object" }
```

**拿到的是校验后的对象，不是字符串。** 这证明整条链上"让模型返回结构化判断"
是可行的，不只是 API 声明里有个字段。

### 证据 C：结构化在 subagents API 层的完整路径

| 类型 | 字段 | 含义 |
| :--- | :--- | :--- |
| `SubagentStartRequest` | `outputSchema?: ObjectJsonSchema` | 请求侧声明期望结构 |
| `SubagentCapabilities` | `outputSchema: boolean` | provider 能力位，必须先查 |
| `SubagentResult` | `structured?: unknown` | 结果侧拿到校验后对象 |
| `SubagentStopReasonMap` | `completed/aborted/error/max-tokens/refusal` | 必须处理非 completed |

`SubagentCapabilities.outputSchema` 是**能力位**，意味着不是每个 provider 都支持。
调用前必须检查，否则会静默退化为只返回 prose。

### 证据 A：服务契约是权威的

宿主 Inspect Provider 给出的原文：

```
key: subagents
description: "Named provider registry with managed activations,
              durable discovery, and local child messaging."
access.optional.expression:    ctx.get("subagents")   requiresUndefinedCheck: true
access.hardDependency.inject:  ["subagents"]
access.hardDependency.expression: ctx.subagents
```

两个重载：

```ts
startActivation(spec: SubagentActivationSpec & { childId: SessionId })
  : Promise<SubagentActivation & { messageId: MessageId }>
startActivation(spec: SubagentActivationSpec)
  : Promise<SubagentActivation>
```

服务名、访问语法、方法签名都有权威契约背书。
唯一剩余的不确定是 `requiresUndefinedCheck: true` 所提示的——它**可能不存在**。

---

## 二之三、落地时的两个硬约束

这两条在实现推导层时是必须遵守的，写在这里防止遗漏。

### 约束 1：`provider` 必须先注册

`startActivation` 的第一个参数是 provider 名，而 provider 是**运行期注册**的：

```ts
// 正确顺序
const subagents = ctx.get('subagents')
if (subagents === undefined) → 降级

const providers = subagents.list()          // 先查有哪些
if (providers.length === 0) → 降级

const caps = /* 查该 provider 的 capabilities */
if (!caps.outputSchema) → 该 provider 不支持结构化，需自行解析 prose

// 然后才调用
await subagents.startActivation({ provider: providers[0], ... })
```

不能假设 provider 名字是 `'subagent'`——那是**包的条目 id**，不是注册名。

### 约束 2：`request.parent` 与 `request.signal` 都是必需且真实

```ts
interface SubagentActivationSpec {
  provider: string
  label: string
  request: {
    prompt: ContentBlock[]
    parent: Agent            // 必须是真实 Agent 实例
    outputSchema?: Record<string, unknown>
    cwd?: string
    agentOptions?: { provider?: string; model?: string }
  }
  signal: AbortSignal        // 必须传，不能省略
  delivery: 'parent' | 'caller'
}
```

获取 `parent` 的途径：

```ts
ctx.get('agents')?.currentInitiator()   // 工具执行期间可用
```

**不可用**的场景：定时器 tick、事件回调——这些不继承 initiator 边界。

这也决定了：**推导只能在工具调用里发起**，不能在后台任务里。
与设计一致，推导本来就是用户主动触发的低频操作。

### 约束 3：必须处理非 `completed` 的结束原因

```ts
type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
```

`structured` 只在正常完成时可信。其他四种情况下必须降级，
不能把不完整的输出当作推导结果落库。

---

## 二之四、可直接照抄的调用清单

验证者在实测后给出的落地顺序，逐条核对过契约，直接作为实现依据：

```ts
// 1. 判空。requiresUndefinedCheck: true 意味着它可能缺席。
const subagents = ctx.get('subagents')
if (subagents === undefined) return degrade('SUPPORTED_BY_HOST: no')

// 2. 确认 provider 已注册。包条目 id 不等于注册名。
const providers = subagents.list()
if (providers.length === 0) return degrade('no provider registered')

// 3. 确认当前深度预算。maxDepth 是可配置的，可能为 1。
const maxDepth = subagents.resolveMaxDepth?.(undefined)   // number | undefined
if (maxDepth !== undefined && maxDepth <= 1) return degrade('depth exhausted')

// 4. 取 parent。只有工具执行期有 initiator。
const parent = ctx.get('agents')?.currentInitiator()
if (parent === undefined) return degrade('no initiator; cannot derive outside a tool call')

// 5. 发起。signal 必填。
const controller = new AbortController()
const activation = await subagents.startActivation({
  provider: providers[0],
  label: 'metacog-derivation',
  request: {
    prompt: [{ type: 'text', text: derivationPrompt }],
    parent,
    outputSchema: DerivationOutputSchema,
    cwd: projectRoot,
  },
  signal: controller.signal,
  delivery: 'caller',
})

// 6. 取结果。五种 stopReason 分别处理。
const result = await activation.result
if (result.stopReason !== 'completed') return degrade(`stopReason=${result.stopReason}`)
if (result.structured === undefined) return degrade('provider does not honour outputSchema')
const derived = DerivationOutputSchema.parse(result.structured)

// 7. 释放。
await activation.dispose()
```

补充说明：

- `SubagentCapabilities.outputSchema: boolean` 是**能力位**。不是每个 provider 都支持结构化，
  不支持时 `structured` 会缺席而只返回 prose。第 6 步的判空正是为此。
- `request` 的可选字段除 `cwd` 外还有 `agentPreset`、`agentOptions`、`maxDepth`。
  模型选择可交给 `agentOptions: { provider, model }`。
- 当前 profile 的 `subagent-model-selection-settings` 有 `allowedModels` 白名单，
  不在名单内的模型会被拒。实现时应记录实际使用的模型，便于排查。

---

## 三、设计影响

### 3.1 §4 保留，§8 降级作为兜底

设计文档 §4（LLM 推导）可按原计划实施。

但仍需保留 §8 降级路径，因为：

- `subagents` 是**可选**服务。某些部署（headless、精简 profile）可能不提供。
- `maxDepth` 可能被用户配置为 1，此时插件无法再派生。

因此：`ctx.get('subagents') === undefined` 时走降级 A（两段式），
并在日志中如实说明"本环境不支持自动推导"。

### 3.2 `projectContext` 已实现存储

按你的决定，已写入项目状态：

```ts
ProjectContextSchema = {
  role: string
  intent: string
  constraints: string[]
  stakeholders: string[]
  updatedAt?: string
}
```

`TreeState.projectContext` 持有它，store 提供：

- `readProjectContext(projectId)`
- `setProjectContext(projectId, context)`
- `initialize(..., { projectContext })` — 重新 init 时保留，除非显式覆盖

**不加版本号**：它描述项目所处的环境，不是树的组成部分。
改它不该产生快照，也不该让已确认节点失效。

实测四个场景全部通过：

```
1. init 时写入          → 保存成功
2. 读回                → 一致
3. 更新                → 覆盖成功
4. force 重新 init     → context 保留（不丢失）
```

### 3.3 `agents` 服务的用法

```ts
const agents = ctx.get('agents')
const parent = agents?.currentInitiator()
```

`currentInitiator()` 的语义（宿主原文）：

> Read the Agent that initiated the inherited asynchronous driver chain. Use this
> optional form for logging, tracing, metrics, or host attribution that also
> supports agentless calls.

关键限制：**它依赖异步调用链**。工具执行期间有 initiator；
定时器 tick、事件回调期间可能没有。

因此推导只能在**工具调用**里发起，不能在定时器里。
这与设计一致——推导本来就是用户触发的低频操作。

---

## 四、下一步

| 阶段 | 内容 | 前置 |
| :--- | :--- | :--- |
| 1 | 层级模型：枚举 → `depth: number`，迁移存量 | 无 |
| 2 | 枚举与分类：递归 + 四类判据 | 无 |
| 3 | 推导引擎：接 `subagents`，加四行探测日志 | 阶段 0 剩余项应在首次运行时确认 |
| 4 | 矛盾拒收规则 | 无 |
| 5 | 重做活动判定 | 依赖 1-3 |

阶段 3 首次运行时，需要观察并记录：

```ts
logger.info(`[dsh-metacog] subagents=${subagents ? 'present' : 'absent'} providers=${...}`)
logger.info(`[dsh-metacog] initiator=${parent?.id ?? 'none'}`)
logger.info(`[dsh-metacog] structured=${result.structured ? 'yes' : 'no'}`)
```

这三行日志能把上表"未实测"的四项一次性确认。
