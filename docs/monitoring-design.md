# 自适应元认知监控：可落地方案

版本 3。在版本 2 基础上修正六处：覆盖度分母、真实标签 schema、`verified_progress` 的误用、损失矩阵使干预动作不可选、`RiskOutput` 类型契约、里程碑 B 缺一个校准器。

架构不变：五层前向链、目标对齐与行为双轨、缺失值三态、分层审计、分级干预。本版只修统计契约与类型契约。

一句话概括：在标签积累到足以校准之前，系统提供的是可检查的分数，不是概率。任何依赖「这是概率」的下游逻辑，在类型层面就拿不到值。

---

## 零点五、三版方案的演进

| 问题 | 版本 1 | 版本 2 | 本版 |
| :--- | :--- | :--- | :--- |
| 连续特征套朴素贝叶斯 | 有 | 已改透明加权 | — |
| `1 - max s` 当漂移概率 | 有 | 已拆三个量 | — |
| 三种标签融合 | 有 | 已拆两接口 | 再拆：真值 vs 告警结果 |
| Thompson sampling 误用 | 有 | 已改 VOI | — |
| 未校准分数叫 `p` | — | 已改 `riskScore` | 类型契约统一为嵌套 `calibration` |
| 逆概率加权估错量 | — | 已拆三个指标 | — |
| Beta 语义模糊 | — | 只学 `precision_r` | 再拆：规则精度 vs 总体误报率 |
| VOI 缺损失矩阵 | — | 已补 | 损失矩阵结构重写 |
| **覆盖度惩罚不适用特征** | — | 有 | 分母改为 A/(A∪M) |
| **`false_alarm` 混淆真值与告警** | — | 有 | 改 `ActivityGroundTruth` |
| **`verified_progress` 降低偏离风险** | — | 有 | 拆出 `goal_linked_progress` |
| **损失矩阵使 card/block 永不可选** | — | 有 | 拆 `C_action` + `C_residual`，动作集随场景变化 |
| **`CalibratedRisk` 丢失判据信息** | — | 有 | 嵌套进 `scored` 分支 |
| **B 阶段只有复核器校准，缺 riskScore 校准** | — | 有 | 两个独立校准器 |

---

## 一、统计契约（开工前冻结）

这一节定下后，里程碑 A 期间不允许改动。

### 1.1 唯一的 RiskOutput 定义

```ts
type UndecidableReason =
  | 'criteria_missing'     // 目标没有可匹配的判据
  | 'no_goals'             // 树上没有活跃目标
  | 'insufficient_coverage' // 有适用特征，但可用比例太低
  | 'no_applicable_features' // 这个项目没有任何适用的特征

type RiskOutput =
  | {
      status: 'scored'
      verdict: 'drift' | 'aligned' | 'uncertain'
      riskScore: number      // 0-1，只保证序关系
      coverage: number       // 0-1，见 1.3
      reasons: string[]      // 命中了哪些判据
      calibration:
        | { status: 'uncalibrated' }
        | {
            status: 'calibrated'
            pDrift: number
            calibrationVersion: string
          }
    }
  | { status: 'undecidable'; reason: UndecidableReason }
```

要点：

- `pDrift` 只存在于 `calibration.status === 'calibrated'` 分支内。里程碑 A 期间这个分支不可达。
- 概率不会替换分数，而是附加在分数之上。调用方在 B 之后仍然能看到 `riskScore`、`coverage` 与 `reasons`，知道这个概率对应哪次判断。
- `UndecidableReason` 只有一份定义，不再在别处列举。

### 1.2 特征值三态

```ts
type FeatureValue =
  | { state: 'available'; value: number }        // value ∈ [0,1]
  | { state: 'not_applicable'; reason: string }  // 该项目没有这类结构
  | { state: 'missing'; reason: string }         // 适用但取不到
```

`not_applicable` 与 `missing` 的区分标准：

| 状态 | 判据 | 例子 |
| :--- | :--- | :--- |
| `not_applicable` | 这个概念对该项目类型不成立 | 纯文档项目没有依赖图 |
| `missing` | 概念成立，但当前取不到 | 有代码但依赖图构建失败；有嵌入需求但本机没装模型 |

