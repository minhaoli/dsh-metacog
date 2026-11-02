# dsh-metacog 功能清单

18 个工具、4 条斜杠命令（其中 `/metacog-goal` 与 `/metacog-contradiction` 是编辑命令）。

测试：37 个测试文件（含 `stage-g` 95 项）+ 18 个独立验证脚本（`scripts/verify-*.mjs`）。

方案：`docs/monitoring-design.md` 版本 3 已定稿。本清单是事实台账与任务台账，方案是建造契约——两者分工见第〇节。

当前实测（`dsh临时工作区`）：树版本 6、已确认、8 个目标、2 条矛盾；活动 2199 条，判定候选 791 条（0 条确认），报告 6 份；巡检间隔 60 分钟，`level3HardBlock` 关闭。

## 〇、本清单怎么读

六节各有分工：

- 一、验证状态速查——每项功能现在到哪一步。
- 二、已完成——已发生的事实，每条都对应可复现的验证脚本或真机观察。
- 三、缺陷与修复记录——错误根因与教训，以及 v3 带来的返工面。
- 四、待实现——按功能分组，每条标注它落在方案的哪个里程碑。
- 五、明确不做——含一条被 v3 推翻的旧决定。
- 六、环境事实——采集范围、数据位置、配置与当前数据分布。

分组用功能轴，排序用里程碑轴。方案 v3 的顺序是 0 → A → B → C，但清单仍按「特征提取 / 判定 / 反馈校准 / 报告 / 交互」这样功能内聚的方式组织，每个功能组内部再标明先后。

v3 带来的变化只有两类，但影响面很大：

第一，判定产物从三态改五态。现在是 `aligned | exploratory | scope_drift | uncertain`，v3 要求 `drift | aligned | uncertain` 加 `undecidable` 四因，并且分数与概率分离。这一条会重写判定链，不是加字段。

第二，旧清单里「明确不做」的「判定质量外部校准（不引入人工标注真值）」被推翻。里程碑 A 的验收条件就是在标注集上对比基线，里程碑 B 的校准全靠标注。这条撤销见 5.1。

## 一、验证状态速查

| 功能 | 脚本证据 | 真机证据 | v3 处置 |
| :--- | :--- | :--- | :--- |
| 目标与矛盾树（1.1） | 有 | 有 | 保留，补三个字段 |
| 漂移判定与升级（1.2） | 有 | 有 | 重写：三态 → 五态 |
| 采集与周期产出（1.3） | 有 | 有 | 保留 |
| 两条编辑命令 | 71 项 | 部分 | 保留 |
| `metacog_merge_tree` | 52 项 | 有 | 保留 |
| `deadline` 与分档提醒 | 48 项 | 有 | 保留，`U(g,t)` 从分档逻辑中抽出 |
| 结构化偏离解释 | 40 项 | 部分 | 保留，扩 `uncertain` 分支 |
| 报告（1.6） | 有 | 有，已按活动视角重写，见 2.7 | 已重写 |
| 里程碑 0 契约（4.2） | 85 项（含文档-代码一致性 21 项） | 未接数据 | v3 的信号体系整体作废 |

两项只到「部分」的原因与代码无关：斜杠命令只能由界面输入触发；模型复核字段只能由真实模型复核产生。

现有判定记录实测（2026-10-29 复核，替代早先的 791/498/293 一组数）：406 条唯一记录，驳回 249、待复核 157、确认 0。249 条驳回全部带 `modelVerdict` 与 `modelReason`，判定均为 `not_drift`。注意字段名是 `modelReason`——早先文档写成 `modelWhy`，那是个从未存在的字段，按它统计出来的「0 次」是无意义的。

## 二、已完成

### 2.1 目标与矛盾树

| 能力 | 真机证据 |
| :--- | :--- |
| 深度模型 | 真实工作区建起 5 层（depth 0–4），视图读回父子链完整；非法结构被 `TREE_SHAPE` 拒绝且版本不变 |
| 存量迁移 | 真实树 v1 → v2 自动迁移，审计写 `migrate_goal_depth`，快照未覆盖 |
| 推导 | `杂活` 1619 文件，267 秒，11 个目标、5 条矛盾、6 条待澄清，0 拒收 |
| 重建 | 25 项验证：三种拒绝路径、备份落盘、版本不回退、`tree_reset` 审计、旧快照未被覆盖、重建后可再确认 |
| `goal_tree_edit` | 改字段（status/priority/successCriteria）全部落盘；新增 depth 5 节点，六层链完整；删除叶子与 L1。三道门生效：`L0_CONFIRMATION_REQUIRED` / `NOT_A_LEAF` / `CONTRADICTION_LINK_BROKEN` |
| `contradiction_tree_edit` | 改字段 / 改类型 / 新增 / 删除四条路径跑通。core 矛盾改类型未加 `userConfirmed` 时被拒，加上后成功且记 `update_core_contradiction` |
| `contradiction_observe` | 样本不足时趋势 `unknown`，三条以上给出方向；`intensity=0` 存为 `null`；记录观察不写审计、不推进版本 |
| `metacog_revise` | 七种 kind 逐一跑通，版本 6→13、审计 9→16、哈希链完整。强度手改值与观察流值正确分离；矛盾解决后强度降 1 且节点保留 |
| 视图投影 | 补上 `description` / `rationale` / `resolutionHint`，`intensityEdited` 与 `intensity` 分离 |

#### 2.1.1 推导看见任务（2026-10-31）

`/metacog-init` 早先只吃一份扁平的「文档/结果/代码/数据」文件表，于是把 `杂活` 的 5 个任务目录读成了 6 个目标，整个漏掉 `系庆ppt`（38 文件）与 `人智协作：工程心理学的途径`（118 文件）；6 个目标又全是 `draft`，分不清哪件完成、哪件没动。现在推导输入多了三层：

