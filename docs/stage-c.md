# Stage C 阶段记录：初始化、确认与受控编辑

## 实现范围

| 模块 | 职责 |
| :--- | :--- |
| `src/evidence/scanner.ts` | 从 README / docs / manifest / git log 提取候选节点，每个候选附真实路径证据 |
| `src/governance.ts` | 结构变更门控、树形不变量校验、变更集计算 |
| `src/tools/shared.ts` | 工具环境、projectId 派生、错误映射、统一 envelope |
| `src/tools/tree-lifecycle.ts` | `goal_tree_init` / `goal_tree_confirm` / `goal_tree_view` |
| `src/tools/tree-edit.ts` | `goal_tree_edit` / `contradiction_tree_edit` |
| `src/index.ts` | 五个工具经 `mount.claim(tools.register(...))` 注册 |

## 关键设计决策

### 扫描器不猜分类

矛盾候选只从含对比标记（`vs` / `versus` / "X 与 Y 的张力"）的句子提取，且只标 `unclassified`。原因：扫描器无法知道某个张力约束哪个目标，猜 `core` 等于伪造结构性诊断。候选以 `contradiction-candidate-N` 返回，`primaryGoalId` 在确认时由用户补充。

同理，L1 候选数完全由文档 H2 章节数决定。测试 fixture 恰好 4 个章节就产出 4 个候选，不padding 到"建议 2–5 个"。

### 确认路径与编辑路径的门控差异

`goal_tree_confirm` 写的是 version 0 草稿 → version 1，草稿的 L0 尚未 `confirmedByUser`，因此 `assertStructuralGate` 不拦。门控只看 *已确认* 的 L0/core：对草稿也要求二次确认会让 init 无法使用。

`goal_tree_edit` / `contradiction_tree_edit` 额外要求 `current.confirmed === true`，未确认树直接返回 `NOT_CONFIRMED`。原因：草稿的形态由 confirm 决定，两条路径同时能改会让 CAS 语义含混。

### trend 无法被工具写入

`ContradictionPatch` 与 `ContradictionCreate` 都没有 `trend` 字段，`applyContradictionPatch` 只在新节点创建时硬编码 `trend: 'unknown'`。这是 spec 0.4 第 2 条的编译期保证，不依赖运行时检查。`intensity` 保留在 patch 中（供证据充分时修正），但说明文字要求证据支撑。

### 编辑后矛盾链接完整性

`goal_tree_edit` 删除目标前检查所有矛盾链接：若某矛盾的 `primaryGoalId` 或 `relatedGoalIds` 会指向不存在的目标，返回 `CONTRADICTION_LINK_BROKEN` 并列出矛盾 id。否则存储层会静默持久化悬空引用。

## 测试结果

`node test/stage-c.test.mjs` → **78 passed, 0 failed**

| 用例 | 覆盖点 |
| :--- | :--- |
| C1 | 候选来自真实证据、草稿态、不凑数、每节点带证据 |
| C2 | 确认为 version 1、创世审计、跨目标关联 |
| C3 | `EVIDENCE_REQUIRED` / `L0_REQUIRED` / `UNKNOWN_GOAL_REF` / `CORE_RATIONALE_REQUIRED` |
| C4 | 层级相邻、父节点存在、唯一 L0 |
| C5 | L0 需 `userConfirmed: true` + reason；拒绝后版本与内容均不变 |
| C6 | core 修改与重分类均需确认；审计动作 `reclassify_contradiction` |
| C7 | L1 变更需 reason，返回待重评估矛盾 |
| C8 | 新增 L2、删除叶子、拒绝删除非叶子 |
| C9 | 过期 `expectedVersion` → `VERSION_CONFLICT` 且无副作用；未确认树禁编辑 |
| C10 | 已确认项目拒绝重新初始化；跨项目隔离 |
| C11 | `primaryGoalId` 存在性、`related` 与 `primary` 不交、新节点 `trend=unknown` / `intensity=null` |
| C12 | 删除被矛盾引用的目标被拒绝 |

回归：Stage A 40/40、Stage B 64/64 仍通过。

## 对 Stage A 测试桩的修改

`test/stage-a.test.mjs` 的默认 capabilities 加入 `tools`。`inject=['tools']` 是硬依赖，缺注册表时插件按设计抛错拒绝挂载；因此"默认可加载的宿主"必然含 `tools`，而 `systemPrompt` / `timer` / `fs` / `workingDirectory` 仍是可选能力。