缺嵌入模型属于 `missing`，不是 `not_applicable`。语义相似度对任何项目都成立，只是这台机器算不了。

### 1.3 覆盖度：分母只算适用特征

设：

- `A` = available 的特征集合
- `M` = missing 的特征集合
- `N` = not_applicable 的特征集合

```
score(a,g)  = Σ_{k∈A} w_k · x_k / Σ_{k∈A} w_k
coverage    = Σ_{k∈A} w_k / Σ_{k∈A∪M} w_k
```

`N` 不进分母。不适用于该项目的特征既不贡献分数，也不拉低覆盖度。

退化情况：

- `A ∪ M = ∅`（全部 not_applicable）→ `undecidable: no_applicable_features`
- `A = ∅` 但 `M ≠ ∅` → `undecidable: insufficient_coverage`
- `coverage < θ_coverage`（默认 0.4）→ `undecidable: insufficient_coverage`

分数与覆盖度都只依赖单个 (活动, 目标) 对，与树上还有什么别的目标无关。

### 1.4 三个不同的误报指标

给定阈值 θ、真实标签 `y_i ∈ {0,1}`、抽中概率 `π_i`、监控窗口 `T` 天：

```
FP_i(θ) = 1[riskScore_i ≥ θ] · 1[y_i = 0]

误报总数    N̂_FP(θ) = Σ_{i∈S} FP_i(θ) / π_i
每日误报率  λ̂_FP(θ) = N̂_FP(θ) / T               ← 与预算 B 同量纲
FPR(θ)              = N̂_FP(θ) / N̂_{y=0}         ← 分母是全体非漂移估计
告警误报比例        = N̂_FP(θ) / N̂_alarm(θ)      ← 等于 1 − precision
```

用户设的预算是「每天最多几次错误打扰」，所以阈值公式只允许用 `λ̂_FP`。

### 1.5 标签：真值与告警结果分开

原来的 `false_alarm` 不是活动的真实类别。一次随机审计发现某条低风险活动其实是合理对齐的，它是一个真实负例，不是一次误报——系统当时根本没报警。

```ts
interface ActivityGroundTruth {
  activityId: string
  label: 'drift' | 'aligned' | 'uncertain'
  source: 'user' | 'verified_outcome' | 'model_review'
  /** 实测可靠度，由校准流程给出；未校准时为 null */
  reliability: number | null
  /** 该活动被抽中审计的概率，用于逆概率加权 */
  inclusionProbability?: number
  evidenceIds: string[]
}
```

| 标签值 | 含义 |
| :--- | :--- |
| `drift` | 活动确实偏离了目标结构 |
| `aligned` | 活动合理对齐，或属于已确认的合理探索 |
| `uncertain` | 无法建立可靠结论 |

TP / FP / FN / TN 由 `label` 与「系统当时是否告警」两个变量派生，不直接存储：

```
告警 且 label=drift    → TP
告警 且 label=aligned  → FP
未告警 且 label=drift  → FN
未告警 且 label=aligned → TN
```

干预决策单独存，不与真值混用：

```ts
interface InterventionDecision {
  signalId: string
  activityId?: string
  action: 'continue' | 'realign' | 'modify_goals' | 'dismiss'
  rationale?: string
}
```

`realign` 与 `dismiss` 不自动生成 `ActivityGroundTruth`。若确需低成本利用，只能作为弱监督单独记录（`source: 'weak_inference'`），且**不进入误报率估计与概率校准数据集**。`continue` 与 `modify_goals` 一律不推断。

### 1.6 损失矩阵：动作成本与残留损失分开

版本 2 的矩阵有个数学错误：`L_hint = 0.2(1-p)` 在任意 `p<1` 时都小于 `L_card = 1.5(1-p)` 与 `L_block = 10(1-p)`，所以开卡和阻断永远不会成为最优动作。

正确形式：

```
L(d, y) = C_action(d) + C_residual(d, y)
```

- `C_action(d)`：执行该动作本身付出的代价（注意力、打断、操作开销），与真实状态无关。
- `C_residual(d, y)`：执行之后仍然残留的损失。

