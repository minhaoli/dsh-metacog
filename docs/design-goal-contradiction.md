# 目标与矛盾识别 — 设计文档

状态：待评审，未实现
范围：`goal_tree_init` / `goal_tree_confirm` / 矛盾推导
目标：一份在任何类型的项目上都能成立的通用设计

---

## 0. 设计原则

这份设计针对的是一个通用问题：**让插件在从未见过的项目上，推导出有意义的目标与矛盾。**

由此推出五条约束，后面所有机制都服务于它们。

### 0.1 不假设项目类型

科研、软件、咨询、写作、运营，它们的文档结构、目标形态、矛盾来源都不同。
任何写死“读 README 取一级标题”的实现都会在多数项目上失效。

因此：**分类规则必须可配置，推导交给模型，程序只负责枚举与校验。**

### 0.2 理解与执行分离

程序擅长：遍历文件、分类、校验 schema、维护版本、生成审计。
模型擅长：读懂材料、判断意图、发现张力、提出替代解读。

让程序做理解，只能产出“标题即目标”；让模型做版本控制，会破坏可审计性。
两者的边界必须清晰。

### 0.3 推导必须可追溯

每一条目标都要能回答“你凭什么这么认为”。
如果推导依据只是“文档里有个二级标题”，那不是推导，是转录。

因此：`derivation` 是一等字段，与 `evidence` 并列，且程序会检查它是否只是标题的复述。

### 0.4 空结果是合法结果

没有矛盾的项目是存在的。硬凑一条张力，比留空更糟——
后续所有漂移判断都会建立在这个假张力上。

因此：`noContradictionFound` 是显式合法输出，不触发任何警告。

### 0.5 把不确定性交还给用户

模型不确定的地方，不该猜，该问。
推导出两个都合理的根目标时，把两个都给出来，附上各自的理由。

因此：`alternative` 与 `openQuestions` 是输出的常规部分，不是异常路径。

---

## 1. 三个概念必须先分清

推导质量和这三个概念的清晰度直接相关。混淆任何一对，产出都会退化。

### 1.1 目标（Goal）

**想达成的状态。** 达成后有可验证的变化，且这个变化是某个主体想要的。

判断方法：能不能写出“达成时，世界哪里不一样了”。
写不出来，就不是目标。

常见误判：

| 误判 | 为什么不是目标 | 它是什么 |
| :--- | :--- | :--- |
| 完成 X 项目 | 这是容器，不是目的 | 项目名称 |
| 写一份报告 | 手段，报告可以为了很多目的 | 活动 |
| 使用 React 开发 | 技术选型 | 手段 |
| 数据采集 | 中间产物，除非采集本身就是交付 | 活动或子目标 |

### 1.2 矛盾（Contradiction）

**阻止目标达成的结构性张力。** 两个条件同时成立才算：

1. 它不会因为“再努力一点”消失——努力是沿着当前路径加速，而它卡在路径本身上
2. 缓解它必然付出另一边的代价——没有免费的解法，只有取舍

判断方法：能不能写出“如果不处理，哪个目标会先受阻，受阻的具体表现是什么”。
写不出来，就不是矛盾，是困难或待办。

常见误判：

| 误判 | 为什么不是矛盾 |
| :--- | :--- |
| 快速 vs 严谨 | 字面对立，无具体对象、无后果、无法判断是否缓解 |
| 时间不够 | 这是约束，只有与某个目标的冲突具体化后才成为矛盾 |
| 缺少人手 | 同上，是资源事实，不是张力 |

**约束与矛盾的区别**：
约束是环境事实（预算 30 万、截止 11 月、只有 3 个人）；
矛盾是约束与目标之间的冲突（预算 30 万 vs 需要 4 台设备 vs 目标是三种模态齐全）。

约束单独存在时不是矛盾，它可以只是背景。

### 1.3 活动（Activity）

**正在做的事。** 目标的下游，判定的对象。

它既不是目标也不是矛盾。把活动误当目标，会让目标树退化成 todo list；
把活动误当矛盾，会产出大量“我在忙”式的伪张力。