| 变化 | 真机证据 |
| :--- | :--- |
| 目录级视图 | `discover.ts` 的 `taskDirectoryView` 把顶层目录当任务（`_`/`.`/`node_modules` 等仍排除），给出文件数、分类占比、最新改动、两层子目录与代表文件；顶层只有一个包裹目录时按文件占比自动下探一层。真实 `杂活`：5 个任务目录 —— `2026省会换届` 1077 文件、`人智协作：工程心理学的途径` 118、`萌老师要求帮忙事项` 118、`系庆ppt` 38、`实验心理学修订` 31；根目录 3 个文件单列。`metacog_scan` 与推导提示词读到同一份结构。 |
| 会话证据 | 插件进程用 `sessions.list` + `sessionPersistence.stat` 收集会话（含 workspace registry 里的归档会话），可选 `sessionQuery` 按目录名/「定稿 交付 完成」检索并**在插件侧按 cwd 过滤**；任一服务缺失即降级为「标题 + 最后活动时间」，提示词里明写「会话内容未参与判定」。真实 `杂活` 收集到 12 个相关会话（8 个有标题、4 个已归档）；脚本环境无 `sessionQuery`，输出如实标注降级。 |
| 完成状态 | 目标 schema 增加 `status` / `statusBasis` / `statusEvidence`，L1 必须给依据。`reviewDerivation` 三条门：声称有依据却没写证据 → `STATUS_EVIDENCE_REQUIRED`；没有任何依据却标 done → `STATUS_WITHOUT_EVIDENCE` 降回 draft；只有 mtime → `STATUS_FROM_MTIME_ONLY` 压置信度并提问。缺证据又没写「无完成证据」的 L1 由一条汇总问题点名，避免默认当「未开始」。 |
| 转录门放宽 | 标题复述但引用了路径或计数（`系庆ppt/`、`38 个文件`）不再判 `LIKELY_TRANSCRIPTION`；把章节标题原样搬来且无结构性事实仍拒。提示词同步要求：N 个任务级目录对应 N 个 L1，要合并只能写进 `openQuestions`，不得默默丢弃。 |

端到端实证见本节末。

**端到端实证（2026-10-31，`D:\文档\杂活`）**：真实扫描（1633 文件，5 个任务目录）+ 真实会话元数据（12 个会话、8 个有标题、4 个归档；本机无 `sessionQuery`，提示词如实标注「会话内容未参与判定」）渲染推导提示词，由子代理读真实正文（`2026省会换届/02_任务总结.md`、`01_录音逐字稿.md`、`大组会排班SOP.md`）完成推导，再经 `reviewDerivation` 复核：**6 个目标（根 1 + L1 5）+ 8 条矛盾 + 7 条待澄清，0 拒收、0 降级**。

| L1 | 完成状态 | 判定依据 |
| :--- | :--- | :--- |
| 把省心理学会十九届换届推进到 11 月 7 日大会当天材料齐备、口径一致 | active | 选票/选票印刷清单.docx、选票名单排序核对.xlsx（2026-10-29）；会议 2026-11-07 尚未召开，故不是 done |
| 把《人智协作：工程心理学的途径》导论第一章改到审稿人不再退回 | **at_risk** | 返稿2/第一章 05.06_zjf's revision.docx（2026-05-06）为最后一轮；此后近 6 个月无改动，且全书只有导论 106 个文件在推进 |
| 让沈老师的个人材料在任何一次要填表时都能直接取出、口径一致 | active | 沈模卫论文统计_定稿.xlsx（2026-10-20），同日仍存「待复核清单_v2」，定稿未闭合 |
| 完成系庆ppt 的学术报告（场上讲得完、讲得清） | **done** | `系庆报告(1107).pptx` 定版于 2025-11-07（文件名日期与 mtime 同日），此后 12 个月无改动 |
| 让人卫社《实验心理学》第 4 版的第一篇样章达到编写要求 | active | 第一篇…docx 与 编写分工updating.xlsx（2026-10-26）；第 4 版编写要求 2026-10-27 才到，正文首轮 |

矛盾里最有价值的一条来自结构统计而非文件内容：换届目录 1121 个文件中 966 个在 `_asr/` 下（占 86%），而该转写管线只产出两份 md。`openQuestions` 7 条，包括「根目录 3 个无目录文件是否算第六件事」「书稿是否只写导论」「四个归档会话找不到对应目录」。相比修复前的「6 个目标、漏 2 个目录、全 draft」，这次 5 个任务目录全部出现，且完成状态各有依据。

### 2.2 漂移判定与升级

| 能力 | 真机证据 |
| :--- | :--- |
| `check_drift` 两种模式 | `mode: static` 与 `mode: activity` 都跑过。摘要含预注册关键词 → `exploratory` 并指向对应目标；含无关内容 → `scope_drift` 并开 Level 1 信号 |
| 模型复核 | 真实模型驳回 498 条候选，理由具体（认出宿主注入的上下文、时间戳元信息） |
| `/metacog-check` | 真实模型跑通，理由逐条对照活动，判定「仍在服务目标」 |
| 干预卡与 `resolve_intervention` | 6 张卡：3 张 pending、3 张 resolved。真实结案陈旧卡：决策落盘、同类卡片 superseded、审计留痕、Level 3 门解除。另有 37 项独立验证 |
| Level 3 硬拦截 | 完整走通：core 矛盾强度 4 + 3 条 `scope_drift` → `core_bypass` 重复 3 次触发升级。影子模式放行；开启后 `pwsh` 被拒并给出卡片 id / 原因 / 四个决策；只读工具不受影响；决策后写工具恢复 |
| 定时巡检 | 间隔临时改 1 分钟、阈值改 3，调一次 `check_drift` 注册项目后不做任何操作，整 1 分钟后自动产生 `contradiction_shift` 信号 |
| 观察流与趋势 | 真实写入成功，样本不足时拒绝给方向；`trendAtRecordTime` 正确 |

现有判定链的匹配范围需要说明清楚，因为它决定 v3 的覆盖度能不能算出来：`alignment.ts` 只从 `alignment.excludedActivities`、`alignment.relevantActivities`、`alignment.allowedMethods` 三处匹配；`successCriteria` 只通过 `relatedGoalIds` 进入 `candidateGoalIds`，注释明确写着「never decides a verdict on its own」。所以一个目标的 `relevantActivities` 与 `allowedMethods` 都为空时，任何活动都不可能被判成 `exploratory` 或 `aligned`。实测 8 个目标里 6 个属于这种情况，见 4.1。