#### 普通活动：动作集 {silent, hint, card}

| 动作 | `C_action` | `C_residual(y=1)` | 说明 |
| :--- | :--- | :--- | :--- |
| 静默 | 0.00 | 1.00 | 不打扰，但漂移损失全留 |
| 提示 | 0.15 | 0.70 | 一句话，可能被忽略 |
| 开卡 | 0.50 | 0.30 | 强制选择，纠正更有效 |

交叉点：

```
silent → hint:  p = 0.15 + 0.70p  →  p = 0.500
hint   → card:  0.15 + 0.70p = 0.50 + 0.30p  →  p = 0.875
```

三个动作各有适用区间：`p<0.5` 静默，`0.5<p<0.875` 提示，`p>0.875` 开卡。

#### 破坏性操作：动作集 {silent, hint, card, block}

`block` 在普通活动里不在动作集内。只有满足 L3 条件的操作才把 `block` 加进来，且此时漂移损失按不可逆后果放大。

| 动作 | `C_action` | `C_residual(y=1)` |
| :--- | :--- | :--- |
| 静默 | 0.00 | 20.0 |
| 提示 | 0.15 | 14.0 |
| 开卡 | 0.50 | 6.0 |
| 阻断 | 2.00 | 0.05 |

交叉点：

```
silent → hint:  p = 0.0250
hint   → card:  p = 0.0438
card   → block: p = 0.2521
```

四个动作各有区间。阻断只在 `p > 0.252` 且操作本身不可逆时成为最优。

这些数值是工程初值，必须可配置。里程碑 B 应按用户实际反馈调整。

---

## 二、六条原则

### 2.1 统计量先定义语义，再写公式

| 参数 | 语义 | 里程碑 |
| :--- | :--- | :--- |
| `rulePrecision_r` | 规则 r 告警时确实为真漂移的比例 | B |
| `lambdaFP` | 系统整体每日误报数量 | B |
| `q_{f,1}` / `q_{f,0}` | 特征在两类条件下的命中概率 | 暂不实现 |

`rulePrecision_r` 与 `lambdaFP` 不能共用同一个 Beta 状态：前者评价单条规则，后者服务用户预算，标签获取机制也不同。

### 2.2 三个量分开

| 量 | 语义 | 用途 |
| :--- | :--- | :--- |
| `s(a,g)` | 关联分数 | 归因、检索、候选排序 |
| `riskScore(a)` | 偏离分数 | 复核门控、告警阈值 |
| `J(a)` | 行动效用 | 方向建议（第一版不自动切换） |

### 2.3 真值与告警结果分开

见 1.5。真值描述活动本身，告警结果描述系统行为。两者相乘才得到混淆矩阵。

### 2.4 四种决策各自定门槛，且门槛分尺度命名

```
thetaHintScore        # A 阶段，未校准分数
thetaCardScore        # A 阶段，未校准分数
thetaCardProbability  # B 阶段，校准概率
```

未校准分数与校准概率不在同一语义尺度，不能共用同一个数值阈值。变量名必须能看出是哪一个。

### 2.5 不确定显式表达

`UndecidableReason` 四种原因见 1.1。它们不进阈值系统，单独统计——占比本身就是目标树质量的指标。

### 2.6 成本不作关联的负向证据

高成本不等于低价值。成本只进行动效用。

---

## 三、前向链

### Layer 1 特征提取

#### A 组：语义相关性

| 特征 | 定义 | 缺失情形 |
| :--- | :--- | :--- |
| `lexical_match` | BM25 重合度归一化 | 无文本 → `missing` |
| `semantic_similarity` | 活动窗口与目标文本的嵌入余弦 | 无嵌入模型 → `missing` |
| `semantic_slope` | 近 k 轮相似度下降速率 | 同上；目标切换时重置窗口 |
| `retrieval_rank` | 混合检索排名 | **只用于候选召回，不进评分** |

`retrieval_rank` 是序数，不能当等间距连续特征加权。用法是先召回 top-k 候选目标，再在候选上算 `s`。

