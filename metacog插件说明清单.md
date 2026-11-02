# dsh-metacog 插件说明清单

审计对象：`metacog/`（包名 `dsh-metacog` v0.1.0）
审计日期：2026-10-30（重构后版本）
审计方式：通读 `src/` 全部 54 个源文件、`scripts/` 50 个脚本、`docs/` 19 份文档、根目录 28 个文件；交叉核对 `package.json` / `tsconfig.json` / profile 接线；实跑 `node scripts/check-build-freshness.mjs` 验证构建产物。全程未修改、未删除任何插件代码。

> 本清单是重构后版本。上一版（重构前）已过期，差异集中在 `src/` 新增 4 个模块、`scripts/` 新增 `_harness.mjs` 与一批 probe、`client.js` 从 88,864 B 扩到 125,925 B。

---

## 一、插件概览

### 1.1 基本信息

| 项 | 值 |
|---|---|
| 包名 | `dsh-metacog` |
| 版本 | `0.1.0`（`private: true`，未发布 registry） |
| 用途 | 项目级元认知监控：目标树/矛盾树建模、会话活动采集、漂移判定、日报/周报/月报、设置卡 |
| 运行环境 | Node.js `>=22.5`；纯 ESM（`type: module`）；宿主 DeepSeek Harness（Cordis 插件框架） |
| 入口文件 | `lib/index.js`（`main` 与 `exports["."]`） |
| 前端入口 | `client.js`（`exports["./client"]`，`dsh.client.platform = "web"`） |
| 构建入口 | `src/index.ts` → `tsc -p tsconfig.json` → `lib/` |
| 真实目录 | `D:\文档\dsh临时工作区\metacog` |
| 挂载方式 | 目录 junction：`C:\Users\30759\.dsh\profiles\desktop\node_modules\dsh-metacog` → 该目录 |
| 版本控制 | **无**。不是 git 仓库，工作区 `git ls-files metacog` 返回 0，`git status` 显示 `?? metacog/` |
| 备份现状 | **无可用备份**。`重构报告.md` 提到的 `_backup/metacog-20261030-pre-refactor` 当前不存在 |

### 1.2 规模总览（实测）

| 目录 | 文件数 | 体积 |
|---|---:|---:|
| `src/` | 54 | 0.91 MB |
| `lib/` | 108 | 1.13 MB |
| `test/` | 47 | 0.53 MB |
| `scripts/` | 50 | 0.30 MB |
| `docs/` | 19 | 0.28 MB |
| `node_modules/` | 1422 | 31.95 MB |
| `.npm-cache/` | 37 | 35.99 MB |
| `_pylibs/` | 125 | 3.72 MB |
| `.metacog/` | 6 | 0.01 MB |
| 根目录文件 | 28 | 0.51 MB |
| **合计** | **1896** | **75.31 MB** |

对比重构前：`src` 50→54、`lib` 100→108、`test` 37→47、`scripts` 46→50。

### 1.3 依赖项

运行时依赖：

| 包 | 声明 | 实际安装 | 用途 | 引用点 |
|---|---|---|---|---|
| `zod` | `^4.6.7` | 4.6.7 | 全部配置与数据结构 schema 校验 | `lib/config.js`、`lib/data/*.js`、`lib/analysis/derive.js` |
| `yaml` | `^2.9.1` | 2.9.1 | 读写 `~/.dsh/metacog-overrides.yml` | `lib/settings.js` |

> 本地 `node_modules/zod` 是 4.6.7，profile 公共目录里是 3.25.76，API 签名不兼容（`z.enum([...])`、`z.discriminatedUnion('status',[...])` 按 v4 书写）。父级目录链 `D:\文档\dsh临时工作区\node_modules`、`D:\文档\node_modules`、`D:\node_modules` 均不存在，本地 `node_modules` 是唯一解析目标。

开发依赖：`typescript ^5.9.3`（5.9.3，仅构建期）、`@types/node ^26.6.6`（26.6.6，仅编译期）。
同伴依赖：`@deepseek-ai/cordis ^4.0.1`（由宿主提供）。

外部运行时依赖（非 npm）：`python` 或 `python3` + Python 包 `pypdf`。仅 `src/evidence/pdf.ts` 使用。

### 1.4 宿主接线

- profile 补丁：`C:\Users\30759\.dsh\profiles\desktop\cordis.patch.yml` 第 894 行 `- id: dsh-metacog / name: dsh-metacog`
- config 覆盖：`schedule.checkIntervalMinutes: 60`；`thresholds.{windowMinutes:120, repeatThreshold:3, minConfidence:0.6, highIntensityThreshold:4, staleDaysThreshold:7}`
- 插件自带 bundle 补丁：`cordis.patch.yml`（449 B），`insert` 一条 `{ id: dsh-metacog, name: dsh-metacog }`

---

## 二、系统架构

### 2.1 分层（`src/index.ts` 文件头已修正为实际结构）

| 层 | 实际目录 | 职责 |
|---|---|---|
| 数据层 | `src/data/` | 持久化、CAS、快照、哈希链审计 |
| 分析层 | `src/analysis/` | 漂移规则、趋势、升级状态机、评分、派生、修订、合并、校准、审计抽样 |
| 证据层 | `src/evidence/` | 材料发现、候选树扫描、文件指纹、OOXML/PDF 抽取 |
| 工具层 | `src/tools/` | 18 个工具定义 |
| 命令层 | `src/commands/` | 斜杠命令解析器 |
| 根级模块 | `src/*.ts` | 装配、宿主契约、配置、采集、巡检、闸门、HTTP、报告、会话、协议、治理 |

> 重构前文件头写的 `interaction/` 目录**并不存在**，重构时已改正。

### 2.2 目录结构

