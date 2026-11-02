# Stage D：历史观察流、去重、漂移分析与干预状态机

验证结果：`node test/stage-d.test.mjs` → 108 passed, 0 failed。回归 A/B/C 全绿（40 / 64 / 78）。

## 新增模块

| 文件 | 职责 |
| :--- | :--- |
| `src/analysis/trend.ts` | 窗口内趋势计算，阈值不对称，样本不足即 unknown |
| `src/analysis/alignment.ts` | `alignment` 规则的五步判定，含白名单、探索策略、excluded |
| `src/analysis/drift.ts` | 四类漂移检测器 + `dominantContradiction` |
| `src/analysis/escalation.ts` | Level 0–3 状态机、建议动作、提示行渲染 |
| `src/analysis/service.ts` | 编排：去重 → 判定 → 落盘 → 检测 → 升级 → 干预 |
| `src/tools/drift.ts` | `check_drift`、`contradiction_observe`、`resolve_intervention` |

`src/data/store.ts` 新增 `appendStandaloneAudit()`：非结构性事件（`resolve_intervention`）写审计但不消耗版本号，`beforeVersion === afterVersion`，哈希链照常延伸。

## 关键设计决定

### 趋势必须由历史流计算，节点字段永不写入

`ContradictionNode.trend` 在 Stage C 已被 `ContradictionPatch` 类型从编译期排除。Stage D 进一步确认：`contradiction_observe` 只追加 `ContradictionObservation`，节点字段保持原值。测试 D3 显式断言观察五条强度下降记录后，`goal_tree_view` 里节点的 `trend` 仍是 `unknown`。

`computedTrend` 记录的是「导致这条观察的历史」的趋势，`trendNow` 是「含本条之后」的趋势，两者都返回，便于审计。

### 样本不足不下结论

`MIN_TREND_POINTS = 3`。两条相邻观察在 5 点量表上不构成方向，此时返回 `unknown` 而不是 `stable`——把噪声洗成结论是监控插件最典型的失效方式。

判定条件同时要求净变化（≥1 点）与最小二乘斜率（|slope| > 0.2），所以一次尖峰夹在平坦序列里仍是 `stable`。

### 判定顺序与 `successCriteria` 的边界

`judgeAlignment` 严格按 spec 4.2 的顺序：等级闸门 → 白名单 → 已登记探索 → 显式排除 → 兜底。

`successCriteria` 只作为「关联目标」的弱信号（填 `candidateGoalIds`、在规则命中时提高置信度），从不单独决定 `scope_drift`。理由写在 `alignment.ts` 的模块注释里：日常依赖排查很少读起来像完成标准，把它当越界标尺正是误报的来源。

短模式防护：长度 ≤2 的模式（中文里极常见）要求整词匹配而非子串匹配，否则「读」会命中一切。

### 等级闸门

Grade C 直接返回 `uncertain`（置信度 0），`mayEscalate` 为 false；Grade B 置信度封顶在 `observationPolicy.gradeBMaxConfidence`（默认 0.5，低于 `minConfidence` 0.6），因此结构上无法触发 Level 2/3。Grade A 缺 evidence 直接拒绝（`GRADE_EVIDENCE_REQUIRED`）。

### 升级阶梯的幂等性

「无同类 pending 干预」是 Level 2/3 的前置条件。卡片一旦打开，后续同类信号降级为 Level 1 记录，不再叠卡（测试 D13 断言第 4 次信号不产生第二张卡片）。

Level 3 需要 `core_bypass` **自身**重复达到 `repeatThreshold`，且矛盾强度 ≥4，且无 pending。测试 D17 用 6 轮规避活动验证升级路径，同时验证「高强度但正在处理该张力」不构成 bypass——两个条件缺一不可。

### 静态检查不伪造活动

`check_drift` 不带 `activity` 时走 `runStaticCheck`：只跑 staleness、pressure、可选的 shift 探测，`mayEscalate: false`（没有 Grade A 证据），且不写任何 `ActivityRecord`。写入幻影活动会污染报告所依赖的漂移统计。

### 干预决议与审计

`resolve_intervention` 要求 `rationale`（缺失即 `REASON_REQUIRED`），写入 `InterventionRecord` 的新版本，并追加一条 `resolve_intervention` 审计记录。决议不修改树、不碰 trend，测试 D14 逐项断言版本号、L0 标题、矛盾 trend 均未变，且审计链仍校验通过。同类的其他 pending 卡片会被置为 `superseded`，避免陈旧卡片把 Level 3 门控一直挂着。

## 验收用例对照

| 编号 | 覆盖测试 | 结果 |
| :--- | :--- | :--- |
| T02 | D6 | 通过 |
| T03 | D7, D8 | 通过 |
| T04 | D9 | 通过 |
| T05 | D11, D12 | 通过 |
| T06 | D13 | 通过 |
| T07 | D3, D4, D14 | 通过 |

T08 的 L0/core 保护已在 Stage C 完成，D14 补充验证「否决 Level 2 建议后 L0 不变」。

## 已知边界

- `core_bypass` 的「活动持续集中在无关分支」判定依赖 `candidateGoalIds`。活动来自手动上报或工具事件时，该字段由判定器或调用方填充；若调用方显式给出 `candidateGoalIds`，判定器会原样采用（用于审计），但检测器仍按真实判定结果分类。
- `contradiction_shift` 需要调用方提供 `blockerHint`——插件无法自行发现新瓶颈，只能校验该瓶颈是否已被现有 main 节点覆盖。这是 spec 允许的模型提出候选、程序校验的分工。
- `repeated_failure_loop` 未实现（spec 明确列为第一版预留）。