`semantic_slope` 在目标新增、矛盾解决、用户显式切换方向时清空窗口，否则正常推进子目标会被误判为方向漂移。

#### B 组：代码与任务结构

| 特征 | 定义 | 缺失情形 |
| :--- | :--- | :--- |
| `symbol_hit` | 改动符号是否落在目标关联符号集 | 无解析器 → `not_applicable`；有代码但解析失败 → `missing` |
| `dependency_distance` | `exp(-κd)` | 无依赖图 → `missing`；确实无依赖 → `available: 0` |
| `related_test` | 是否运行目标关联测试 | 属关联证据，不等于进展 |
| `evidence_link` | 路径是否在目标 `evidence` 中 | 证据位置 |
| `relevant_path` | 路径是否在目标 `relevantPaths` 中 | 允许工作范围 |

`dependency_distance` 的两种零值必须分清：拿不到图和确实没关系，混在一起会让无图项目看起来完全不相关。

#### C 组：行为轨迹与进展

| 特征 | 定义 | 归属 |
| :--- | :--- | :--- |
| `repeat_rate` | 近 20 次调用归一化签名重复比例 | 行为轨 |
| `same_error_streak` | 同动作 + 同错误连续次数 | 行为轨 |
| `alternating_loop` | 两组动作结果交替轮数 | 行为轨 |
| `state_delta` | 是否产生文件 diff 或状态变化 | 行为轨 |
| `verified_progress` | 是否有可验证的推进（测试翻转、构建通过、结论落盘） | 行为轨 + 行动效用 |
| `goal_linked_progress(a,g)` | 这些推进是否有证据指向目标 g | 目标对齐轨 |

`verified_progress` 与 `goal_linked_progress` 必须分开。

反例：Agent 在一个与目标无关的模块里修好三个 bug，测试全绿。`verified_progress = true`，但 `goal_linked_progress = false`。

`verified_progress` 只用于三处：检测无效循环（重复操作却没有进展）、计算效率与成本、行动效用。它**不得**降低 `riskScore`。

`goal_linked_progress` 才可作为对齐判断的辅助证据，且必须给出关联理由（改了哪个符号、落了哪条证据）。

#### D 组：资源与风险

| 特征 | 定义 | 归属 |
| :--- | :--- | :--- |
| `tool_error_rate` | 窗口内失败调用比例 | 行为轨 |
| `cost_per_progress` | 每单位 `verified_progress` 的 token 或耗时 | 行动效用 |
| `cost_rate` | 单位时间成本相对基线分位 | 行动效用 |
| `score_distribution_shift` | 评分序列的 ADWIN 结果 | 独立信号 |

`cost_per_progress` 在无 `verified_progress` 时返回 `not_applicable` 并标记 `no_verified_progress`，由成本异常检测处理，不做除零。

### Layer 2 三个分离的量

#### 2.1 关联分数 `s(a,g)`

按 1.3 计算，输出 `score` 与 `coverage`。候选目标由 `retrieval_rank` 召回，不遍历全量。

#### 2.2 偏离分数 `riskScore(a)`

独立计算，不是 `1 - max s`。第一版是可读规则树 + 加权：

| 输入 | 作用 |
| :--- | :--- |
| `max_g score(a,g)` | 关联越高，偏离越低 |
| 对应 `coverage` | 不足时倾向 `undecidable` |
| `approved_exploration` 命中 | 见下 |
| 必要配套工作 + 关联理由 | 见下 |
| 结构化冲突 | 撞排除项、与目标直接矛盾 |
| `goal_linked_progress` | 有关联证据的推进才降低风险 |

三条资格判断必须从严：

`approved_exploration` 不等于 `aligned`。它只说明该活动获得了预先授权。需要独立状态，并带适用范围、有效期、资源上限。过期或超额后不再豁免。

必要配套工作（测试、构建、格式化、依赖安装）不能只凭工具类别豁免。必须能关联到当前任务、目标或实际变更之一。孤立的 `npm install` 与为某个目标装依赖是两件事。

`excludedActivities` 与「未登记方法」分开。建议新增 `unregisteredMethods` 状态，避免新工具因尚未登记就被判为负向。