```
metacog/
├── package.json            # 4,018 B，加载器解析入口的唯一依据
├── package-lock.json       # 3,951 B
├── tsconfig.json           # 592 B
├── cordis.patch.yml        # 449 B，被 dsh.bundle.patch 指向
├── client.js               # 125,925 B，Web 设置卡入口，手写 JS 无构建
├── metacog插件说明清单.md    # 本文件
├── metacog清理计划.md        # 配套清理计划
├── 重构报告.md              # 2026-10-30 重构记录（14,569 B）
├── 评审与重构计划.md         # 重构前的评审计划（32,099 B）
├── src/                    # 54 文件 / 0.91 MB
│   ├── index.ts            # 装配器，1,809 行
│   ├── host.ts             # 宿主契约类型层（纯类型，零运行时）
│   ├── config.ts / settings.ts
│   ├── collect.ts / schedule.ts / gate.ts
│   ├── api.ts              # 1,196 行，16 个端点
│   ├── report.ts           # 1,592 行
│   ├── session.ts / protocol.ts / governance.ts
│   ├── data/     (3)       # types / store / signals
│   ├── analysis/ (17)      # 含新增 audit / calibrate / sections / signals/behaviour
│   ├── evidence/ (5)
│   ├── tools/    (13)
│   └── commands/ (1)
├── lib/                    # 108 文件 / 1.13 MB（54 个 .js + 54 个 .d.ts）
├── test/                   # 47 个测试，全部被 npm scripts 引用
├── scripts/                # 50 个脚本（4 个 npm 引用 / 8 个文档引用 / 38 个其余）
├── docs/                   # 19 份设计/验证文档
├── node_modules/           # 1422 文件 / 31.95 MB
├── .npm-cache/             # 37 文件 / 35.99 MB
├── _pylibs/                # 125 文件 / 3.72 MB（pypdf 副本）
└── .metacog/               # 6 文件，运行时数据目录（当前为验证夹具）
```

### 2.3 核心组件

| 组件 | 文件 | 职责 |
|---|---|---|
| 装配器 | `src/index.ts` | `apply(ctx, rawConfig)` 同步装配；单一 `ctx.effect` 反序 teardown；注册 18 工具、4 斜杠命令、1 全局 prompt 段、1 HTTP 前缀路由 |
| 宿主契约 | `src/host.ts` | 37 个纯类型导出（34 interface + 3 type） |
| 配置 | `src/config.ts` | 7 个子 schema，28 个叶子字段；未知键剥离，已知键非法硬报错 |
| 配置覆盖 | `src/settings.ts` | 读写 `~/.dsh/metacog-overrides.yml`，12 个白名单可编辑点路径 |
| 数据层 | `src/data/store.ts` | `MetacogStore`：CAS 提交、版本快照、append-only 流、sha256 哈希链审计，磁盘布局 **17 个目录** |
| 信号数学 | `src/data/signals.ts` | 五信号 + behaviour 轨道声明、三维度加权聚合、EMA、阈值 |
| 判定 | `src/analysis/alignment.ts` | 五条优先规则判定活动与目标树的对齐 |
| 检测 | `src/analysis/drift.ts` | 六个确定性检测器 |
| 升级 | `src/analysis/escalation.ts` | draft → Level 0/1/2/3 + 开卡决策 |
| 编排 | `src/analysis/service.ts` | 去重→判定→检测→升级→落库→趋势 |
| 校准 | `src/analysis/calibrate.ts` | **新增**：判定记录 → 可靠性曲线拟合（`MIN_CALIBRATION_SAMPLES = 30`、`MIN_PER_CLASS = 10`） |
| 审计抽样 | `src/analysis/audit.ts` | **新增**：分层抽样计算审计覆盖率 |
| 报告章节 | `src/analysis/sections.ts` | **新增**：`undecidableReasons` / `auditCoverage` / `thresholdProvenance` |
| 行为轨道 | `src/analysis/signals/behaviour.ts` | **新增但未接线**（见 2.5） |
| 采集 | `src/collect.ts` | 订阅 `session/event`，五类事件折成 `ActivityRecord` |
| 巡检 | `src/schedule.ts` | `ctx.timer.interval` 周期跑 `runStaticCheck` |
| 闸门 | `src/gate.ts` | 挂 `tools/pre-execute`，默认 shadow |
| 治理 | `src/governance.ts` | `GateError` + 结构不变式 + L0/core 确认要求 |
| 报告 | `src/report.ts` | 1,592 行；daily/weekly/monthly 报告 + `generateWorkspaceReport` + 提示块 |
| HTTP | `src/api.ts` | 1,196 行；16 个端点；含 `openInShell`（Windows 走 WMI） |
| 会话 | `src/session.ts` | 认知监控专用会话 find/create/restore/投递 |
| 协议 | `src/protocol.ts` | 会话级 prompt 段 + 工具白名单 |
| 前端 | `client.js` | 三标签页设置卡 |

### 2.4 数据流

```
宿主 session/event
      ▼
src/collect.ts（ctx.on('session/event')）
      │ ActivityRecord
      ▼
src/analysis/service.ts  runActivityCheck()
      │ ① 去重 → ② judgeAlignment → ③ appendActivity
      │ ④ detect*（六检测器）→ ⑤ decideEscalation → ⑥ recomputeTouchedTrends
      ▼
data/store.ts（CAS + 快照 + 哈希链审计）
      ├──▶ report.ts   renderPromptBlock → systemPrompt.section
      ├──▶ report.ts   generateReport / generateWorkspaceReport
      ├──▶ api.ts      /api/metacog/*（16 个）→ client.js
      ├──▶ schedule.ts 周期 sweep → runStaticCheck（mayEscalate:false）
      └──▶ gate.ts     tools/pre-execute → 依据 pending+level3 决定 deny
```

单轮评分（与漂移判定并联）：

```
analysis/score.ts  scoreTurn()
      │ scores = [novelty, classScore, planScore, progressScore]   ← 见 2.5
      ▼
data/signals.ts  aggregateStep → advanceEma → advanceSignalState → decideLevelFromScore（0/1/2）
```