### 1.4 三者的关系

```
矛盾 ──阻碍──> 目标 <──推进── 活动
```

- 一条活动可以推进多个目标，也可以一个都不推进（那才是漂移）
- 一个矛盾可以阻碍多个目标
- 目标之间可以嵌套（低层目标是高层目标的手段）

---

## 2. 层级模型

### 2.1 现状的结构性问题

当前实现固定四层：

```ts
export const GoalLevelSchema = z.enum(['L0', 'L1', 'L2', 'L3'])
function levelRank(level) { return ['L0', 'L1', 'L2', 'L3'].indexOf(level) }
```

21 处代码依赖这个枚举。问题不在“四层够不够”，在于：

**层级深度是内容的属性，不是设计的常量。**

同一个项目，粗粒度看是两层，细粒度看可能是五层。强行固定层数，
要么逼用户合并（丢失信息），要么逼用户拆分（制造空节点）。

### 2.2 新模型

```ts
/** 0 为根，越大越接近可执行动作。不再有 L0-L3 的名称。 */
export type GoalDepth = number   // 整数，0..9

export interface GoalNode {
  id: string
  projectId: string
  parentId: string | null
  depth: GoalDepth

  title: string
  description: string

  /** 为什么认为这是目标：从哪些事实推出。区分于 evidence。 */
  derivation: string
  /** 支持它的具体凭据：文件路径、数据、对话记录、用户确认。 */
  evidence: string[]
  /** 若存在另一个合理解读，记在这里供用户选择。 */
  alternative?: string

  status: GoalStatus
  confirmedByUser: boolean
  successCriteria: string[]
  alignment: GoalAlignment

  createdAt: string
  updatedAt: string
}
```

### 2.3 父子约束从“相邻”改为“单调”

```ts
// 旧：必须恰好相邻一层
levelRank(parent) === levelRank(child) - 1

// 新：只需更深
child.depth > parent.depth
```

理由：真实推导经常跨层。用户完全可以直接从“让平台产生信息交换”
落到“设计问卷”，中间那层在他心里是隐含的。

强制要求相邻，会逼用户造中间节点凑数——那正是“为凑数量而虚构”的变种。

### 2.4 深度的语义约束（软性）

程序不强制，但推导 prompt 会要求模型遵守：

- `depth 0` 只能有一个：项目存在的理由
- 相邻深度的粒度差异应大致均匀，跳层需要在 `derivation` 里说明
- 没有子节点的目标，其 `successCriteria` 必须具体到可验证

### 2.5 迁移

从 `L0..L3` 映射到 `0..3`，无损。
已有数据用一次性迁移脚本处理，`version` 递增一次，写入一条审计。

---

## 3. 材料发现

推导质量的上限由材料决定。找不到材料，再强的模型也只能编。

### 3.1 通用难点

任何项目都可能有：

- 文档数量少但埋在深层目录
- 大量二进制数据与文档混杂
- 关键的意图记录不在 README 里，而在会议纪要、任务书、聊天记录中
- 存在多代文档，旧的已废弃但仍占目录

所以枚举必须是**全量遍历 + 分类**，不能是“找几个约定文件名”。

### 3.2 枚举阶段

```
walkWorkspace(root, {
  maxFiles: 20000,
  maxDepth: 12,
  excludeDirs: [...默认 + 用户配置]
})
```

只收集元信息：路径、扩展名、字节数、修改时间。不解析内容。

默认排除目录：版本控制、依赖、缓存、构建产物、本插件自己的存储目录。
用户可追加。

### 3.3 分类阶段

分类结果决定“模型该读什么”。四类：

| 类别 | 判据 | 给模型的建议 |
| :--- | :--- | :--- |
| `document` | 文档与富文本扩展名，体积在合理范围 | 优先读 |
| `result` | 位于输出/报告/评估类目录，或是命名含索引、报告、评估、检查的表格 | 必读，是矛盾的主要来源 |
| `code` | 源码扩展名 | 选读，用于理解在做什么 |
| `raw-data` | 其余数据文件，或体积超过阈值 | 不读，只报告数量与目录结构 |

