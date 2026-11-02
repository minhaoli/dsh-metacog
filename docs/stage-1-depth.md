# 阶段 1：层级模型从四档枚举改为深度

## 要解决的问题

旧模型把层级写死成 `z.enum(['L0','L1','L2','L3'])`，126 处代码依赖它。问题不是"四层够不够"，而是**深度是内容的属性，不是设计的常量**：同一个项目粗看两层、细看五层，固定档位要么逼人合并（丢信息），要么逼人拆分（造空节点）。

更直接的缺陷是落库能力：`goal_tree_confirm` 只接受 `l0` 和 `l1`，推导出来的第三层及以下根本存不进去。

## 数据模型

```ts
export const MAX_GOAL_DEPTH = 9
export const GoalDepthSchema = z.number().int().min(0).max(MAX_GOAL_DEPTH)
```

`GoalNode.level` → `GoalNode.depth`，0 为根。`L0`–`L3` 这些名字整体移除，因为它们编码的只是一个树本身就能表达的位置。

节点 id 形如 `G2_<uuid>`，深度留在 id 里，排查时不必再去读字段。

## 迁移

读写分离，两件事各做一件：

| 环节 | 行为 |
| :--- | :--- |
| 读 | `GoalNodeListSchema` 用 preprocess 接受旧的 `level`，按 `LEGACY_LEVEL_DEPTH`（L0→0 … L3→3）补出 `depth`，不写盘 |
| 写 | `store.migrateLegacyTree()` 检测到磁盘上的记录仍是 `level` 格式时，`version` +1、写同版本快照、追加 `migrate_goal_depth` 审计 |

调用点只有一个：`src/index.ts` 里每个工具的 `execute` 包装在调用工具本体之前跑一次迁移。放在这里而不是每个工具里，是因为迁移是记账，任何工具都不该为此负责；失败也只吞进日志，不让一次迁移问题失败整个工具调用。

迁移是幂等的——已经带 `depth` 的项目不会被改动。

## 不变量

`assertGoalTreeShape` 现在要求：

- 恰好一个 `depth === 0`
- 父节点存在，且 `parent.depth < node.depth`（**不再要求相邻**）
- 非零深度的节点必须有父
- 无环

相邻约束删掉的理由：真实推导经常跨层，强制相邻只会逼出凑数的中间节点。跨层的依据写进 `derivation`，由模型负责解释，程序只检查方向上成立。

`goal_tree_confirm` 落库前现在也会调用这个校验——以前它只被 `goal_tree_edit` 用，确认路径完全没检查过。

## 工具契约

`goal_tree_confirm`：

- `l1[]` 换成 `goals[]`，每项可带 `depth` 与 `parentRef`
- `depth` 省略时按 1 处理。只有"直接挂在根下"这一层不需要声明，因为父节点是唯一的；更深必须写
- `depth > 1` 而缺 `parentRef` → `PARENT_REQUIRED`
- `parentRef` 指向本次调用中不存在的目标 → `UNKNOWN_GOAL_REF`

`goal_tree_edit` 的 `creates[]`：`level: 'L1'|'L2'|'L3'` → `depth: number`。

错误码保持不变（`L0_CONFIRMATION_REQUIRED`、`L1_REASON_REQUIRED`），只把文案改成 root goal / depth-1 strategic goal：这些码是审计与测试依赖的接口，改名不值得。

## 展示与提示词

- 月报的"本月 L0 变更" → "本月根目标变更"，"L1 存活率" → "第 1 层存活率"
- 对齐判定的候选列表按 `depth` 升序，不再按枚举序号
- 日报的目标行：`根目标` / `第 N 层`
- 推导提示词补上 §2.4 的三条软约束：depth 0 唯一；相邻深度粒度大致均匀；没有子节点的目标其 `successCriteria` 必须可验证

## 验收

`test/depth.test.mjs`，30 项：

- 五层树能确认并原样读回，父子关系正确
- 跨层（depth 1 → depth 4）被接受
- `depth` 省略默认 1
- 缺 `parentRef`、未知 `parentRef`、超上限、子不深于父，各自被对应错误码拒绝
- 树形不变量的六个方向（双根、非单调、缺父、孤儿、跨层合法、成环）
- 旧格式状态能打开、版本 +1、`migrate_goal_depth` 入链、审计链仍完整、重复调用不重复迁移

全量回归：768 passed, 0 failed。

## 没有做的

`src/evidence/scanner.ts` 仍在产出 `L0 candidate:` 这类文案。它是按 README 标题猜目标的旧路径，推导改成模型阅读后已无工具调用它，属于待清理的死代码，不在本阶段范围内。