### 2.5 一处需要注意的实现现状：behaviour 轨道未接线

`src/analysis/signals/behaviour.ts`（188 行）导出了完整的四个行为检测器：`scoreRepeatRate`、`scoreErrorStreak`、`scoreAlternatingLoop`、`scoreMonologue`，以及 `aggregateBehaviour`。

同时 `src/data/signals.ts` 已经为它铺好了数据契约：

- `AggregationDimensionSchema` 含 `'behaviour'`
- `DIMENSION_SIGNALS.behaviour = ['b_repeat','b_error_streak','b_alternating','b_monologue']`
- `DIMENSION_WEIGHTS.behaviour = 0`（注释说明"零是设计，不是占位"）
- `behaviourScore` 字段

但**计算函数从未被调用**。`src/analysis/score.ts:128` 的组装是：

```ts
const scores = [novelty, classScore, planScore.score, progressScore]
```

四元组里没有 behaviour 信号。全 `src/` 内除 `behaviour.ts` 自身外，`behaviour` 的命中全部是 `data/signals.ts` 里的**声明与统计逻辑**（`aggregateStep` 会把这个维度排掉再算加权平均），没有任何一处产生 behaviour 维度的输入。

`test/behaviour-track.test.mjs` 直接 `import('analysis/signals/behaviour.js')` 测试这四个函数，所以模块本身是健康的、被测试覆盖的，只是还没有接进生产链路。

写在这里是因为它影响对"功能列表"的理解：behaviour 轨道目前是**已实现、已测试、已声明，但未启用**的状态。

---

## 三、系统功能

### 3.1 工具（18 个）

| 工具名 | 文件 | 作用 |
|---|---|---|
| `goal_tree_init` | `tools/tree-lifecycle.ts` | 扫描项目，派生子代理生成候选目标树与矛盾树 |
| `metacog_scan` | `tools/scan.ts` | 只读列出派生器会考虑的文件 |
| `metacog_read_document` | `tools/document.ts` | 读 docx/xlsx/pptx/pdf（OOXML 自解析，PDF 走 Python+pypdf） |
| `goal_tree_confirm` | `tools/tree-lifecycle.ts` | 候选树转确认基准，产出 version 1 + 首个快照 + genesis 审计项 |
| `goal_tree_view` | `tools/tree-lifecycle.ts` | 读取目标树与矛盾树，含版本、确认状态、矛盾强度/趋势、审计链校验 |
| `goal_tree_edit` | `tools/tree-edit.ts` | CAS 版本控制下修改目标节点 |
| `contradiction_tree_edit` | `tools/tree-edit.ts` | 修改矛盾节点；改已确认 core 需 `userConfirmed` + reason |
| `check_drift` | `tools/drift.ts` | 判定活动是否仍服务已确认目标树 |
| `contradiction_observe` | `tools/drift.ts` | 记录矛盾强度读数并返回趋势（唯一能推动趋势的入口） |
| `resolve_intervention` | `tools/drift.ts` | 记录用户对 Level 2/3 干预卡的决定 |
| `metacog_declare_plan` | `tools/plan.ts` | 声明本会话计划，`allowedTools` 是漂移检测依据 |
| `metacog_revise_plan` | `tools/plan.ts` | 修改已声明计划 |
| `generate_report` | `tools/report.ts` | 生成 daily/weekly/monthly 报告 |
| `metacog_revise` | `tools/revise.ts` | 记录项目意图变更 |
| `metacog_archive` | `tools/archive.ts` | 归档信号流到带日期文件并清空 |
| `metacog_purge` | `tools/purge.ts` | 永久删除本项目监控记录，需手打 projectId |
| `metacog_archive_milestone` | `tools/milestone.ts` | 写入里程碑记录（目标树 + 判定统计） |
| `metacog_merge_tree` | `tools/merge.ts` | 合并候选树入主树，默认只预览 |

### 3.2 斜杠命令（4 个）

`/metacog-init`（`session.ts`）、`/metacog-check`、`/metacog-goal`、`/metacog-contradiction`（后三个在 `index.ts`，解析器在 `commands/edit.ts`）。

### 3.3 后台子系统

| 子系统 | 安装点 | 默认状态 |
|---|---|---|
| 事件采集器 | `installCollector` | 无条件，订阅 `session/event` |
| 周期巡检 | `installScheduler` | 需 `schedule.enabled=true` 且宿主有 `timer`；间隔 `checkIntervalMinutes×60000`（默认 25，profile 覆盖 60） |
| Level 3 硬闸门 | `installGate` | 默认 `gate.level3HardBlock=false` → shadow |
| HTTP 路由 | `installApi` | 无条件（`webServer` 是硬依赖） |
| 全局提示块 | `systemPrompt.section`（order 900） | 每轮注入 |
| 会话协议段 | `applyMetacogScope`（order 860） | 仅认知监控会话创建时 |

### 3.4 设置卡与 API（16 个端点，前后端完全对应）

| 端点 | 方法 | client.js 调用 | api.ts 注册 |
|---|---|---|---|
| `/api/metacog/projects` | GET | 是 | 是 |
| `/api/metacog/reports` | GET | 是 | 是 |
| `/api/metacog/report` | GET | 是 | 是 |
| `/api/metacog/report` | POST | 是 | 是 |
| `/api/metacog/report/open` | POST | 是 | 是 |
| `/api/metacog/signals/archive` | POST | 是 | 是 |
| `/api/metacog/usage` | GET | 是 | 是 |
| `/api/metacog/llm` | GET | 是 | 是 |
| `/api/metacog/sweep` | POST | 是 | 是 |
| `/api/metacog/milestone` | POST | 是 | 是 |
| `/api/metacog/milestone` | GET | 是 | 是 |
| `/api/metacog/settings` | GET | 是 | 是 |
| `/api/metacog/settings` | POST | 是 | 是 |
| `/api/metacog/purge` | POST | 是 | 是 |
| `/api/metacog/intervention` | POST | 是 | 是 |
| `/api/metacog/tree/edit` | POST | 是 | 是 |