### 2.3 采集与周期产出

| 能力 | 真机证据 |
| :--- | :--- |
| 材料扫描 | 真实 4387 个文件，四类计数正确，排除规则生效，文档排在代码前 |
| 文档读取 | PDF 3 份（2/5/5 页）中文完整；xlsx 2 个工作表；docx 15KB/38KB 段落不粘连；pptx 4.4MB 按页输出 |
| 截断契约 | 修复 `maxChars` 超发后，docx/xlsx/pdf/pptx 四条路径严格不超发，新增 `truncated` / `totalChars` |
| 项目背景 | 用户陈述层与派生层同时落盘且互不覆盖，22 项独立验证 |
| 回合级采集 | 真实活动流出现 `source: turn`，摘要为回合汇报正文，35 条 |
| 用户消息采集 | 真实活动流出现 `source: user_input`，434 条 |
| 注入块过滤 | 重启后新采集的 `user_input` 不再包含宿主注入块；120 条历史注入块停在 06:56:45Z，早于重启 |
| 提醒去重 | 真机输出「新增 34 条复核记录」，越过阈值 30 只提醒一次（此前会重复四次） |
| 检查点增量窗口 | 读回「自上次汇报以来」，判定成功后推进。另有 14 项独立验证 |
| 信号归档 | 归档 1459 条：实时流清空、归档文件首末 id 一致、`.meta.json` 完整、判定流与活动流未受影响、空流再归档返回 0 |
| 认知监控会话 | `/metacog-init` 建出专用会话并接管首轮 |
| 多项目隔离 | 修掉「三处只取第一个项目」的缺陷。13 项验证：B 项目的 Level 3 卡拦 B 不拦 A、会话 cwd 决定归属、未知会话不误判 |

### 2.4 用户直接编辑与多树合并

| 能力 | 证据 |
| :--- | :--- |
| `/metacog-goal` 命令 | 71 项独立验证。改字段、加子目标、L0 需 `--force`、找不到目标给可操作提示、解析失败附用法。走的是同一套受治理写入：CAS、结构门、审计链与工具路径完全一致 |
| `/metacog-contradiction` 命令 | 同上脚本覆盖。改强度/类型/两极，core 需 `--force`，审计记 `reclassify_contradiction` |
| 命令的审计归属 | 加 `actorHint: 'user'`，命令发起的写入审计记 `user_confirmed` 而非 `manual_tool`。真机验证：带该参数调用后审计 `actor: user_confirmed` |
| `metacog_merge_tree` 工具 | 52 项独立验证 + 真机全流程：预览（不写入、版本不变、给出 `addedGoalIds` 与 `remappedReferences`）→ 确认（版本 6→7，目标 8→10）→ 落盘核对（候选根同名去重，两条新节点挂到主根下）→ 审计 `action: merge_trees`、哈希链完整 |

### 2.5 时间线与偏离解释

| 能力 | 证据 |
| :--- | :--- |
| `deadline` / `startedAt` 字段 | 48 项独立验证 + 真机：日期可写 `2026-11-30` 或完整 ISO；空串清除；改 deadline 被识别为变更并按深度记 `update_l1` / `update_lower_goal` |
| 分档提醒 | 提醒点是跨度的分数（1/4、1/2、3/4），不是固定日期。边界含下端：正好 1/4 算 quarter 不算 early |
| 跨度决定检查层级 | 短期（≤14 天）看深层目标，中期（≤90 天）看中层，长期只看战略层。真机印证：10 天跨度的 depth 3 目标会被检查，100 天跨度的 depth 2 目标不会 |
| `deadline_risk` 信号 | 48 项验证 + 真机产生信号：新建一个从无推进记录的目标、设 10 天跨度已过 80%，返回 `signalType: deadline_risk`、`level: 0`。有推进记录的目标不提醒，这是设计意图而非漏报 |
| 结构化偏离解释 | 40 项独立验证。`why` 六值枚举可统计、`howToAdjust` 给具体动作、`confidence` 低于 0.6 不执行 |
| 驳回原因统计 | `assessRules` 已按 `why` 分组输出 `byWhy`，渲染时附「驳回原因：…」一行 |

### 2.6 报告

| 能力 | 真机证据 |
| :--- | :--- |
| 日报 / 周报 / 月报 | 生成过 6 份，绑定树版本 |
| 规则健康度 | 周报算过「候选 230，确认 0，驳回 224」，6 条待复核正确排除在分母外 |
| 监控状态小节 | 日报渲染出「本期判定 N 条活动 / 复核 M 条 / K 条待复核」，与磁盘一致 |

报告格式已重写，见 2.7。

### 2.7 报告重写

日报 / 周报 / 月报改为活动视角：写这段时间干了什么，不写树结构统计。

| 能力 | 实现 |
| :--- | :--- |
| 视角 | 监控状态在前、本期活动在后；按「时间段 + 目录 + 动作」聚合，列出实际文件名 |
| 篇幅 | 日报 400 / 周报 600 / 月报 800 字，超限按优先级截断并标「已截断」，截断标记计入上限 |
| 只陈述事实 | 删掉「明日唯一优先项」「下周主要矛盾假设」两节；判定分布合并成监控状态里的一行 |
| 占位节 | 校准状态 / 审计覆盖率 / undecidable 四因占比 / 阈值验证方式，各一行「本期未启用」，截断后仍保留（`src/report.ts` 的注释里这四节仍称 "v3 sections"，指的是它们承接自 v3 方案、在 v4 下依然没有数据源，不是指报告版本号） |
| markdown 落盘 | `reports/markdown/<类型>-<YYYY-MM-DD>.md`，不加序号，tmp + rename 原子替换，失败只告警不影响生成 |
| 月报三问题 | L0 无基线只标注一次且会比对建树时刻；核心矛盾空月合成一句；漂移模式样本不足明说（阈值 30 条） |
| 的期口径 | 标题与文件名取本地日期（周期结束日），记录内时间戳仍是 UTC |

