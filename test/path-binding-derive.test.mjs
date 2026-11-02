/**
 * Programmatic L1 ↔ task-directory binding.
 *
 * The model is no longer asked to copy directory names: the scan already knows
 * them. These cases pin the matching policy — containment first, normalized
 * containment next, a shared two-character prefix for the 系庆报告↔系庆ppt
 * case, and "leave it unbound" whenever two directories tie.
 *
 * Run: node test/path-binding-derive.test.mjs   (after `npm run build`)
 */
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (path) => pathToFileURL(join(here, '..', 'lib', path)).href

const { bindL1Paths, reviewDerivation } = await import(lib('analysis/derive.js'))

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

function directory(path, name = path) {
  return {
    path,
    name,
    files: 3,
    bytes: 100,
    categories: { document: 1, result: 1, code: 1, 'raw-data': 0 },
    latestModifiedAt: 0,
    latestFileName: '',
    subdirectories: [],
    topFiles: [],
  }
}

function view(roots) {
  return { level: 1, reason: 'test', roots, rootFiles: 0, totalFiles: 10 }
}

function goal(tempId, title, depth = 1, parentTempId = '', paths = []) {
  return {
    tempId,
    parentTempId,
    depth,
    title,
    description: '',
    derivation: '测试',
    evidence: ['README.md'],
    successCriteria: [],
    relevantActivities: [],
    allowedMethods: [],
    paths,
    deadline: '',
    confidence: 0.8,
    alternative: '',
    status: 'active',
    statusBasis: 'deliverable',
    statusEvidence: 'README.md',
  }
}

// --------------------------------------------------------------- matching
console.log('\n[bind] containment and normalization')
{
  const dirs = view([directory('系庆ppt', '系庆ppt'), directory('2026省会换届', '2026省会换届'), directory('教材编写', '教材编写')])
  const result = bindL1Paths(
    [
      goal('g1', '系庆报告'),
      goal('g2', '2026 省会换届'),
      goal('g3', '无关目标'),
    ],
    dirs,
  )
  const byId = new Map(result.goals.map((item) => [item.tempId, item]))
  check('a title sharing a two-character prefix binds', byId.get('g1').paths.join() === '系庆ppt', JSON.stringify(byId.get('g1').paths))
  check('normalized spacing still matches', byId.get('g2').paths.join() === '2026省会换届', JSON.stringify(byId.get('g2').paths))
  check('an unrelated title stays empty', byId.get('g3').paths.length === 0, JSON.stringify(byId.get('g3').paths))
  check('the unmatched title is reported', result.unmatched.includes('无关目标'), JSON.stringify(result.unmatched))
  check('the bound pair is reported', result.bound.some((item) => item.tempId === 'g1' && item.directory === '系庆ppt'), JSON.stringify(result.bound))
}

console.log('\n[bind] a tie is not guessed')
{
  const dirs = view([directory('甲项目', '甲项目'), directory('甲项目', '甲项目')])
  const result = bindL1Paths([goal('g1', '甲项目报告')], dirs)
  check('two equal directories leave the goal unbound', result.goals[0].paths.length === 0, JSON.stringify(result.goals[0].paths))
  check('and the title is reported unmatched', result.unmatched.includes('甲项目报告'), JSON.stringify(result.unmatched))
}

console.log('\n[bind] a model-provided path is trusted')
{
  const dirs = view([directory('系庆ppt', '系庆ppt')])
  const result = bindL1Paths([goal('g1', '系庆报告', 1, '', ['manual/path'])], dirs)
  check('the model path wins', result.goals[0].paths.join() === 'manual/path', JSON.stringify(result.goals[0].paths))
  check('no directory binding is reported for it', !result.bound.some((item) => item.tempId === 'g1'), JSON.stringify(result.bound))
}

console.log('\n[bind] deeper goals inherit the nearest ancestor paths')
{
  const dirs = view([directory('系庆ppt', '系庆ppt')])
  const result = bindL1Paths(
    [
      goal('g1', '系庆报告'),
      goal('g2', '子任务', 2, 'g1'),
      goal('g3', '孙任务', 3, 'g2'),
    ],
    dirs,
  )
  const byId = new Map(result.goals.map((item) => [item.tempId, item]))
  check('the L1 binds', byId.get('g1').paths.join() === '系庆ppt', JSON.stringify(byId.get('g1').paths))
  check('the child inherits it', byId.get('g2').paths.join() === '系庆ppt', JSON.stringify(byId.get('g2').paths))
  check('the grandchild inherits it too', byId.get('g3').paths.join() === '系庆ppt', JSON.stringify(byId.get('g3').paths))
}

console.log('\n[bind] reviewDerivation uses the binding for its open question')
{
  const dirs = view([directory('系庆ppt', '系庆ppt')])
  const raw = {
    evidenceManifest: [],
    goals: [goal('g1', '系庆报告'), goal('g2', '无关目标')],
    contradictions: [],
    projectProfile: { summary: '', stage: '', deliverables: [] },
    noContradictionFound: true,
    openQuestions: [],
  }
  const review = reviewDerivation(
    raw,
    { role: '负责人', intent: '完成', constraints: [], stakeholders: [], projectSummary: '', stage: '', deliverables: [] },
    undefined,
    dirs,
  )
  const bound = review.output.goals.find((item) => item.tempId === 'g1')
  check('the bound goal is not asked about', !review.questions.some((line) => /没有绑定任务目录/.test(line) && /系庆报告/.test(line)), JSON.stringify(review.questions))
  check('the unmatched goal is still asked about', review.questions.some((line) => /没有绑定任务目录/.test(line) && /无关目标/.test(line)), JSON.stringify(review.questions))
  check('the binding survives review', bound.paths.join() === '系庆ppt', JSON.stringify(bound.paths))
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