> 重构新增 4 个端点：`report/open`、`intervention`、`tree/edit`，以及 `milestone` 的 GET 变体。`client.js` 从 88,864 B 扩到 125,925 B，对应这些新交互。

---

## 四、架构与功能的实现方式

### 4.1 挂载与卸载

`apply(ctx, rawConfig)` 同步执行；`resolveConfig` 合并「卡片覆盖文件」>「profile config」；`enabled === false` 直接 return；`detectCapabilities` 探测 6 个可选服务；单一 `ctx.effect` 反序 teardown；`mount.claim()` 若发生在已 teardown 之后则立刻执行 disposer。

`ctx.tools === undefined` 时抛错拒绝挂载，不做半残废运行。

### 4.2 依赖注入

```ts
export const inject = ['tools', 'webServer']
```

只声明两个硬依赖。Cordis 对 `inject` 每个名字都做 gate，任一缺失整个插件 inactive。`webServer` 是刻意例外——未声明的服务不会被 link 进 context，`ctx.get('webServer')` 返回 `undefined`，设置卡路由会静默不注册。其余 6 个能力经 `ctx.get` feature-detect。

### 4.3 持久化

存储位置 `<projectRoot>/<storageSubdir>/`，默认 `.metacog`。磁盘布局经重构核对为 **17 个目录**（原注释只列 8 个，且 `interventions` 原写 `.json` 实际是 `.jsonl`）。

写入原语 `writeFileAtomic`：同目录 `<path>.<uuid>.tmp` + `rename`。重构时把 `writeSignalState` 也改为复用它，临时文件名从固定 `.tmp` 改为带 `randomUUID()`，并发写不再互相踩踏。

CAS 双保险：进程内 `withProjectLock` 串行队列 + 磁盘 `expectedVersion` 比对。提交顺序：先 append 审计 → 再写 snapshot → 最后写 state。

审计链：`canonicalize` 键排序去 undefined → `sha256`，`prevHash` 链到 `GENESIS_HASH`。`verifyAuditChain` 三重校验。

### 4.4 漂移判定（两套分级分开理解）

| | 分数机 | 升级机 |
|---|---|---|
| 实现 | `data/signals.ts: decideLevelFromScore` | `analysis/escalation.ts: decideEscalation` |
| 值域 | `0 \| 1 \| 2` | `0 \| 1 \| 2 \| 3` |
| 唯一 L3 | 不存在 | `core_bypass` ∧ 重复达阈值 ∧ `intensity >= 4` ∧ 无 pending |

两者由 `tools/drift.ts` 组装 `DriftInput` 后并联驱动，不是上下游关系。

升级机判据：闸门（grade 非 A → 0；confidence < minConfidence → 0）→ L3 → L3 降级（有 pending 则 1）→ L2 → L2 降级 → L1a（contradiction_shift 有关联矛盾）→ L1b（confidence 达标）→ 兜底 0。

`signalClassKey` 把绑定目标纳入键，因此针对不同矛盾的多个错位活动不会累加成一次升级。

### 4.5 评分

| 信号 | 计算 |
|---|---|
| S1 `s1_semantic` | 语义兜底，权重 0 |
| S2 `s2_class` | `1 - Jaccard(baseline, recent)`，历史不足 6 步返回 absent |
| S3 `s3_tool_novel` | 工具是否越出 `allowedTools` |
| S4 `s4_plan_match` | `1 - done/required.length` |
| S5 `s5_progress` | 可验证变更比例；写工具但 `result.ok === false` 计为"看了但没变" |

聚合权重 `{ scope: 0.5, plan: 0.25, progress: 0.25 }`，维度分取成员最大值。`coverage` 只能取 `{0,.25,.5,.75,1}`，是证据覆盖率而非概率。EMA `beta = 0.4`。阈值 `thetaHintScore 0.5`、`thetaCardScore 0.875`、`consecutiveStepsForCard 3`、`coverageFloor 0.4`。

behaviour 维度权重为 0 且当前无输入源（见 2.5）。

### 4.6 事件订阅（全插件 2 处）

`session/event`（`collect.ts`，只观察，handler 全包 try/catch）与 `tools/pre-execute`（`gate.ts`，waterfall 可 deny，异常时 fail-open）。

插件是纯消费者，无 `ctx.provide` / `ctx.set` / `ctx.plugin`。

### 4.7 打开文件的实现（重构重点）

`src/api.ts` 的 `/api/metacog/report/open` 端点负责"在编辑器里打开报告"。这里有一个非显然的实现决策：

Windows 上**不用 `spawn`**，改用 WMI 的 `Win32_Process.Create`。原因写在 `api.ts` 的注释里：

> DSH 把子进程放在 Windows Job Object 里（`dsh-subprocess-local` 在宿主退出时杀整棵树）。用 `spawn` 启动的进程属于该 job，编辑器会在启动器退出瞬间被拆掉。**实测**：每种 `spawn` 变体都启动了 VSCode 却留下零个进程，而同一可执行文件经 WMI 启动留下十一个。

`Win32_Process.Create` 让 WMI 服务去启动进程，父进程变成 `WmiPrvSE.exe` 而非本插件，job 不含它，窗口因此能存活。

`scripts/probe-open-*.mjs`（8 个）与 `probe-spawn-*.mjs`（2 个）就是这次排查留下的证据链：`probe-open-path` 验证引号处理（含 CJK 与空格的路径曾让 Windows 报"找不到文件"），`probe-spawn-attach` 对比四种挂载方式下的进程存活数。

### 4.8 配置项