判据本身是可配置的规则表，不是硬编码：

```ts
interface ClassificationRule {
  match: { ext?: string[]; dirPattern?: RegExp; namePattern?: RegExp; maxBytes?: number }
  category: 'document' | 'result' | 'code' | 'raw-data'
  priority: number
}
```

默认规则覆盖常见形态，用户可覆盖。

### 3.4 为什么区分 result 与 raw-data

这是本设计里最容易被忽略但影响最大的一条。

`raw-data` 只能证明“采集发生过”。
`result` 是判断的产物——检查报告、评估表、异常清单，每一行都是“这里有问题”。

因此 **result 类文件是矛盾识别的主要来源**，它记录了已经发现的张力。
而 raw-data 除了体量之外几乎不携带目标信息。

### 3.5 体积处理

超过阈值的文件不读全文：

- 表格类：读前若干行 + 列名
- 文本类：读前若干字节
- 结构化文件：读顶层结构，不展开

目标是从开头判断“这是什么”，不是读完全部内容。

### 3.6 输出给模型的形式

不传全文，传清单 + 摘要：

```
[document] path/to/file.md (10.6KB)
[document] path/to/spec.docx (245KB)
[result]   path/to/report.csv (10MB, 仅前 200 行)
[code]     path/to/script.py (102KB)
[raw-data] path/to/data/ — 34,382 个文件，.csv 为主，不看
```

模型的 `read` 能力会自己去取内容。

---

## 4. 推导引擎

### 4.1 能力前提

宿主提供子代理调用：

```ts
ctx.subagents.startActivation({
  provider, label,
  request: {
    prompt: ContentBlock[],
    parent: Agent,                  // ctx.agents.currentInitiator()
    outputSchema?: ObjectJsonSchema, // 结构化输出
    cwd?, agentOptions?
  },
  signal, delivery
})
```

这意味着插件可以让一个模型去读文件、判断、返回结构化结果。

此路径尚未在插件上下文中实测。若不通，见 §8 降级。

### 4.2 输入的三层

**第一层：用户背景（必填）**

```ts
userContext: {
  role: string              // 你在项目中的角色
  intent?: string           // 这个项目为什么存在，你要它达成什么
  constraints?: string[]    // 已知约束：时间、预算、人力、合规
  stakeholders?: string[]   // 谁会受结果影响
}
```

这一层**不可省略**，理由见 §4.4。

**第二层：材料清单**（§3.6 的分类结果）

**第三层：已有痕迹**

- 最近修改的 result 类文件
- 若存在项目级说明文件，优先
- 版本历史（如有）

### 4.3 输出 schema

```ts
DerivationOutput = {
  evidenceManifest: [{
    path: string
    category: 'document' | 'result' | 'code'
    why: string          // 为什么读它
    useful: boolean      // 读完后是否有用
  }],

  goals: [{
    tempId: string
    parentTempId: string | null
    depth: number
    title: string
    description: string
    derivation: string        // 必须引用具体事实，不能复述标题
    evidence: string[]
    successCriteria: string[]
    confidence: number        // 0..1
    alternative?: string      // 另一个合理解读
  }],

  contradictions: [{
    tempId: string
    title: string
    poleA: string
    poleB: string
    constraintKind: 'rule-decay' | 'resource' | 'budget' | 'deadline'
                  | 'technical' | 'people' | 'information' | 'unknown'
    blocksGoalTempIds: string[]
    consequence: string       // 不解决会怎样，必须具体
    evidence: string[]
    confidence: number
    mitigationHint?: string
  }],

  noContradictionFound: boolean,
  openQuestions: string[]
}
```

### 4.4 为什么用户背景不能省

这是整份设计里最关键的一条，值得单独说明。

设想一个项目：文件里全是“调查用户对某功能的看法”的问卷、访谈记录、数据表。
从这些材料能推导出什么？