#### 2.3 目标效用与行动效用

```
U(g,t) = (1 + α_p·priority(g) + α_c·intensity(g)) · φ(τ, span)
τ = (t - startedAt) / (deadline - startedAt)
```

`φ` 的四分位跃升是调度策略配置，不是概率推断结论。缺 `deadline` 时退化为仅由优先级与矛盾强度决定。

```
J(a) = E[gain(a)] - cost(a) - switch_cost(a_prev, a)
```

`E[gain]` 无法可靠预测时返回 `unknown`，不产生方向建议。

第一版方向输出只允许一种：「目标 g' 紧迫度显著高于当前目标 g，且 g 近期无 `goal_linked_progress`」，附两个目标的 `U` 与剩余天数，结论是「建议检查优先级」。不自动建议切换。

### Layer 3 复核路由（里程碑 B 才启用）

```
L(d, y) = C_action(d) + C_residual(d, y)
R(d, p) = p·L(d,1) + (1-p)·L(d,0)
R_0 = min_d R(d, p)
R_1 = Σ_r P(r|x) · min_d R(d, P(Y=1|x,r))
VOI = R_0 - R_1 - C_review
```

#### 3.1 复核器混淆矩阵

不能只用一个总准确率：

```
sensitivity = P(r='drift' | Y=1)
specificity = P(r='not-drift' | Y=0)
```

后验：

```
P(Y=1|x,r='drift')     = sens·p / (sens·p + (1-spec)·(1-p))
P(Y=1|x,r='not-drift') = (1-sens)·p / ((1-sens)·p + spec·(1-p))
```

混淆矩阵必须来自有代表性的审计样本，或按抽样概率校正。只统计系统主动挑出来的高风险案例，会高估复核器的乐观程度。

#### 3.2 执行条件

`VOI > 0` 才调用复核。

「高确定性不值得复核」是常见情形而非规律。`C_residual(silent, y=1)` 很大时，`p` 接近 0.01 也可能值得复核——公式会体现，不要用启发式短路。

`p` 必须是校准后的概率。里程碑 A 的 `riskScore` 不能代入。

### Layer 4 分层干预

| 等级 | 行为 | 触发依据 |
| :--- | :--- | :--- |
| L0 | 静默记录 | 默认 |
| L1 | 一次上下文提示 | `riskScore ≥ thetaHintScore` |
| L2 | 待决干预卡 | A 期间 `riskScore ≥ thetaCardScore`；B 之后 `pDrift ≥ thetaCardProbability` |
| L3 | 阻断特定操作 | 见下 |

#### L3 适用范围

非只读不等于高风险。改源文件、更新测试、写日志与执行不可逆操作，风险完全不同。仅因「可能偏离目标」就阻断全部写操作，监控会自己导致任务失败。

只在以下情况触发：

| 条件 |
| :--- |
| 操作被用户显式纳入门控 |
| 破坏性或难以恢复（删除、强推、覆盖未提交变更、跨项目写入） |
| 明确违反已确认的项目约束 |
| 有可追溯理由与安全恢复路径 |

硬性禁止：不得由未校准 `riskScore` 触发，不得由 `uncertain` 触发，不得用于普通偏离。

普通偏离的处理顺序：提示 → 复核 → 要求重新确认 → 最后才是阻断。

必须提供用户覆写，覆写记录原因。

#### 静默模式

独立配置，不是 `B=0` 的推论。关闭全部主动告警，异常只写日志，保留主动查询。

### Layer 5 反馈、校准与自适应

#### 5.1 两个独立校准器（B 阶段）

| 校准器 | 回答的问题 | 拟合数据 |
| :--- | :--- | :--- |
| `riskScore → pDrift` | `riskScore = 0.7` 的活动实际有多大概率漂移 | 可信 `ActivityGroundTruth` |
| 复核器可靠性 | 复核模型输出某判断时实际有多可能正确 | 已确认样本上的复核结果 |

两者不能互相替代。前者把分数映射成概率，后者评价复核器是否可信。