profile `cordis.patch.yml` 的 `dsh-metacog.config`，可被 `~/.dsh/metacog-overrides.yml` 覆盖。共 28 个叶子字段，分 7 组：顶层（`enabled`、`storageSubdir`）、`thresholds`（5）、`schedule`（3）、`collection`、`signals`（5）、`gate`（`level3HardBlock` + `neverBlocked`）、`quiet`。

设置卡可改 12 个点路径：`enabled`、`quiet.{enabled,keepHardBlock,suppressPromptBlock}`、`gate.level3HardBlock`、`schedule.{enabled,checkIntervalMinutes}`、`thresholds.{windowMinutes,repeatThreshold,minConfidence,highIntensityThreshold,staleDaysThreshold}`。

> 已知差异：服务端 `EDITABLE_PATHS` 有 12 条，设置卡实际渲染 10 个控件，缺 `quiet.suppressPromptBlock` 与 `schedule.enabled`（`重构报告.md` 第五节记录，本轮未修改）。

### 4.9 磁盘副作用位置

| 路径 | 内容 |
|---|---|
| `~/.dsh/metacog-projects.json` | 项目索引 |
| `~/.dsh/metacog-overrides.yml` | 设置卡覆盖值 |
| `<projectRoot>/.metacog/` | 每个被监控项目的数据目录 |
| `<storageRoot>/reports/markdown/...` | 报告可读副本 |

---

## 五、脚本清单

### 5.1 插件根目录（28 个文件）

| 路径 | 大小 | 功能 | 被谁调用 | 运行必需 |
|---|---:|---|---|---|
| `package.json` | 4,018 B | 包清单 | 加载器 | **是** |
| `package-lock.json` | 3,951 B | 依赖锁定 | `npm ci` | 否（建议保留） |
| `tsconfig.json` | 592 B | 编译配置 | `npm run build` | 否（构建必需） |
| `cordis.patch.yml` | 449 B | bundle 补丁 | `dsh.bundle.patch` | **是** |
| `client.js` | 125,925 B | Web 设置卡 | `exports["./client"]` + `dsh.client` | **是** |
| `metacog插件说明清单.md` | 本文件 | 说明清单 | 人工阅读 | 否 |
| `metacog清理计划.md` | 配套 | 清理计划 | 人工阅读 | 否 |
| `重构报告.md` | 14,569 B | 2026-10-30 重构记录 | 人工阅读 | 否 |
| `评审与重构计划.md` | 32,099 B | 重构前的评审计划 | 人工阅读 | 否 |
| `compare.py` | 4,608 B | 一次性：文档去重比对，import `docx,openpyxl,pypdf,pptx`（缺 `pptx`） | 无人 | 否 |
| `derivation-output.json` | 19,470 B | 一次性：推导产物 | 无人 | 否 |
| `derivation-prompt.txt` | 12,095 B | 一次性：推导 prompt | 无人 | 否 |
| `diag-report.mjs` | 2,739 B | 一次性：诊断脚本 | 无人 | 否 |
| `evalcheck.py` | 2,201 B | 一次性：评估核对（缺库） | 无人 | 否 |
| `extract.py` / `extract-out.json` | 4,102 / 61,960 B | 一次性：批量抽取（缺 `docx`/`fitz`） | 无人 | 否 |
| `pdfx.py` / `pdfx-out.json` | 723 / 15,323 B | 一次性：PDF 抽取 | 无人 | 否 |
| `probe-subagents.mjs` | 5,461 B | 一次性：Stage 0 探针（结论已入 `docs/stage-0-subagent-verification.md`） | 无人 | 否 |
| `probe_asar.js` | 295 B | 一次性：asar 搜索 | 无人 | 否 |
| `read-logs.mjs` | 1,225 B | 一次性：日志统计 | 无人 | 否 |
| `read-state.mjs` | 860 B | 一次性：打印目标树 | 无人 | 否 |
| `scan.py` | 3,098 B | 一次性：目录扫描（缺库） | 无人 | 否 |
| `sched-src.txt` | 105,046 B | 一次性：宿主源码纯文本 | 无人 | 否 |
| `tuangfu-output.json` | 30,183 B | 一次性：推导产物 | 无人 | 否 |
| `tuangfu-step1.mjs` | 1,095 B | 一次性：生成 prompt | 无人 | 否 |
| `_gen-prompt.mjs` | 826 B | 一次性：生成推导 prompt | 无人 | 否 |
| `_validate.mjs` | 2,185 B | 一次性：跑质量门 | 无人 | 否 |

### 5.2 `src/`（54 文件，0.91 MB）

见第六节逐文件表。

### 5.3 `lib/`（108 文件，1.13 MB）

- 54 个 `.js` + 54 个 `.d.ts`，与 `src/` 的 54 个 `.ts` 一一对应。
- 实跑 `node scripts/check-build-freshness.mjs`：`sources: 54`，`outputs: all present and newer than their sources`，exit 0。
- `lib/host.js` 是 11 字节 `export {};`：`verbatimModuleSyntax: true` + 纯类型模块，无值可 emit。全 `lib/` 无任何文件 import 它。
- 注意：freshness 只比 mtime，不验证产物正确性（重构报告已验证：篡改内容并调新 mtime 仍 exit 0）。

### 5.4 `scripts/`（50 文件，0.30 MB）

按引用状态分三类。

**A. 被 `package.json` 引用（4 个，19,577 B）**

| 路径 | 大小 | npm script |
|---|---:|---|
| `check-build-freshness.mjs` | 2,664 B | `test:all` 首项、`check:fresh` |
| `check-design-v4.mjs` | 3,589 B | `check:design` |
| `check-doc-vs-code.mjs` | 4,997 B | `check:contract` |
| `mutation-check.mjs` | 8,327 B | `check:mutation` |

**B. 被 `docs/` 引用为数字来源（8 个，48,826 B）**

