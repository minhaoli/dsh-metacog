/**
 * Stage 4 acceptance: the derivation quality gates.
 *
 * These are the rules that keep a derivation from degenerating into "the document
 * headings are the goals". They were verified by hand against the compiled output
 * first; this file keeps them verified.
 *
 * Run: node test/quality-gates.test.mjs
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const deriveUrl = pathToFileURL(join(here, '..', 'lib', 'analysis', 'derive.js')).href

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
    return
  }
  failed += 1
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` -- ${detail}`}`)
}

const { reviewDerivation, contradictionRejection, looksLikeTranscription, isGenericTradeoff } =
  await import(deriveUrl)
const goal = (over) => ({
  tempId: 'g1',
  parentTempId: '',
  depth: 0,
  title: '让监控结论可被第三方复核',
  derivation: 'README.md 的验收段要求每条判断都能指回具体证据',
  evidence: ['README.md'],
  confidence: 0.5,
  ...over,
})

const output = (over) => ({
  evidenceManifest: [{ path: 'README.md', why: '核心意图', useful: true }],
  goals: [goal()],
  contradictions: [],
  noContradictionFound: true,
  openQuestions: [],
  ...over,
})

const contradiction = (over) => ({
  tempId: 'c1',
  title: '算力预算与实验规模',
  poleA: '算力预算',
  poleB: '实验规模',
  constraintKind: 'budget',
  blocksGoalTempIds: ['g1'],
  consequence: '预算一旦超支，第三轮实验无法启动，样本量达不到审稿要求',
  evidence: ['README.md'],
  ...over,
})

console.log('\n=== Q1: 标题转录 ===')
{
  // 关键回归：带 evidence 不再能豁免转录检测。真实推导永远带 evidence，
  // 旧逻辑下这条规则实际上从不触发。
  check(
    '标题被复述且带 evidence 仍判为转录',
    looksLikeTranscription('数据集必须支持审稿人复现', '数据集必须支持审稿人复现', ['README.md']) === true,
  )
  check(
    '标题被复述且无 evidence 判为转录',
    looksLikeTranscription('数据集必须支持审稿人复现', '数据集必须支持审稿人复现', []) === true,
  )
  check(
    '推导只是标题的延伸仍判为转录',
    looksLikeTranscription('数据集必须支持审稿人复现', '数据集必须支持审稿人复现。', ['README.md']) === true,
  )
  check(
    '推导在标题之外给出实质解释则不判转录',
    looksLikeTranscription(
      '数据集必须支持审稿人复现',
      '数据集必须支持审稿人复现，因为 README 的验收段要求第三方拿到同一份数据能跑出同一张图，' +
        '而当前仓库里只有清洗后的汇总表，原始试次已经丢失。',
      ['README.md'],
    ) === false,
  )
  check(
    '空推导判为转录',
    looksLikeTranscription('任意标题', '   ', []) === true,
  )

  const review = reviewDerivation(
    output({
      goals: [goal({ title: '数据集必须支持审稿人复现', derivation: '数据集必须支持审稿人复现' })],
    }),
  )
  check('review 记录 LIKELY_TRANSCRIPTION', review.rejections.some((r) => r.code === 'LIKELY_TRANSCRIPTION'))
  check('转录目标被降级', review.capped.some((c) => c.reason === 'LIKELY_TRANSCRIPTION'))
  check('转录目标置信度被压到 0.4 以下', review.output.goals[0].confidence <= 0.4, String(review.output.goals[0].confidence))
}

console.log('\n=== Q2: 四条矛盾拒收规则 ===')
{
  check('无证据 → EVIDENCE_REQUIRED', contradictionRejection(contradiction({ evidence: [] })) === 'EVIDENCE_REQUIRED')
  check(
    '后果太虚 → CONSEQUENCE_TOO_VAGUE',
    contradictionRejection(contradiction({ consequence: '两边都重要' })) === 'CONSEQUENCE_TOO_VAGUE',
  )
  check(
    '未指向目标 → MUST_BLOCK_A_GOAL',
    contradictionRejection(contradiction({ blocksGoalTempIds: [] })) === 'MUST_BLOCK_A_GOAL',
  )
  check(
    '泛泛对立 → GENERIC_TRADEOFF',
    contradictionRejection(contradiction({ poleA: '交付速度', poleB: '打磨质量' })) === 'GENERIC_TRADEOFF',
  )
  check('合格矛盾返回 undefined', contradictionRejection(contradiction()) === undefined)
  check('交付速度 vs 打磨质量被判泛泛', isGenericTradeoff('交付速度', '打磨质量') === true)
  check('具体对立不被误判', isGenericTradeoff('算力预算', '实验规模') === false)
}

console.log('\n=== Q3: 拒收后仍留下追问 ===')
{
  const review = reviewDerivation(
    output({ contradictions: [contradiction({ evidence: [] })], noContradictionFound: false }),
  )
  check('被拒的矛盾不进树', review.output.contradictions.length === 0)
  check('拒绝被记录', review.rejections.length === 1)
  check('转成 openQuestion 交给用户', review.questions.length >= 1, JSON.stringify(review.questions))
  check(
    '全部被拒时 noContradictionFound 改回 true',
    review.output.noContradictionFound === true,
  )
}

console.log('\n=== Q4: 合法空结果不被惩罚 ===')
{
  const review = reviewDerivation(output({ noContradictionFound: true, contradictions: [] }))
  check('无矛盾是合法结果', review.rejections.length === 0)
  check('没有伪造追问', review.questions.length === 0)
  check('目标照常采纳', review.output.goals.length === 1)
}

console.log(`\n=== Quality 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