样本量不足时用 Platt scaling 而非 isotonic（后者易过拟合）。训练「拟合校准器」与评估「校准效果」的数据必须分开。划分单位是完整任务或会话，同一任务的相邻活动不能跨越划分边界。

复核器的 `confidence` 同样要校准：先收集样本画可靠性曲线，拟合 `confidence → 实际正确率`，用拟合值作 `reliability`。校准完成前 `reliability = null`。

#### 5.2 分层随机审计

| 层 | 条件 | 抽查比例 | 目的 |
| :--- | :--- | :--- | :--- |
| 低风险 | `riskScore < thetaHintScore` | ε_low（2%） | 估计漏报 |
| 中风险 | `thetaHintScore ≤ riskScore < thetaCardScore` | ε_mid（15%） | 校准边界 |
| 高风险 | `riskScore ≥ thetaCardScore` | 100% | 全查 |

每条活动记录 `inclusionProbability`。误报估计按 1.4，用逆概率加权。

置信界不能用普通二项界：抽样概率不等、阈值候选集随时间变、同一任务内活动相关。用分层 Horvitz-Thompson 方差估计或按任务分层的 bootstrap。

#### 5.3 两个分开的后验

`rulePrecision_r`：

```
y_r = 1[规则判断与可信标签一致]     # 只统计规则发出告警的样本
rulePrecision_r ~ Beta(α_r, β_r)
α_r += w·y_r
β_r += w·(1 - y_r)
```

时间衰减：

```
ρ(Δt) = exp(-Δt / τ_rule)
α_t = α_0 + ρ·(α_{t-1} - α_0) + w·y_r
β_t = β_0 + ρ·(β_{t-1} - β_0) + w·(1-y_r)
```

`lambdaFP` 是另一个估计量，用 1.4 的逆概率加权公式，不共用 Beta 状态。

三条必须写进实现与注释：

`rulePrecision_r` 只统计规则发出告警的样本。漏报属于召回，单独统计，混进精度会让估计偏高。

小数权重是折扣伪计数近似，不是精确 Beta-Bernoulli 后验。文档不得声称严格后验。

先验 `Beta(α_0, β_0)` 的含义是「规则判断与可信标签一致」的概率。取 `Beta(1,1)`，不取 `Beta(2,1)`——后者均值 2/3，意味着默认倾向规则对。

#### 5.4 阈值：预算 + 设计匹配的置信界 + 独立验证

```
θ* = inf { θ ∈ grid : UCB_{1-δ}[ λ_FP(θ) ] ≤ B }
```

四道约束：

`grid` 预先规定，不在连续区间上任意搜索。

UCB 用分层方差估计，不用普通二项界。

**多阈值选择校正**：在同一批审计样本上搜多个候选阈值，会选出偶然表现好的那个。要么在独立验证窗口上评估最终阈值，要么用能覆盖多阈值选择的同时置信界。

**可行性检查**：无解时明确报告「当前阈值未能证明满足误报预算」，保持上一版阈值并提高审计比例。不能标为已通过预算校验。

稳定性：单次步长上限、冷却期、参数快照与回滚。

`B = 0` 走独立静默配置。

#### 5.5 判据补丁候选

```ts
interface CriteriaPatchCandidate {
  goalId: string
  kind: 'relevantActivity' | 'allowedMethod' | 'relevantPath'
  value: string
  supportingEvents: string[]
  independence: 'independent' | 'correlated' | 'unknown'
  expectedImpact: string
  status: 'pending' | 'accepted' | 'rejected'
}
```

两次确认只作生成候选的启发式条件。同一轮工作流、时间紧邻、同一文件 → 标 `correlated`。影响面大的补丁必须用户确认。

#### 5.6 分布变化检测

区分四件事：

| 变化对象 | 含义 | 应对 |
| :--- | :--- | :--- |
| 输入分布 | 项目阶段变了 | 提高审计比例 |
| 评分分布 | `riskScore` 整体移动 | 标记 `input_or_score_shift`，提高审计 |
| 真实标签分布 | 漂移案例占比变化 | 重估先验 |
| 校准失效 | 审计标签显示预测与实际持续偏离 | 触发重新校准 |