| 路径 | 大小 | 被哪里引用 |
|---|---:|---|
| `probe-signals.mjs` | 5,490 B | `docs/feature-status.md` |
| `validate-on-own-stream.mjs` | 8,168 B | `docs/post-restart-checklist.md` |
| `validate-s3.mjs` | 5,905 B | `docs/monitoring-design-v4.md` |
| `validate-s3-control.mjs` | 6,023 B | 同上（且引用 `validate-s3.mjs`、`validate-s3-leadtime.mjs`） |
| `validate-s3-leadtime.mjs` | 4,971 B | 同上 |
| `verify-card-api.mjs` | 10,306 B | `docs/feature-status.md` |
| `verify-card-client.mjs` | 4,486 B | 同上 |
| `verify-report.mjs` | 3,924 B | 同上 |

**C. 其余 38 个（243,411 B）**，按性质细分：

| 分组 | 文件 | 判定 |
|---|---|---|
| 共享底座 | `_harness.mjs`（3,825 B） | **必须保留**——16 个 `verify-*` 依赖它 |
| verify 套件（用 `_harness`） | `verify-archive`、`verify-card-api`、`verify-card-client`、`verify-commands`、`verify-contradiction`、`verify-criteria-gate`、`verify-explain`、`verify-intervention`、`verify-intervention-card`、`verify-merge`、`verify-multi-project`、`verify-profile`、`verify-progress`、`verify-rebuild`、`verify-reminder`、`verify-revise-gate`、`verify-window` | 回归套件，路径已改为相对定位（`_harness` 的成果） |
| 其他 verify | `verify-criteria-effect.mjs` | 同族，但未用 `_harness` |
| probe-open（8 个） | `probe-open-assoc`、`-each`、`-handler`、`-launch`、`-path`、`-real`、`-spawn`、`-verify` | 排查「打开文件」的一次性证据链，功能已落地在 `api.ts` |
| probe-spawn（2 个） | `probe-spawn-attach`、`probe-spawn-gui` | 同上 |
| probe 其他 | `probe-card-live`、`probe-criteria-hit`、`probe-embeddings`、`probe-reg-parse`、`probe-intent-drift-cn.py`、`show-card-data`、`diagnose-no-plan` | 需运行中宿主或外部 API，一次性 |
| 数据迁移（2 个） | `migrate-report-files.mjs`、`reorganize-reports.mjs` | 一次性迁移，已完成 |
| 渲染检查 | `render-intervention-card.mjs` | 检查卡片渲染输出 |
| 实机功能测试 | `functional-test-live.mjs` | 对真实项目跑一次干预卡流程 |

> `重构报告.md` 第五节记录：多数 `verify-*.mjs` 在重构前就已失败（依赖过期契约，如调用 `lib/` 中不存在的 `metacog_archive_signals`）。重构只做去重，未修业务断言。

### 5.5 `test/`（47 文件，0.53 MB）

全部被 `package.json` 引用，**零孤儿**。`scripts.test` 引用 27 个，`scripts.test:all` 引用 46 个。

新增：`api-routes`、`audit`、`auto-report`、`behaviour-track`、`calibration`、`cross-workspace`、`intervention-card`、`milestone-read`、`project-index`、`tree-edit-card`。

`stage-f.test.mjs` 的 F9 用例已知 flaky（依赖真实时钟，重构报告有对照实验证明与重构无关）。

### 5.6 `docs/`（19 文件，0.28 MB）

| 路径 | 大小 | 被代码引用 |
|---|---:|---|
| `monitoring-design-v4.md` | 62,729 B | **是**：`check-design-v4.mjs`、`check-doc-vs-code.mjs` 直接 readFile |
| `monitoring-design.md` | 29,047 B | 否 |
| `feature-status.md` | 39,580 B | 否（已按重构实测修正为 18 工具 / 37 测试 / 18 脚本） |
| `design-goal-contradiction.md` | 23,113 B | 否 |
| `api-verification.md` | 11,319 B | 否 |
| `cordis-inject-semantics.md` | 5,217 B | 否 |
| `session-protocol.md` | 3,544 B | 否 |
| `post-restart-checklist.md` | 6,591 B | 否 |
| `derivation-verification.md` | 3,982 B | 否 |
| `diagnosis-real-data.md` | 6,509 B | 否 |
| `stage-0-subagent-verification.md` | 12,422 B | 否 |
| `stage-1-depth.md` | 4,064 B | 否 |
| `stage-c.md` ~ `stage-g.md` | 3,025–5,653 B × 5 | 否 |
| `settings-card-mockup.html` | 43,441 B | 否（`client.js` 注释提及设计来自它） |
| `settings-card-preview.html` | 14,238 B | 否 |

---

## 六、`src/` 逐文件清单

### 6.1 顶层（12 文件）

| 路径 | 行数 | 功能 | 关键导出 | 运行必需 |
|---|---:|---|---|---|
| `src/index.ts` | 1,809 | 装配器 | `name`、`inject`、`apply`、`getMount`、`isDisposableRoot` | **是** |
| `src/host.ts` | 516 | 宿主契约类型 | 37 个纯类型 | 编译期必需 |
| `src/config.ts` | 258 | 配置 schema | `ConfigSchema`、`parseConfig`、`MetacogConfig` | **是** |
| `src/settings.ts` | 202 | 设置卡覆盖 | `overridesPath`、`EDITABLE_PATHS`、`resolveConfig`、`writeOverride` | **是** |
| `src/collect.ts` | 972 | 事件采集 | `installCollector`、`describeToolCall` 等 | **是** |
| `src/schedule.ts` | 339 | 周期巡检 | `installScheduler` | **是** |
| `src/gate.ts` | 175 | L3 硬闸门 | `evaluateCall`、`installGate` | **是** |
| `src/api.ts` | 1,196 | HTTP + 打开文件 | `installApi`、`openInShell`、16 端点 | **是** |
| `src/report.ts` | 1,592 | 报表 + 提示块 | `generateReport`、`generateWorkspaceReport`、`renderPromptBlock` | **是** |
| `src/session.ts` | 661 | 认知监控会话 | `ensureMetacogSession`、`registerInitCommand` | **是** |
| `src/protocol.ts` | 139 | 会话协议 | `applyMetacogScope` | 条件性（仅 `session.ts` 引用） |
| `src/governance.ts` | 455 | 结构治理 | `GateError`、`assertStructuralGate` | 传递必需（全部 `tools/*` + `commands/edit.ts`） |