验证：`tsc` 0 错误；`test/stage-g.test.mjs` 95 项；`scripts/verify-report.mjs` 真实数据三档 364 / 563 / 746 字，均未超限。回归 `check-window` 16 项、`acceptance` 80 项通过。

已知取舍：日报不再出现目标名——活动视角的代价，目标名只在 prompt block 里。`pwsh` 记录只有命令没有路径（真实数据里占 28%），按「只取命令里第一个绝对路径、只用于定目录、不伪造文件名」处理，涉及目录 36 → 60、「未标路径」617 → 477。

### 2.8 设置卡

宿主侧 `src/api.ts` 注册 `/api/metacog` 前缀路由；客户端 `client.js` 注册进 `plugins.bundle.config`（key `dsh-metacog`），只在 bundle 自己的页面渲染。

| 模块 | 状态 |
| :--- | :--- |
| 概览统计 | 有：目标 / 矛盾 / 活动 / 待复核 / 报告 |
| 判定分布 | 有：对齐、探索、偏离、待定、最近一条活动 |
| 数据体积 | 有：`.metacog` 各子目录字节数 |
| 报告查看与生成 | 有：列表、点开看正文、生成日报 / 周报 / 月报 |
| 阈值与配置 | 只读展示；改值仍走 `cordis.patch.yml` |
| 手动操作 | 有：归档信号流（无信号时返回 0，不报错） |
| LLM 配置与用量 | 未做 |
| 立即巡检 | 未做：需要 agent 上下文，HTTP 侧没有 |
| 清空记录 | 未做：破坏性操作，没有二次确认流程 |

验证：`scripts/verify-card-api.mjs` 28 项（读取跑真实数据，写入跑临时副本，不碰真实项目）；`scripts/verify-card-client.mjs` 17 项（插槽名、key、组件、主题 token、summary 分支）。未做浏览器渲染验证——要让宿主重新扫描 `dsh.client` 必须重启进程。

路由只按挂载点已知的项目根解析 id，不接受任意路径；跨站 POST 按 `Origin` 与 `Host` 比对拒绝。

## 三、缺陷与修复记录

### 3.1 已修的缺陷

| 缺陷 | 根因 | 修法 |
| :--- | :--- | :--- |
| 视图读不回描述 | `GoalView` 漏了 `description` / `rationale` / `resolutionHint` | 补齐三个投影字段 |
| `maxChars` 超发 | 截断提示串拼在配额之外，传 100 实际返 116 | 提示串计入配额；配额不足时返回空串 |
| 审计 action 全部写死 | `auditActionFor()` 写好了但 `revise.ts` 从没调用 | 按批次中第一个生效的 kind 取 action |
| `rationale` 复制 `consequence` | 新增矛盾时两字段同一句话 | `create` 新增独立 `rationale` 字段 |
| 只改描述措辞误导 | `applied` 显示「改为「(未改名)」」，成功操作读起来像失败 | `describeRevision` 区分四种情况 |
| 改矛盾记成改目标 | `auditActionFor` 只认改类型和 core，普通字段改动落兜底分支 | 触碰任意矛盾即 `reclassify_contradiction` |
| 新增矛盾同样记错 | `addedContradictionIds` 非空时不触发矛盾分支 | 同上 |
| 删除不可见 | `computeChanges` 只对比前后数组，删除不留痕迹 | `ChangeSet` 新增 `removedGoalIds` / `removedContradictionIds` |
| 删除的审计 `targetIds` 为空 | 返回值有了删除 id，审计没带上 | 两个编辑工具的 `targetIds` 并入 `removed*Ids` |
| 多项目只取第一个 | 三个消费点都用 `monitored.values().next()` | 按会话 cwd 解析；提示块汇总所有项目 |
| 推导漏掉整个任务目录 | 输入只有扁平文件表，没有「顶层目录 = 任务」这个维度；转录门又把按目录派生判成转录 | 目录级视图进入扫描与提示词；结构事实豁免转录门；N 个任务目录 = N 个 L1 |
| 目标全是 draft | 推导 schema 没有完成状态字段，用户分不清「完成」和「没动」 | 增加 `status`/`statusBasis`/`statusEvidence` 与三条证据门 |

### 3.2 四条教训

刷新插件不会重新加载已 import 的 ESM 模块。`unlag_refresh` 会重新执行 `apply`，但 Node 的模块缓存仍在：`lib/analysis/drift.js` 已经被加载过，刷新只让新的 `apply` 拿到旧模块的导出。

实测：进程 15:14 启动，`lib` 16:42 编译，刷新后新增的 `detectDeadlineRisk` 完全不生效（信号恒为空），同一份代码用 `node` 直接调是好的。重启后立刻产出信号。

所以验证顺序是：编译 → 重启 → 验证。刷新只对「新增工具注册」「命令注册」这类跑在 `apply` 里的代码有效。

代码改对了不等于生效。改完必须确认进程加载的是新代码。

文档与行为不一致时，先确认哪个是设计意图。`goal_tree_edit` 的 `removes` 描述写「deprecate」，实际是真删除。我据此改成废弃语义，测试立刻失败两条——原设计的「真删除 + 事后整树悬空链接校验」本来就在，而且更完整。真正错的只是措辞。

配置写错会让插件整个挂不上。`staleDaysThreshold: 0` 被 `positiveInt` 拒绝，配置校验失败后插件完全不加载，所有工具消失（报 `unknown tool`）。

### 3.3 v3 带来的返工面

方案第九节列出九个模块要改。按「改什么」重排如下，行序即建议动手顺序：