ADWIN 只能检测指定统计量的变化，不能自己证明分类器失准。它只触发第二行，后两行要靠审计标签确认。

ADWIN 的监控对象必须是明确单值指标；对已复核样本做变化检测要处理抽样权重与会话内相关性。

---

## 四、模型行为轨

### 4.1 三类变量分开

| 变量 | 含义 | 观测 |
| :--- | :--- | :--- |
| `event_occurred` | 重复/循环/错误连击发生 | 纯程序统计 |
| `harm_occurred` | 造成实际损失 | 结合结果判断 |
| `intervention_helped` | 打断后是否变好 | 干预前后对比 |

不能用 `event_occurred` 直接报警，也不能用目标对齐轨标签更新行为轨后验。

### 4.2 模式

| 模式 | 依据 |
| :--- | :--- |
| `action_observation_loop` | 同动作反复产生相同结果（忽略 ID） |
| `error_retry_loop` | 同动作 + 同错误连续，参数未变 |
| `alternating_loop` | 两组动作结果反复交替 |
| `agent_monologue` | 连续多条自述，无用户输入也无有效行动 |
| `context_failure_loop` | 上下文压缩或窗口错误反复 |
| `futile_search` | 连续只读且 `verified_progress = false` |
| `cost_runaway` | 每单位 `verified_progress` 的成本超分位 |

签名归一化忽略调用 ID、时间戳、无关排序。

`futile_search` 的判据是这几轮有无 `verified_progress`，不是只读次数。读文献、查依赖是正常行为。

### 4.3 提醒与判定分开

重复出现先提示不升级。连续命中同一模式且 `harm_occurred` 为真才升级。

---

## 五、里程碑

### 里程碑 0：统计契约冻结

交付：

- `RiskOutput` 与 `UndecidableReason` 唯一定义
- `FeatureValue` 三态
- 覆盖度公式（`A/(A∪M)`）
- 三个误报指标定义
- 损失矩阵结构与初值（含动作集随场景变化）
- `ActivityGroundTruth` 与 `InterventionDecision` 两接口

验收（类型层面）：

- VOI 与阈值函数只接受 `calibration.status === 'calibrated'` 的对象
- 无法把 `riskScore` 传给需要概率的参数
- `UndecidableReason` 只能取四个值之一

### 里程碑 A：可解释的评分基线

范围：Layer 1 + Layer 2 + L0/L1。

做什么：

1. 四组特征，每项返回三态
2. `score` 与 `coverage` 按 1.3
3. `riskScore` 规则树 + 加权，五态输出
4. `U(g,t)` 独立；`J` 只留字段
5. 干预只开 L0/L1
6. 每条活动记录特征向量、`riskScore`、`coverage`、`undecidable` 原因、`inclusionProbability`

不做：Beta、阈值自适应、VOI、自动判据补全、L3、`CalibratedRisk` 分支。

验收：

> 在预先定义的试点数据集上，比较新评分规则与字符串基线，报告样本量、精确率、召回率、误报率与置信区间。不宣称概率已校准。

补充：

- 划分单位是完整任务或会话
- 测试集覆盖四类典型：合理探索、必要依赖、真实漂移、信息不足
- 重点报告「每 100 次活动产生多少误报、漏掉多少真漂移」
- 100 条只用于判断特征是否有用，不足以支撑校准结论

### 里程碑 B：可信反馈与校准

范围：Layer 3 + Layer 5 的 5.1–5.4。

做什么：

1. 两个反馈接口落地
2. 分层随机审计 + 逆概率加权 + 设计匹配置信界
3. 两个独立校准器（`riskScore→pDrift`、复核器可靠性）
4. `rulePrecision_r` 与 `lambdaFP` 分开估计
5. 阈值：预定义网格 + 多阈值校正 + 可行性检查 + 步长冷却
6. VOI 路由（需混淆矩阵与损失矩阵）

验收：

- 加权估计与全量标注偏差可接受
- 阈值一周内不因个别样本大幅跳动
- 复核调用显著少于全量，漏报率不显著上升
- 报告带抽样设计说明与阈值验证方式