### 6.2 `src/data/`（3 文件）

| 路径 | 行数 | 关键导出 | 运行必需 |
|---|---:|---|---|
| `data/types.ts` | 558 | 全部 zod schema | **是** |
| `data/store.ts` | 1,451 | `MetacogStore`、`VersionConflictError`、`canonicalize` | **是** |
| `data/signals.ts` | 492 | `aggregateStep`、`advanceEma`、`decideLevelFromScore`、五信号 + behaviour 维度声明 | **是** |

### 6.3 `src/analysis/`（17 文件）

| 路径 | 行数 | 功能 | 被谁引用 | 运行必需 |
|---|---:|---|---|---|
| `analysis/alignment.ts` | 344 | 五规则对齐判定 | `service.ts` | **是** |
| `analysis/drift.ts` | 475 | 六检测器 | `index`、`escalation`、`judgment`、`service`、`tools/drift` | **是** |
| `analysis/escalation.ts` | 286 | draft → Level 0-3 | `service`、`tools/drift` | **是** |
| `analysis/service.ts` | 619 | 分析编排 | `collect`、`index`、`schedule`、`judgment`、`tools/drift` | **是** |
| `analysis/trend.ts` | 171 | 矛盾趋势 | `report`、`drift`、`service`、`tree-lifecycle` | **是** |
| `analysis/progress.ts` | 227 | 停滞评估 | `drift.ts` | **是** |
| `analysis/score.ts` | 145 | 单轮评分 | `index.ts` | **是** |
| `analysis/signals/index.ts` | 241 | S2/S3/S5 + `classifyTool` | `index`、`score` | **是** |
| `analysis/signals/plan.ts` | 202 | S4 计划匹配 | `score.ts` | **是** |
| `analysis/judgment.ts` | 466 | 模型二次意见 | `index.ts` | 条件必需 |
| `analysis/activate.ts` | 153 | 子代理调用封装 | `judgment.ts` | 条件必需 |
| `analysis/revise.ts` | 304 | 用户修订 | `tools/revise.ts` | 条件必需 |
| `analysis/merge.ts` | 318 | 树合并（纯函数） | `tools/merge.ts` | 条件必需 |
| `analysis/audit.ts` | 186 | **新增**：分层抽样 | `sections.ts` | 可选（报告路径） |
| `analysis/calibrate.ts` | 340 | **新增**：可靠性校准 | **仅** `report.ts` | 可选（报告路径） |
| `analysis/sections.ts` | 107 | **新增**：报告章节统计 | **仅** `report.ts` | 可选（报告路径） |
| `analysis/signals/behaviour.ts` | 188 | **新增**：行为轨道 | **src 内零引用**，仅 `test/behaviour-track.test.mjs` import | **未接线**（见 2.5） |

### 6.4 `src/evidence/`（5 文件）

| 路径 | 行数 | 功能 | 外部依赖 | 运行必需 |
|---|---:|---|---|---|
| `evidence/discover.ts` | 539 | 材料发现 + `readerFor` | 无 | **是** |
| `evidence/ooxml.ts` | 296 | OOXML 抽取 | 无（`node:zlib.inflateRawSync` + 手写 ZIP 解析） | 可选 |
| `evidence/pdf.ts` | 191 | PDF 抽取 | **Python + pypdf** | 可选 |
| `evidence/scanner.ts` | 435 | 候选树扫描 | 无 | 可选（`goal_tree_init`） |
| `evidence/changes.ts` | 245 | 文件指纹 | 无 | 条件必需 |

`pdf.ts` 重构时修复了一处错误归类：原先只把 `ENOENT` 判为解释器缺失，沙箱禁止管道式 spawn 时抛的 `EPERM` 会被错归为 `PDF_FAILED`。现在 `EPERM`/`EACCES` 同样计入解释器不可用。

### 6.5 `src/tools/`（13 文件）+ `src/commands/`（1 文件）

| 路径 | 行数 | 提供的工具 | 运行必需 |
|---|---:|---|---|
| `tools/shared.ts` | 323 | `defineMetacogTool`、`loadProject`（重构新增）、`deriveProjectId` | **是** |
| `tools/drift.ts` | 617 | `check_drift`、`contradiction_observe`、`resolve_intervention` | **是** |
| `tools/tree-lifecycle.ts` | 980 | `goal_tree_init`、`goal_tree_confirm`、`goal_tree_view` | 按需 |
| `tools/tree-edit.ts` | 740 | `goal_tree_edit`、`contradiction_tree_edit` | 按需 |
| `tools/plan.ts` | 308 | `metacog_declare_plan`、`metacog_revise_plan` | 按需 |
| `tools/scan.ts` | 132 | `metacog_scan` | 按需 |
| `tools/document.ts` | 152 | `metacog_read_document` | 按需 |
| `tools/archive.ts` | 119 | `metacog_archive` | 按需 |
| `tools/milestone.ts` | 76 | `metacog_archive_milestone` | 按需 |
| `tools/purge.ts` | 293 | `metacog_purge` + `deleteDirectories` | 按需 |
| `tools/report.ts` | 95 | `generate_report` | 按需 |
| `tools/revise.ts` | 211 | `metacog_revise` | 条件必需 |
| `tools/merge.ts` | 348 | `metacog_merge_tree` | 条件必需 |
| `commands/edit.ts` | 369 | `/metacog-goal`、`/metacog-contradiction` 解析器 | **是** |

---

## 七、数据与配置说明

