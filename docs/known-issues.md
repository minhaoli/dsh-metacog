# 已知问题

已确认、但**有意暂不修复**的缺陷。每条都要能定位到代码、说清现状、说明为什么先不动、以及修的时候哪些断言会翻。

## K1 `core_bypass` 把「没有候选目标」读成「回避」

**位置**：`src/analysis/drift.ts`，`detectCoreBypass()` 内计算 `avoiding` 的 filter（约 L218–L231）。

**现状**：

```ts
const avoiding = activities.filter((activity) => {
  if (!inWindow(activity.timestamp, now, window)) return false
  if (activity.decision === 'aligned' || activity.decision === 'exploratory') return false
  if (activity.decision === 'scope_drift') return true
  return !activity.candidateGoalIds.some((id) => goalIds.has(id))
})
```

最后一行是「**没有**正向指向就算回避」。而紧邻的注释写的是相反的意思：

> `uncertain` records are kept unless they positively point at a goal the contradiction binds, because an unjudged activity cannot be said to avoid anything.

按注释，`uncertain` 只在**指向**被绑定目标时才应被排除；按代码，凡**不指向**的都被算作回避。

**后果**：一条 `decision: 'uncertain'`、`candidateGoalIds: []` 的活动会被计入 `avoiding`；攒够 `thresholds.repeatThreshold`（默认 3）即产出 `core_bypass` 信号，可升至 Level 2 干预卡。「没判出来」被当成「在回避」。

**为什么暂不修**：修正它等于改变升级语义（哪些活动构成回避），需单独评审。改枚举为第五值 `unbound` 时发现此问题，确认它早于 `unbound` 存在，不是那次改动引入的。

**已做的隔离**：`src/analysis/service.ts` 在调用 `detectCoreBypass` 前过滤掉 `decision === 'unbound'` 的活动——「无法归属」不是「回避」的证据。该隔离**只覆盖 `unbound`**，不覆盖 `uncertain`。

**测试固定**：`test/path-alignment.test.mjs` 的 `[known defect]` 段落断言当前行为。修好 K1 时该断言应当翻转——那是刻意的行为变更，不是回归。

**修法参考**：让末行只把正向指向（或 `scope_drift`）当作回避证据，例如在兜底前显式处理 `uncertain`；同步更新上述断言，并复核 `docs/monitoring-design-v4.md` 中 core_bypass 的判据描述。