| 模块 | 现状 | v3 要求的改动 |
| :--- | :--- | :--- |
| `data/types.ts` | 无 `relevantPaths` / `unregisteredMethods` / 矛盾 `depth` | 补三个字段；活动加特征向量、`riskScore`、`coverage`、`inclusionProbability` |
| `analysis/alignment.ts` | 四项字符串匹配，输出三态 | 输出 `score` + `coverage`，五态；`s(a,g)` 与 `riskScore(a)` 拆开 |
| `analysis/drift.ts` | `detect*` 直接产出信号 | 降为特征提供者，信号由 `riskScore` 统一产出 |
| `analysis/escalation.ts` | 门槛读 `repeatThreshold` / `minConfidence` | 改读 `thetaHintScore` / `thetaCardScore`；B 之后插入 VOI |
| `gate.ts` | `level3HardBlock` 按信号类别拦 | 改为显式门控清单 + 破坏性操作 + 约束违反 |
| `analysis/judgment.ts` | 已有 `why` / `howToAdjust` / `confidence` | 加 `uncertain` 分支；标签落 `ActivityGroundTruth` |
| `analysis/selfaudit.ts` | `assessRules` + `byWhy` + `overallFalsePositiveRate` | 加逆概率加权、可靠性曲线、`rulePrecision` 与 `lambdaFP` 分离 |
| `analysis/progress.ts` | 分档提醒 + `deadline_risk` | 抽出 `U(g,t)`，`φ` 分位策略进配置 |
| `report.ts` | 树结构与统计指标 | 加校准状态、审计覆盖率、`undecidable` 四因占比、阈值验证方式 |

迁移原则：新字段可选，旧记录读时补默认值；`riskScore` 与旧 `decision` 并存一个版本周期，用报告对比差异后再切换。

## 四、待实现

### 4.0 功能组与里程碑的对应

| 功能组 | 落在哪个里程碑 | 能否与里程碑并行 |
| :--- | :--- | :--- |
| 前置改动（4.1） | 阻塞里程碑 A | 必须先行 |
| 统计契约冻结（4.2） | 里程碑 0 | 必须先行 |
| 特征提取与评分基线（4.3） | 里程碑 A | — |
| 反馈与校准（4.4） | 里程碑 B | 需 A 完成 |
| 策略自适应（4.5） | 里程碑 C | 需 B 完成 |
| 模型行为轨（4.6） | 独立轨，不占里程碑 | 可并行 |
| 报告重写（4.7） | 已完成，见 2.7 | — |
| 设置卡（4.8） | 已完成，见 2.8 | — |
| 交互逻辑（4.9） | 工程项 | 可并行 |
| 其他工程项（4.10） | 工程项 | 可并行 |

### 4.1 前置改动（阻塞里程碑 A）

这六项不做，里程碑 A 会产出大量 `undecidable`，特征再好也验证不出东西。

| 前置项 | 现状（实测） | 为什么阻塞 A |
| :--- | :--- | :--- |
| 目标判据完整性 | 8 个目标里 6 个的 `relevantActivities` 与 `allowedMethods` 都是空，其中 4 个连 `successCriteria` 也空 | 无匹配判据的目标只能产出 `undecidable: criteria_missing`，`coverage` 恒为 0 |
| `relevantPaths` 与 `evidence` 分列 | `GoalNode` 只有 `evidence`，兼作证据位置与允许范围 | `evidence_link` 与 `relevant_path` 两个特征无法区分，只能合成一个 |
| `unregisteredMethods` 与 `excludedActivities` 分列 | 只有 `excludedActivities` | 新工具尚未登记会被当成排除项，产生负向证据 |
| 矛盾树 `depth` + 视图投影 `parentId` | 有 `parentId` 无 `depth`；视图不返回 `parentId` | 父子关系可写不可见，层级校验无从下手 |
| 用户手动提交活动入口 | 只有模型可调 `check_drift({ activity })` | 试点标注集缺少用户侧真值入口 |
| 采集范围 | 只采绑定的认知监控会话 | 真实工作在别的会话时不可见，标注集覆盖不全 |

判据完整性的实测数据：

| 目标 | 相关活动 | 允许方法 | 成功标准 | 能否匹配 |
| :--- | :--- | :--- | :--- | :--- |
| d0 根目标 | 0 | 0 | 0 | 永不匹配 |
| d1 目标与矛盾的结构建模 | 2 | 1 | 1 | 可匹配 |
| d1 漂移信号的判定与升级 | 2 | 1 | 1 | 可匹配 |
| d1 宿主接入与周期产出 | 0 | 0 | 1 | 不可匹配（成功标准不单独决定判定） |
| d1 验证层一 | 0 | 0 | 0 | 永不匹配 |
| d2 验证层二 | 0 | 0 | 0 | 永不匹配 |
| d3 验证层三 | 0 | 0 | 0 | 永不匹配 |
| d4 验证层四 | 0 | 0 | 1 | 不可匹配（同上） |

这是「2199 条活动里 `aligned` 为 0」的根因之一：不是规则判错，是目标没给可匹配的判据。推导阶段应强制要求 `relevantActivities` 或 `allowedMethods` 至少填一个，当前 `goal_tree_confirm` 不校验这两个字段。

### 4.2 里程碑 0：统计契约冻结

只写类型与常量，不接数据。

**状态：已完成（2026-10-29）。** 落点 `src/data/signals.ts`，独立于 `data/types.ts`——新契约如果不成立，不需要回滚存储 schema。原先担心的「类型分散两处」由此定案：新契约单独成文件。

| 交付 | 内容 | 状态 |
| :--- | :--- | :--- |
| `SignalScore` | 三态判别联合：`available`（带 score）/ `not_applicable` / `missing`，后两者各带 `SignalAbsenceReason` 五值 | 已实现 |
| `SignalId` | 五信号枚举 `s1_semantic` / `s2_class` / `s3_tool_novel` / `s4_plan_match` / `s5_progress` | 已实现 |
| 三维度权重 | `scope` 0.50（S3+S2）、`plan` 0.25（S4）、`progress` 0.25（S5）；S1 不入权重 | 已实现 |
| `StepAggregate` | `riskScore`（可空）/ `availableWeight` / `coverage` / `dimensions[]` / `absent[]` | 已实现 |
| `aggregateStep()` | 维度取成员最大值而非均值；按可用权重归一 | 已实现 |
| `advanceEma()` | 单层 EMA；**`riskScore` 为 null 的步不衰减，原样携带** | 已实现 |
| `decideLevelFromScore()` | 覆盖率门在此函数内检查，调用方无法遗漏 | 已实现 |
| `DeclaredPlan` | `allowedTools` + 结构化 `steps[].expects`（`tool` / `pathGlob` / `assert`） | 已实现 |
| 阈值命名 | `thetaHintScore` 0.500 / `thetaCardScore` 0.875 / `consecutiveStepsForCard` 3 / `coverageFloor` 0.4 | 已实现 |
| `goal.doneAt` / `contradiction.resolvedAt` | 成就时间线的数据基础，落在 `data/types.ts` | 已实现 |