### 里程碑 C：策略自适应

前置：已有行动成本、实际进展、干预结果三类数据。

做什么：

1. `J(a)` 增益预测
2. 方向建议升级为行动对比
3. 若数据支持，引入主动学习或 Thompson sampling 优化复核资源

验收：同等打扰预算下发现更多真问题。

---

## 六、依赖的前置改动

| 前置项 | 原因 |
| :--- | :--- |
| 目标判据完整性 | 判据全空只能产出 `undecidable`。当前 8 个目标里 4 个属此列 |
| `relevantPaths` 与 `evidence` 分列 | 证据位置不等于允许工作范围 |
| `unregisteredMethods` 与 `excludedActivities` 分列 | 未登记不等于禁止 |
| 矛盾树 `depth` + 视图投影 `parentId` | 有 `parentId` 无深度校验，视图也不返回 |
| 用户手动提交活动入口 | 现在只能由模型调 `check_drift` |
| 采集范围 | 只采监控会话，真实工作在别处时不可见 |

---

## 七、明确不做

| 项 | 原因 |
| :--- | :--- |
| 一组 Beta 同时管特征质量与规则精度 | 语义不同 |
| `1 - max s` 当漂移概率 | 数学不成立 |
| 模型自报置信度直接作权重 | 未校准不可信 |
| 用户操作反推漂移真值 | `continue` 语义多义 |
| DDL 逾期追罚历史活动 | 因果不成立 |
| 模型 `why` 直接改特征权重 | 生成式解释不是归因 |
| `verified_progress` 降低偏离风险 | 无关模块的真进展仍是偏离 |
| 白名单命中等同 aligned | 授权不等于对齐 |
| 工具类别自动豁免 | 孤立 `npm install` 与为目标装依赖是两件事 |
| 直接搬开源阈值 | Context Health 校准集约 30 对；OpenHands 有合法重试被误判的记录 |
| A 阶段实现概率校准 | 标签量不足，会拟合噪声 |

---

## 八、已知局限

第一，A 阶段 `riskScore` 只保证序关系。所有依赖概率的下游逻辑等 B。

第二，分层审计只能部分修正选择偏差。低风险区审计比例过低时漏报估计方差仍大。

第三，特征相关性无法靠加权消除。校准层能吸收系统性偏移，不能让分数在无标签时变准。

第四，`rulePrecision_r` 的折扣伪计数是近似。文档不得声称严格贝叶斯。

第五，`J(a)` 需要「行动→结果」数据，现在一条都没有。C 可能长期停在只提示不切换。

第六，可信度上限由标注集质量决定。标注集只有明显 case 时，任何模型都会在边界样本上失效。

第七，损失矩阵是工程初值，不是标定结果。它决定各动作的适用区间，若初值偏离用户真实感受，干预策略会系统性偏保守或偏激进。

---

## 九、与现有实现的衔接

| 现有模块 | 变动 |
| :--- | :--- |
| `analysis/alignment.ts` | 改为输出 `score` + `coverage`，五态 |
| `analysis/drift.ts` | `detect*` 降为特征提供者 |
| `analysis/escalation.ts` | 门槛读阈值配置；B 之后插入 VOI |
| `analysis/judgment.ts` | 复核返回加 `why` 与 `uncertain`；标签落 `ActivityGroundTruth` |
| `analysis/selfaudit.ts` | 加逆概率加权误报估计、可靠性曲线、`rulePrecision` 与 `lambdaFP` 分离 |
| `analysis/progress.ts` | 抽 `U(g,t)`；`φ` 分位策略进配置 |
| `data/types.ts` | 活动加特征向量、`riskScore`、`coverage`、`inclusionProbability`；目标加 `relevantPaths`、`unregisteredMethods`；矛盾加 `depth` |
| `gate.ts` | L3 改为显式门控清单 + 破坏性操作 + 约束违反 |
| `report.ts` | 加校准状态、审计覆盖率、`undecidable` 四因占比、阈值验证方式 |

迁移：新字段可选，旧记录读时补默认值；`riskScore` 与旧 `decision` 并存一个版本周期，用报告对比差异后再切换。