- 直接推导：目标是“完成这次调查” → 这是活动，不是目标
- 稍微推导：目标是“理解用户对该功能的看法” → 仍然是手段

真实的目标可能是“决定该功能是否上线”，或“避免上线后用户流失”，
或“让老板接受研究结论”。

**这些都不在材料里。** 它需要知道：研究者是谁、委托方要什么、
结果会被谁用来做什么决定。

没有这一层，模型只能照抄材料，推导就退化成转录。
这正是现有实现失效的机制——区别只在于现有实现连材料都没读。

因此：`goal_tree_init` 若不提供 `userContext`，返回明确警告并降级，
而不是默默产出一份“标题即目标”的树。

### 4.5 提示词骨架

```
你在为一个项目推导目标层级与结构性矛盾。

【三个概念，先分清】
目标：想达成的状态。达成时有可验证的变化。
矛盾：阻止目标达成的结构性张力。两个条件同时成立：
      (a) 不是努力一点就能消失；(b) 缓解它必须付出另一边的代价。
活动：正在做的事，不是目标。

【已知背景】
角色：{role}
意图：{intent}
约束：{constraints}
相关方：{stakeholders}

【材料清单】
{manifest}
document 与 result 类优先读。raw-data 不含目标信息，不要读。

【任务】
1. 先读 3-8 个最可能包含项目意图的文件。记录读了什么、为什么。
2. 推导目标层级：
   - 根目标是项目存在的理由，不是项目名称。
   - 若一个目标只是另一个的实现手段，它应更深一层。
   - 层级深度由内容决定。不要为凑层数拆分，也不要为省事合并。
   - 每个目标的 derivation 必须引用具体事实。
     如果只能写“文档里有个标题”，说明你在转录，请重新考虑。
3. 识别矛盾，来源必须是具体约束：
   规则失效、资源不足、时间压力、技术限制、人员冲突、信息缺失。
   - 每条矛盾必须写明：阻碍哪个目标、不解决的具体后果。
   - 不要用“A vs B”式的字面对立充数。
   - 若确实没有结构性矛盾，返回 noContradictionFound: true，这是合法结果。
4. 存在多个合理解读时，写进 alternative 与 openQuestions，交给用户判断。
```

### 4.6 程序侧的质检

模型输出不能直接采纳。三道检查：

**检查一：推导是否只是复述**

```
若 derivation 与 title 的编辑距离 < 阈值的 30%，
或 derivation 不含任何 evidence 中出现的标识（路径片段、术语），
→ 标记 LIKELY_TRANSCRIPTION，置信度封顶 0.4
```

**检查二：矛盾是否泛泛**

见 §6.2 的拒收规则。

**检查三：结构是否自洽**

- 深度单调
- 每个非根节点有 parent
- 矛盾至少绑定一个目标
- 每个节点至少一条 evidence

不通过的项不丢弃，降级到 `openQuestions` 或标 `low-confidence`，
在确认界面单独呈现。

---

## 5. 与用户确认

### 5.1 原则

确认不是“从清单里挑”，而是**把推导过程摊开让人判断**。

用户需要看到：我读了什么、跳过了什么、凭什么这么推、哪里不确定。

### 5.2 呈现形式

```markdown
## 我读了
- path/a.md — {why}
- path/b.csv（前 200 行）— 记录了 N 条异常

跳过了：{目录}（{原因，如：纯原始数据 / 体积过大 / 已废弃}）

## 根目标
{推导出的根目标}
  依据：{derivation}
  备选：{alternative}
  置信度：{confidence}
  → 请选择或给出第三个

## 层级（共 N 条，最大深度 D）
{缩进树，每个节点附一行 derivation 摘要}

## 矛盾
{[kind] {title}}
  阻碍：{目标}
  不解决的后果：{consequence}
  依据：{evidence}
  ...
（若为空：未发现结构性矛盾。这是常见结果，不影响后续监控。）

## 需要你确认
- {openQuestions}
```

### 5.3 确认接口