**未在里程碑 0 完成、需在 A 里补的一项**：`SignalState`（`final` / `consecutiveHigh` / 每个 project 一份）必须持久化。`final` 跨 turn 累积，重启即归零会让 L2 的「连续 N 步」永远攒不满。类型已在 signals.ts 里由 `StepAggregate` 承载单步部分，但**跨步状态的落盘位置还没定**——这是 A 的第一件事。

验收（全部已过，共 85 项）：

| 证据 | 结果 |
| :--- | :--- |
| `npm run build` | 无报错 |
| `npm run test:signals`（`test/signals-contract.test.mjs`） | 28 项，算术与语义 |
| `node scripts/probe-signals.mjs` | 17 项，zod 边界 + 端到端分步 |
| `npm run check:contract`（`scripts/check-doc-vs-code.mjs`） | 21 项，文档数字与代码常量一致 |
| `npm run check:design` | 22 项，文档内部不残留已被推翻的说法 |
| `npm run test:stage-a` | 40 项回归，既有功能未破坏 |

关键不变量（都有测试托住，不要在没有对应测试的情况下改动）：

- 覆盖率只能取 `{0, 0.25, 0.5, 0.75, 1}` 五值，由权重组合枚举得出，不是硬编码
- `coverageFloor` 0.4 的真实含义是「可用权重和 ≥ 0.50」，它**不**等价于「S3 或 S2 可用」——S4+S5 同时可用也过门（0.50），而单独 S4 或单独 S5（0.25）都不过
- β=0.4 下单步突发峰值 0.400，低于 0.500 的提示门，故单步不报警；L2 在「满分持续」时第 7 步才成立
- `expects: {}` 在 schema 层合法，「永不判定完成」这条语义由匹配器负责，不在 schema 里

### 4.3 里程碑 A：五信号与聚合

原第 4.3 节描述的是 v3 的四组十九个特征，已被 v4 整体替换。当前实际内容见 4.2 与设计文档 1–2 章。

已完成：S3 工具越界、S2 类别分布、S5 推进真实性、三维度加权聚合、单层 EMA、L0/L1 分级、`metacog_declare_plan`。

未完成：S1 语义漂移（enum 里定义了 `s1_semantic`，但**没有任何产生点**，`aggregateStep` 也不读它——文档 2.1 描述的兜底通道在代码里不存在）。

### 4.4 里程碑 B：校准与自适应

设计文档六点五节已判定暂缓，原因不是算法而是标签：四条反馈通道实测全部枯竭，正类样本为 0。

未实现且短期内不会实现：分层随机审计、`inclusionProbability`、逆概率加权、Platt scaling、阈值求解、VOI 路由。

### 4.5 里程碑 C：策略自适应

未实现，依赖 4.4 的校准数据。

### 4.6 模型行为轨

与目标对齐并列的第二条轨，两套规则集、阈值、自评各自独立。

| 监控对象 | 信号 |
| :--- | :--- |
| 工具调用循环 | 同动作反复产生相同结果（忽略 ID） |
| 错误重试 | 同动作 + 同错误连续，参数未变 |
| 交替循环 | 两组动作结果反复交替 |
| 自述空转 | 连续多条自述，无用户输入也无有效行动 |
| 上下文失效 | 压缩或窗口错误反复 |
| 无效探索 | 连续只读且 `verified_progress = false` |
| 成本失控 | 每单位 `verified_progress` 的成本超分位 |

要点：

- 三类变量分开：`event_occurred` / `harm_occurred` / `intervention_helped`。事件发生不等于造成损失，不能用前者直接报警
- 不能用目标对齐轨的标签更新行为轨后验
- `futile_search` 的判据是有无 `verified_progress`，不是只读次数
- 默认只记录与提醒，连续命中同一模式且 `harm_occurred` 为真才升级
- 规则健康度按 `monitorCategory` 分组，否则两套规则的误报率会混在一起

### 4.7 报告重写

已完成，见 2.7。原始要求保留在这里作为验收依据：活动视角、时间段 + 目录 + 动作、实际文件名、400 / 600 / 800 字上限、只陈述事实、监控信息在前、四类占位小节、月报三问题修正。

未做的部分：按目标聚合的活动（现在只按目录聚合）。日报里不再出现目标名，要靠 prompt block 才能看到。

### 4.8 设置卡

已完成，见 2.8。宿主侧 `src/api.ts` 加客户端 `client.js`，插件仍是 host + client 同包，安装形态没变（本来就是 bundle）。

未做的部分：

| 模块 | 为什么没做 |
| :--- | :--- |
| LLM 配置 | 需要接 `agentDefaultModel`，但设置卡只能写插件自己的 config，改全局模型选择属于另一条链路 |
| LLM 用量 | 活动流里没有 token 数据，要另接 `assistant/message` 的 `TokenUsage`；费用还得自维护价格表 |
| 立即巡检 | 巡检要起 subagent，HTTP 请求没有 agent 上下文 |
| 清空记录 | 破坏性操作，缺二次确认流程 |
| `plugins.detail.section` | 该插槽的 `PluginsSubject` 类型在安装包里不可见，判断不出「这一页是不是本插件」，硬挂会出现在所有插件页上。只用 keyed 的 `plugins.bundle.config` |


### 4.9 交互逻辑重新界定

已明确「先暂且这样，记住需要修改」。当前已知问题：

| 问题 | 现状 |
| :--- | :--- |
| 命令与工具不对等 | `/metacog-init` 无对应工具；`/metacog-check` 与 `check_drift` 语义不完全等价 |
| 提醒渠道单一 | 只在 `/metacog-check` 回复里提醒，无主动通道 |
| 干预卡交互 | 靠工具调用决策，用户侧无集中入口 |
| 判定结果呈现 | 只在报告里，日常对话中不可见 |
| 目标与矛盾的修改呈现 | 只能看到工具返回的 JSON 摘要（版本号、id 列表、审计 id）。用户想知道「这棵树现在长什么样、我刚改的那一处落在哪」必须自己读状态文件。修改的确认、预览、撤销都没有界面承载 |