### 7.1 插件目录内 `.metacog/`（6 文件）

| 路径 | 大小 |
|---|---:|
| `.metacog/state/metacog-ea956e7e.json` | 1,624 B |
| `.metacog/snapshots/metacog-ea956e7e/1.json` | 1,699 B |
| `.metacog/signals/metacog-ea956e7e.jsonl` | 985 B |
| `.metacog/reports/metacog-ea956e7e.jsonl` | 706 B |
| `.metacog/activities/metacog-ea956e7e.jsonl` | 680 B |
| `.metacog/audit/metacog-ea956e7e.jsonl` | 581 B |

判定依据：`config.ts` 的 `storageSubdir` 默认 `.metacog`；用插件自身 djb2 算法复算 `deriveProjectId('D:\文档\dsh临时工作区\metacog')` = `metacog-ea956e7e`，与文件名完全一致 → 是「插件把自身目录当被测项目」的产物。内容含「测试项目根目标」「验证插件在真实会话中可用」等夹具文案。`evidence/discover.ts` 与 `changes.ts` 都把 `.metacog` 列入跳过目录。

结论：运行时持久化目录的正常结构 + 联调夹具内容。删掉不影响启动（`store.ts` 有多处 `mkdir recursive`）。

### 7.2 工作区根 `.metacog/`（真实运行数据）

`D:\文档\dsh临时工作区\.metacog\` 含 activities / audit / checkpoint / file-baseline / interventions / judgments / observations / reports / session / signal-state / signals / signals-archive / snapshots / state 与 markdown 报告。**不在插件目录内，本次不触碰。**

### 7.3 缓存

| 路径 | 大小 | 引用情况 |
|---|---:|---|
| `.npm-cache/` | **35.99 MB**（37 文件） | 全树无任何代码/配置引用 `npm-cache` 或 `npm_config_cache` |
| `_pylibs/` | **3.72 MB**（125 文件） | 插件不引用；`pdf.ts` 用内嵌脚本 + 系统 Python。系统 `D:\APP\Python3.12` 已装 pypdf 6.9.2，此副本冗余 |

### 7.4 缺失的基础设施文件

`.git`、`.gitignore`、`README*`、`LICENSE`、`CHANGELOG.md`、`.editorconfig`、`.npmrc`、`.eslintrc`、`.prettierrc`、`pnpm-lock.yaml`、`.gitattributes`、`.nvmrc` **均不存在**。

---

## 八、运行与维护说明

### 8.1 加载

1. 目录需被 profile 的 `node_modules` 解析到。当前是 junction：`C:\Users\30759\.dsh\profiles\desktop\node_modules\dsh-metacog` → `D:\文档\dsh临时工作区\metacog`
2. `package.json` 的 `name` 必须与 `cordis.patch.yml` 里的 `name` 一致（都是 `dsh-metacog`）
3. profile `cordis.patch.yml` 需有 `- id: dsh-metacog / name: dsh-metacog`
4. **必须完全退出 DSH 再启动**——宿主只在启动时加载模块图

> 重要：当前宿主进程的启动时间早于 `lib/` 最新构建时间，因此宿主加载的仍是旧模块图。任何"改完点刷新就生效"的验证都是自欺。

### 8.2 构建与验证

```powershell
cd "D:\文档\dsh临时工作区\metacog"

# L1 静态
node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit   # 期望 exit 0
npm run build                                                       # 期望 exit 0
node scripts/check-build-freshness.mjs                              # 期望 exit 0

# L2 测试（stage-f 有 flake，红了先重跑）
npm test

# L3 一致性
node scripts/check-doc-vs-code.mjs     # 期望 problems: 0
node scripts/check-design-v4.mjs       # 期望 problems: 0
```

### 8.3 注意事项

1. `inject` 只能列硬依赖。塞可选服务进去，缺它时整个插件 inactive 而非降级。
2. `webServer` 是刻意的硬依赖，否则设置卡路由静默不注册。
3. 两套分级不可互换：`decideLevelFromScore` 值域止于 2，L3 唯一来源是 `escalation.ts`。
4. `docs/monitoring-design-v4.md` 不是纯文档，两个 npm script 直接 readFile 它。
5. 删 `node_modules/typescript` 会导致无法重新构建。
6. PDF 功能依赖外部 Python + pypdf；缺失时只有 `metacog_read_document` 读 PDF 不可用，失败是显式错误码而非空串。
7. **本目录不在版本控制下，且当前无备份**。任何清理动作前必须先做文件夹级备份。
8. 改写含中文的源文件必须用 `read`/`edit`/`write` 工具，**不要用 PowerShell 文本管道**（重构期间曾因 `Set-Content` 破坏 UTF-8，导致 20 余个 `Unterminated string literal`）。
9. PowerShell 5.1 的 `Get-Content` 读取含非法 UTF-8 字节的 `~/.dsh/profiles/desktop/*.yml` 会合并行、行号整体偏移。数行号须用 `read` 工具或 Node。

### 8.4 已知问题（继承自 `重构报告.md` 第五节，本轮未修改）

| # | 问题 |
|---|---|
| 1 | `stage-f.test.mjs` 的 F9 用例 flaky，依赖真实时钟，重构前即存在 |
| 2 | 多数 `verify-*.mjs` 在重构前就已失败（依赖过期契约，如调用不存在的 `metacog_archive_signals`） |
| 3 | `check-build-freshness.mjs` 只比 mtime，不验证产物正确性 |
| 4 | `check-design-v4.mjs` 是纯文档措辞检查，对逻辑回归无感 |
| 5 | `src/api.ts` 行覆盖仅 11%，19 条路由几乎零测试，是重构后最需补测试的地方 |
| 6 | `client.js` 缺 2 个可编辑字段控件：`quiet.suppressPromptBlock`、`schedule.enabled` |
| 7 | 工具链陷阱见 8.3 第 9 条 |
