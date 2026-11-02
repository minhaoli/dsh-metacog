/**
 * Check the v4 design doc for stale claims left over after the two audits.
 *
 * Each probe names a phrase that SHOULD no longer appear, plus the reason. The
 * point is mechanical: after rewriting prose by hand, the old wording tends to
 * survive in one more paragraph.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const path = join(process.cwd(), 'docs', 'architecture.md')
const text = await readFile(path, 'utf8')
const lines = text.split(/\r?\n/)

/** [label, needle, why it must be gone] */
const stale = [
  ['旧数字 498（作为驳回数）', '498 条驳回', '实测为 249 条驳回'],
  ['旧数字 791', '791 条', '实测为 406 条唯一记录'],
  ['"唯一有基准背书"', '唯一有基准背书的信号', '0.843 那行良性对照 0/60，且是组合成绩'],
  ['"S4 是 F1 最高"', 'S4 是 F1 最高', 'S4 无任何已测成绩'],
  ['把 0.843 挂 S4', 'S4 计划匹配 | 0.35', '权重结构已重排'],
  ['旧阈值 0.3', 'final < 0.3', '改用 0.500'],
  ['"声明越具体越准"', '声明得越具体', '实际是白名单宽严，不是描述粒度'],
  // 第二轮审计发现：把 hard_block_* 的「标记出现次数之和」当成了样本数。
  // 636 + 427 = 1063 是次数，并集只有 805 条。
  ['hard_block 并集算错', '1063 条样本', '并集为 805 条，1063 是两个标记的出现次数之和'],
  ['hard_block 占比算错', '41% 的样本', '并集占比 35.2%'],
  // 第二轮审计发现：modelWhy 字段根本不存在，实为 modelReason。
  ['不存在的字段 modelWhy', 'modelWhy', '字段实为 modelReason'],
  ['旧唯一记录 393', '393 条唯一判定记录', '实测 406 条'],
  ['旧待复核 144', '待复核 144', '实测 157'],
  // drift_step 的定性：原文自我声明 NON-LEAKING，不能说成信息泄漏。
  ['把 drift_step 当泄漏', '本身就是信息泄漏', '原文声明 NON-LEAKING，是评测范围限制'],
  ['drift.ts 行号错', 'drift.ts:207', '注释在 203 行'],
  ['eval.py 行号错', 'eval.py:564', 'declared_plan 在 549-562 与 445'],
  // S3 改造方向曾写反：toolName 已在采集层可得，缺的是落库。
  ['S3 改法写反', '必须先让采集按工具调用粒度输出', 'toolName 已逐调用可得，缺的是落库'],
  ['旧里程碑 A 标题', 'S2 + S4 + S5（零成本信号）', 'A 是 S3+S2+S5 且含采集改造，S4 属 B'],
]

let problems = 0
for (const [label, needle, why] of stale) {
  const hits = []
  lines.forEach((line, index) => {
    if (line.includes(needle)) hits.push(index + 1)
  })
  if (hits.length === 0) {
    console.log(`ok    ${label}`)
    continue
  }
  problems += 1
  console.log(`STALE ${label} @ line ${hits.join(', ')} — ${why}`)
}

/** Phrases the revision added; each should be present. */
const required = [
  '0/60 benign controls survive',
  '高召回、低精度前置过滤器',
  '设计上就不会报警',
  '没有借用它的最优性',
  '自适应与自进化',
  '自我阉割',
  // 覆盖度必须写成「权重和至少 0.50」，不能再宣称只有三个取值、
  // 也不能再宣称等价于「S3 或 S2 可用」——S4+S5 同样过门。
  '覆盖度的取值与其真实含义',
  '计划+推进',
  '第 7 步',
  '两个采集层前置改造',
]

console.log('')
for (const needle of required) {
  console.log(text.includes(needle) ? `ok    ${needle}` : `MISS  ${needle}`)
  if (!text.includes(needle)) problems += 1
}

console.log(`\nlines: ${lines.length}, problems: ${problems}`)
process.exit(problems === 0 ? 0 : 1)