静默模式：需要一个「只记录、不打扰」的模式——巡检照常、活动照常判定、信号照常落盘，但不产生对话内提醒、不弹干预卡，结论只在报告与设置卡里可见。

v3 已把它定为 Layer 4 的独立配置，不是 `B = 0` 的推论。Level 3 硬拦截属于安全机制，静默模式下是否仍拦需单独决定（倾向仍拦——静默的是提示，不是保护）。

### 4.9.4 2026-10-29 完成的一批（4.9 静默模式 + 4.10 五项）

这次做了 4.9 的核心诉求和 4.10 里不依赖新数据的几项。

| 项 | 落点 | 说明 |
| :--- | :--- | :--- |
| 静默模式 | `config.quiet` | `enabled` 默认 false；开启后不弹卡、不提示，但采集、评分、落盘全部照常 |
| L3 在静默下仍拦 | `config.quiet.keepHardBlock` | 默认 true。静默的是提示，不是保护 |
| 提示块可单独关 | `config.quiet.suppressPromptBlock` | 默认 false——块是被动上下文，不是需要点掉的卡 |
| 删除树 | `metacog_purge` | **移走不删除**，移到 `purge/<时间戳>/`，可手工移回 |
| 巡检自启动 | `discoverPersistedProjects` | 从 `~/.dsh/metacog-projects.json` 重建项目列表 |
| 成本短路 | 巡检的 review 前置 | 待复核队列为空时不发任何模型调用 |
| 提醒通道 | `onHints` | 巡检发现的东西进提示缓存，下一轮可见 |

**静默模式为什么不是"把阈值调高"**：那样做会同时关掉记录，而记录是唯一能验证阈值的东西。所以它只关"打扰"，不关"判断"。这一条有测试托住：`test/quiet-mode.test.mjs` 断言静默前后 collection / signals / schedule / thresholds 四节配置完全相同。

**purge 的三条保护**（都有测试）：

一，确认要**打出 project id**，不是勾一个框。布尔量会被条件反射地点掉，打 id 需要真的读一遍。
二，比对的是这次调用实际解析到的 id，不是调用方声称的——从别的项目报告里复制的 id 会失败而不是清空当前项目。
三，目标树不动。"清空记录"不该顺带毁掉标尺。

**巡检自启动的由来**：`monitored` 原本只在工具调用或事件流触发时注册。重启后如果没人碰工具，巡检的项目列表是空的——它看起来在运行，实际什么都没做。这是监控最不该有的状态。现在插件自己维护一个项目索引，重启能重建。

**成本短路的位置**：原逻辑在非静默期会无条件调 `reviewPendingJudgments`，队列空也调。空队列上的模型调用只可能返回空，机器空转时就是持续的无效请求。

### 4.9.5 实测确认的未完成项（2026-10-29 逐项核对代码）

上面各节的"未做的部分"写于不同时间，措辞已与代码脱节。这一节是刚跑完核对后的当前状态，以代码为准。

**确认未实现**（搜不到实现，不是"可能有但没找到"）：

| 项 | 归属 | 现状 |
| :--- | :--- | :--- |
| 静默模式 | 4.9 | 无。`silent` 只在注释里作为普通词出现 |
| 删除树（清空记录） | 4.10 | 无。`resetForRebuild` 是重建目标树，不是清空记录 |
| 版本归档 | 4.10 | 无 |
| 文件变化扫描 | 4.10 | 无 |
| 成本短路 | 4.10 | 无 |
| 模型行为轨全套 | 4.6 | 无。`repeat_rate` / `error_streak` / `alternating_loop` / `monologue` 一个都没有 |
| 校准全套 | 4.4 | 无。分层审计、`inclusionProbability`、Platt scaling 均无 |
| S1 语义漂移 | 4.3 | `s1_semantic` 只在 enum 里，无产生点，`aggregateStep` 不读 |
| 报告按目标聚合 | 4.7 | 无，只按目录聚合 |
| 设置卡：LLM 配置 / 用量 / 立即巡检 / 清空记录 | 4.8 | 均无 |

**确认存在但需注意口径的**：

- 提醒通道：只有 `onHints` 一条路径——巡检发现的东西进提示缓存，下一轮对话可见，不是主动推送。早先的 `schedule.persistentReminders` 已删除：它声明了一个从未实现的主动推送，改它不会有任何效果，留在配置里只会让读配置的人以为存在这个能力。
- 斜杠命令：实际有 4 个（`metacog-init` / `metacog-check` / `metacog-goal` / `metacog-contradiction`）。本节早先写着 `/metacog-init` 不存在，那是错的——它由 `session.ts` 的 `registerInitCommand` 注册。

**已完成但没在早期清单里体现的**（属于 v4 里程碑 A/B/D）：

`metacog_declare_plan`、`metacog_revise_plan`、S3/S2/S5 三个信号、S4 计划匹配（glob 语义已测 38 项边界）、陷入细节检测、进度评估、成就记录、报告「本期完成」小节。

### 4.10 其他工程项

| 功能 | 要点 |
| :--- | :--- |
| 质检规则改造 | 推导输出增加模型自评（是否复述标题、后果是否具体），与硬规则取严；新增目标去重与证据覆盖率 |
| 文件变化扫描 | 维护文件基线，diff 出新增/修改/删除；有变化才调模型，作为 `source: filesystem` 的活动 |
| 删除树（清空记录） | 删除 `.metacog/` 下除 `session/` 外的一切；写一条「此前记录已被清空」的审计；需二次确认 |
| 版本归档 | 树会演化，需里程碑归档：`archive/<projectId>/` 存树快照 + 判定统计，三个触发点（手动、每周、每次确认） |
| 成本短路 | 无新活动、无文件变化、无待复核时，一次模型调用都不发 |
| 提醒通道 | 确认漂移后向会话注入简短提示，只对已确认的发 |
| 判定窗口统一 | 手动用「上次汇报以来」，定时用「最近 N 分钟」，两套口径需统一到检查点 |
| 归档工具合并 | 信号归档与活动流归档合成一个工具，默认只清信号；清活动流需显式指定并提示「历史判定将失去活动原文」 |
| 活动流归档通道 | 当前只有信号有归档入口，120 条注入块噪音仍在 `activities/` 里 |
| 巡检自启动 | 巡检依赖先调用过工具才能注册项目，刷新插件后 `monitored` 清空，挂机场景下会永久停摆 |

