# Stage G：周期报告与动态 systemPrompt 注入

验证结果：`node test/stage-g.test.mjs` → 61 passed, 0 failed。
最终验收：`node test/acceptance.test.mjs` → T01–T10 全部通过。

## 核验结论

`ctx.systemPrompt.section(PromptSection)` 返回 disposer；`PromptSection.text` 可以是 `(ctx: AssembleContext) => string`，每轮求值。

两个关键约束：

- `order` 是**必填**（不是可选）。`PromptSection` 和 `PromptContext` 都要求它。
- `AssembleContext` 只有 `scope` 和 `signal`，**没有 agent**。这一点决定了实现方式：prompt 段无法从装配上下文里解析出「当前是哪个项目」。

## 报告实现

`src/report.ts`，`generateReport(input)` 产出 `GeneratedReport` 并落盘。

### 叙事轴固定，不写流水账

三节对应 spec 5 的问题：目标进展（哪些 goal 本周期有带证据的对齐记录）、矛盾演化（main/core 的强度序列与箭头）、漂移与干预（L2/3 信号与已决议卡片）。

日报额外给「明日唯一优先项」，一句话，指名当前 dominant 矛盾。

### 没有证据就不出现

`goalProgressLine` 要求 `evidence.length > 0` 才计入。本周期无证据时，该节直接写「本期无可验证证据的活动」，而不是拿零记录凑一行。

### 日报长度是硬约束

spec 5.1 要求 300 字以内。第一版实现 405 字，超了。压缩手段：每节只留必要信息、证据最多列 2 条、措辞改中文（信息密度更高）。现在 235 字。

这是**按规格收紧实现**，不是放宽测试。

### 版本绑定

`goalTreeVersion` 记录生成时读到的 `state.version`，对应的 `TreeSnapshot` 一直在 `snapshots/<projectId>/<version>.json`。测试 G6 生成报告后把树改到 version 2，回查报告仍是 version 1，且 `readSnapshot(projectId, 1)` 仍可读、不含后来新增的节点。

为此给 store 加了只读的 `listSnapshots(projectId)`。

### 引用的 id 必须真实存在

`observationIds` / `signalIds` / `interventionIds` 全部来自本次实际读取的流，测试 G7 逐项回查 store 确认存在。

## systemPrompt 注入

注册单个 section（`name: 'dsh-metacog'`, `order: 900`），内容由 `renderPromptBlock` 生成：

1. core 与 main 的判定准则（两行）
2. 置信度下限（引用当前配置值）
3. 当前 active 的 L0/L1 摘要（L1 只列标题与状态）
4. core / main 矛盾各一行
5. Level 1 提示与 pending 干预提醒（各最多 2 条）

### 为什么用缓存而不是每次解析

`AssembleContext` 不含 agent，装配时无法知道项目。所以 section 的 `text` 从挂载内缓存渲染，缓存由最近一次记录刷新。

装配是同步契约，不能在 `text` 里做文件 I/O。实现方式是：本次返回缓存值，同时 `void refreshPromptCache()` 为下一轮准备。一轮的滞后对监控而言可接受，阻塞装配则不可接受。

卸载时清空缓存，避免已释放的上下文渲染陈旧树。

### token 控制

测试断言 `< 1200` 字符，且不含未展开的深层节点（G11 断言「Write the trend calculator」这个 L2 不出现）。全量树注入会让插件每轮成本过高，用户会直接关掉它。

## T08 暴露的一个真实守卫漏洞

验收测试 T08 最初写错参数名（`upsertGoals` 而非 `updates`），结果**修改被静默忽略，返回 ok**。这暴露了一个比测试错误更严重的问题：程序不校验参数名。

宿主会按 `parameters` 校验，但依赖宿主不如自己把关。现在 `defineMetacogTool` 增加 `assertKnownArguments`：出现未声明的键直接抛 `UNKNOWN_ARGUMENT` 并列出接受的参数名。

这个改动立刻在 Stage E/F/G 测试里抓出一批同样的错误（多个 fixture 给 `goal_tree_confirm` 传了不存在的顶层 `evidence`）。

## 另一个 Stage C 遗留 bug

`goal_tree_confirm` 只读扁平的 `item.relevantActivities`，而规格与测试都用嵌套的 `alignment: { relevantActivities, ... }`。结果 alignment 规则被静默丢弃，存进去的全是空数组 + `explorationPolicy: 'limited'`。

后果很隐蔽：所有「已登记探索」的活动都被判成 `scope_drift`。Stage D 的测试用了扁平写法，所以没暴露。

修法：`L1Acceptance` 增加嵌套 `alignment` 字段，读取时嵌套优先、扁平回退，`explorationPolicy` 一并映射；参数 schema 也改成嵌套结构（保留扁平写法兼容）。

## 测试覆盖

| 用例 | 覆盖 | 结果 |
| :--- | :--- | :--- |
| G1 | 日报四节齐全 | 通过 |
| G2 | 只列有证据的目标 | 通过 |
| G3 | 日报正文 < 300 字 | 通过 |
| G4 | 周报含结构变更与分布 | 通过 |
| G5 | 月报含存活率、core 管理、重复漂移 | 通过 |
| G6 | 报告绑定旧版本快照 | 通过 |
| G7 | 引用的 id 全部存在 | 通过 |
| G8 | 非法报告类型被拒绝 | 通过 |
| G9 | 未初始化项目被拒绝 | 通过 |
| G10 | section 带必填 order，text 为函数 | 通过 |
| G11 | prompt 块含准则、L0/L1、不泄漏全量树 | 通过 |
| G12 | pending 决策出现在 prompt | 通过 |
| G13 | 无项目时如实渲染 | 通过 |
| G14 | 宿主无 systemPrompt 仍能挂载 | 通过 |
| G15 | 卸载移除 section | 通过 |