```ts
goal_tree_confirm({
  expectedVersion: 0,
  rootChoice: 'derived' | 'alternative' | 'custom',
  customRoot?: { title, description, derivation },
  adopt: string[],                       // 采纳的 tempId
  edits: [{ tempId, title?, depth?, successCriteria?, alignment? }],
  drop: string[],
  contradictionDecisions: [{
    tempId,
    action: 'accept' | 'reject' | 'reclassify',
    type?: 'core' | 'main' | 'secondary',
  }],
  answers: Record<string, string>,       // 回答 openQuestions
  reason: string,
})
```

### 5.4 用户背景的存储

`userContext` 是稳定信息，不该每次重填。

设计：首次调用时写入项目状态 `projectContext`，后续可覆盖：

```ts
projectContext: {
  role: string
  intent?: string
  constraints: string[]
  stakeholders: string[]
  updatedAt: string
}
```

`goal_tree_init` 的 `userContext` 参数可选：不传则用已存的，都没有则警告降级。

---

## 6. 矛盾识别

### 6.1 来源分类

按可靠性从高到低。前四类模型能从材料中读到，第五类需要简单推演。

| # | 来源 | 材料特征 | 约束类型 |
| :--- | :--- | :--- | :--- |
| 1 | 文档明述的冲突 | 「待确认」「需复核」「已知问题」等段落 | 任意 |
| 2 | result 文件中的异常 | 检查报告、评估表的问题列 | technical / information |
| 3 | 用户背景中的约束与目标的冲突 | constraints 与实际范围对比 | deadline / budget / people |
| 4 | 材料间的相互矛盾 | 两份文档对同一规则的不同表述 | rule-decay |
| 5 | 数量关系失衡 | 规模 vs 产能、时长 vs 样本量 | resource |

**规则失效（rule-decay）值得单列**：项目演进中经常出现“规则还在、
适用条件已经变了”的情况——旧编号体系配新命名、旧流程配新设备。
这类矛盾最隐蔽，也最容易被忽略，但一旦存在会影响所有下游判断。

### 6.2 拒收规则

程序校验，不通过的不是丢弃，而是降级为 `openQuestions`：

```ts
function rejectReason(c): string | undefined {
  if (!c.evidence.length)                    return 'EVIDENCE_REQUIRED'
  if (c.consequence.trim().length < 15)      return 'CONSEQUENCE_TOO_VAGUE'
  if (!c.blocksGoalTempIds.length)           return 'MUST_BLOCK_A_GOAL'
  if (isGenericTradeoff(c.poleA, c.poleB))   return 'GENERIC_TRADEOFF'
  return undefined
}

/** 字面对立、无具体对象的组合 */
const GENERIC_PAIRS = [
  ['速度','质量'], ['快速','严谨'], ['效率','完整'], ['灵活','规范'],
  ['简单','完备'], ['短期','长期'], ['理想','现实'], ['理论','实践'],
  ['创新','稳定'], ['自由','约束'],
]
```

降级文案示例：
「我怀疑存在 X 与 Y 的张力，但说不出具体后果。你要考虑吗？」

### 6.3 允许没有矛盾

`noContradictionFound: true` 时不报警告，`goal_tree_confirm` 正常通过。

理由：小项目、早期探索、单一目标的项目本来就可能没有结构性张力。
强行产出会让后续所有漂移判断建立在一个假张力上，污染整条链。

### 6.4 矛盾的动态性

矛盾不是静态字段。同一项目在不同阶段，主要矛盾会迁移——这正是
`contradiction_shift` 信号要捕捉的。

因此矛盾节点需要：

- `constraintKind`：便于统计「哪类约束最常见」
- `observedAt` 与观察流：强度随时间变化（已有设计）
- `blocksGoalTempIds`：目标变了要重新评估它是否还成立

---

## 7. 验收标准

不看“是否报错”，看判断质量。

### 7.1 通用检查（任何项目）