### 4.11 LLM 认知监控（暂缓）

系统已经在监控用户行为了，同一套特征层和判定层可以顺带监控 LLM 本身。用户 2026-10-29 明确说先放一边，记在这里备查。

| 监控对象 | 信号 | 现成参考 |
| :--- | :--- | :--- |
| 工具调用循环 | 同工具同参数反复调用 | OpenHands StuckDetector 的 action-observation loop |
| 错误重试 | 同命令同错误连续，参数未变 | StuckDetector 的 error retry loop |
| 交替循环 | 两组动作结果反复交替 | StuckDetector 的 alternating loop |
| 自述空转 | 连续多条自述，无用户输入也无有效行动 | StuckDetector 的 monologue |
| 上下文失效 | 压缩或窗口错误反复 | StuckDetector 的 context failure loop |
| 无效探索 | 连续只读且无 `verified_progress` | 与 v4 的 S5 信号共用 |
| 成本失控 | 每单位推进的成本超分位 | 需先有成本数据 |

架构上不新建类别：v4 的五信号本来就同时适用于用户活动和 LLM 行为，区别只在监控对象，不需要两套规则集。这一点和 3.5 原先设想的 `monitorCategory` 分轨不同——分轨会重复实现同一套特征。

前置条件：里程碑 A 的 S2/S4/S5 落地并有验证数据。

## 五、明确不做

### 5.1 需要撤销的旧决定

| 旧决定 | 撤销理由 |
| :--- | :--- |
| 判定质量外部校准：不做（不引入人工标注真值） | 与 v3 直接冲突。里程碑 A 的验收就是在试点标注集上对比基线，里程碑 B 的校准与阈值全靠标注。没有标注，`riskScore` 永远停在只保证序关系的状态，`pDrift` 分支不可达 |

### 5.2 仍然不做

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
| 规则自修改 | 风险最高，暂不做 |
| 侧边栏入口 | 不做，只用斜杠命令（设置卡是插件页，不冲突） |
| 会话标题改名 | 保持 `<工作区>·认知监控` |

## 六、环境事实

### 6.1 采集范围

只监控建立了目标树的工作区。当前只有 `dsh临时工作区` 建了已确认的树；`杂活` 有一棵 version 0 的未确认空草稿，不算。

已知局限：活动流只采认知监控会话自己的事件，真实工作发生在其他会话时不会被记录。会话日志在 `~/.dsh/sessions/<workspace>/<session>/session.jsonl.zstd`，多帧 zstd 需逐帧解压（实测一个会话解出 7084 条事件、265 次 `tool/call`）。

### 6.2 数据位置

```
.metacog/
  state/<projectId>.json         树状态（含 projectContext）
  audit/<projectId>.jsonl        哈希链审计，append-only
  activities/<projectId>.jsonl   活动流
  judgments/<projectId>.jsonl    判定队列（pending/confirmed/dismissed）
  signals/<projectId>.jsonl      信号流
  signals-archive/<projectId>/   归档的信号
  observations/<projectId>.jsonl 矛盾强度观察流
  interventions/<projectId>.jsonl 干预卡（append-only，后者覆盖前者）
  reports/<projectId>.jsonl      报告，一行一份
  reports/markdown/              导出的可读版本
  snapshots/<projectId>/         树快照
  checkpoint/<projectId>.json    上次汇报时间
  session/<projectId>.json       绑定的认知监控会话
```

### 6.3 配置要点

`cordis.patch.yml` 里的 `dsh-metacog` 条目：

| 键 | 当前值 | 说明 |
| :--- | :--- | :--- |
| `schedule.checkIntervalMinutes` | 60 | 定时巡检间隔 |
| `thresholds.windowMinutes` | 120 | 判定窗口 |
| `thresholds.repeatThreshold` | 3 | 同类信号重复几次升级 |
| `thresholds.minConfidence` | 0.6 | 低于此置信度不升级 |
| `thresholds.highIntensityThreshold` | 4 | `core_bypass` 判定的强度门槛 |
| `thresholds.staleDaysThreshold` | 7 | 目标多少天无证据算陈旧。不能用 0，`positiveInt` 会拒绝，导致插件整个挂不上 |
| `gate.level3HardBlock` | 未设（默认 false） | 是否真的拦截写工具；关闭时只影子计数 |

里程碑 A/B 会新增 `thetaHintScore` / `thetaCardScore` / `thetaCardProbability` 与损失矩阵参数，届时上表要扩。

### 6.4 当前数据的真实分布

活动 2199 条，判定分布：

| 判定 | 条数 | 观察等级 |
| :--- | :--- | :--- |
| `scope_drift` | 1753 | A 1753 |
| `uncertain` | 334 | B 333、C 1 |
| `exploratory` | 112 | A 112 |
| `aligned` | 0 | — |

按来源：`tool_event` 1721、`user_input` 434、`turn` 35、`manual` 9。

判定候选 791 条：498 条被模型驳回、293 条待复核、0 条确认。

这组数字直接说明两件事：系统从未确认过一次漂移；而 `aligned` 为 0 不是模型判错，是 6 个目标没有可匹配判据（见 4.1）。

### 6.5 已知的数据污染

活动流里 120 条是宿主注入块（`Current runtime context.` / `MNEMON 快照` / `<system-reminder>` / checkpoint 回执等），全部判成 `scope_drift`。最后一条停在 2026-10-28T06:56:45Z，早于重启，此后不再新增。

信号流的 1459 条同类噪音已归档清空。但活动流本身没有归档通道——这 120 条仍在 `activities/` 里。注意两者不同：判定记录的 `activityIds` 指向活动流，清空会让历史判定失去指向对象。