| 检查项 | 期望 |
| :--- | :--- |
| document 类文件枚举率 | 覆盖全部非排除目录 |
| raw-data 是否被排除在阅读之外 | 是 |
| result 类文件是否被读 | 至少一个 |
| 根目标是否有 derivation 且非标题复述 | 是 |
| 是否给出至少一个 alternative 或 openQuestion | 是 |
| 泛泛对立是否被拦截 | 是 |
| 空结果是否被正确表达 | 是 |

### 7.2 反例测试（防止退化到“标题即目标”）

| 场景 | 期望行为 |
| :--- | :--- |
| 空目录 | 空候选 + 明确警告，不伪造 |
| 只有一个 README 的小项目 | 1 个根目标，矛盾可为 0 |
| 材料中明确「无结构性矛盾」 | `noContradictionFound: true` |
| 全部是技术手册（无项目意图） | 根目标 confidence < 0.5，进不确定区 |
| 模型返回 8 条泛泛矛盾 | 全部被拒收规则拦下 |
| 未提供 userContext | 明确警告，不静默产出 |
| 文档有两个互相矛盾的说法 | 识别为 rule-decay 类矛盾 |

### 7.3 质量指标

不追求“候选数量多”，追求：

- **根目标的 derivation 引用率**：100% 应引用具体证据
- **泛泛矛盾拦截率**：GENERIC_PAIRS 命中应为 0 采纳
- **用户修改率**：首次推导后用户大幅改写，说明推导质量不足
- **空结果正确率**：该为空时是否为空

最后一项尤其重要——一个总是能“发现”矛盾的系统，通常是错的。

---

## 8. 降级路径

### 8.1 若子代理不可用

**降级 A：两段式**

`goal_tree_init` 不自己调模型，返回给模型的指令：

```
请读下列文件后调用 goal_tree_propose 提交推导：
- document: {清单}
- result: {清单}
跳过 raw-data。
```

当前会话的模型自己读、自己判断、调 `goal_tree_propose`。
后者只做 schema 校验与落库。

优点：不依赖 subagents。
缺点：多一次往返；模型偷懒（只读一个文件）时程序无法强制。

**降级 B：只做材料整理**

完全不推断，产出：

```json
{
  "evidenceManifest": [...],
  "note": "本插件未配置模型推导能力，只提供材料清单。目标需你手动填写。"
}
```

这是诚实的下限。比现在“标题即目标”好，因为它不假装理解。

### 8.2 若无 userContext

明确警告，并把所有目标的 confidence 封顶 0.5，
在确认界面的“不确定”区呈现，而不是混在正常候选里。

---

## 9. 实施顺序

| 阶段 | 内容 | 独立可验证 | 状态 |
| :--- | :--- | :--- | :--- |
| 0 | 实测 `ctx.subagents` 在插件中可用 | 最小脚本能否拿到结构化输出 | 已完成 |
| 1 | 层级模型：枚举改 number，迁移存量 | 回归现有测试 | 已完成，见 `stage-1-depth.md` |
| 2 | 枚举与分类：递归遍历 + 四类判据 | 在任意项目上跑，检查分类结果 | 已完成 |
| 3 | 推导引擎 + 确认界面 | 检查推导说明是否可读、derivation 是否可追溯 | 已完成 |
| 4 | 矛盾拒收规则 | 反例测试 | 已完成 |
| 5 | 重做活动判定（依赖目标质量） | 误报率对比 | 未开始 |

阶段 0 决定架构走向，必须先做。

---

## 10. 未决问题

1. **`ctx.subagents` 在插件上下文中是否可用** — 未实测，决定 §4 与 §8 的取舍
2. **成本**：每次推导的 token 消耗；是否需要缓存、增量更新
3. **增量推导**：文档变化后是否重推？现在是 `force` 全量重建
4. **多项目复用**：同一用户不同项目的 `projectContext` 是否共享部分字段
5. **置信度语义**：0.5 这个线放在哪里、如何被下游使用（目前只用于过滤）
6. **矛盾的时效**：一个矛盾在多长时间内未被任何证据提到，可视为已消解

第 1 条阻塞后续全部工作。
