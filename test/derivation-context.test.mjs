/**
 * F5: derivation must see how many tasks the workspace holds, and how far along
 * each one is.
 *
 * The failure this file guards against is concrete and was observed on a real
 * workspace: seven task directories, five derived goals, and two entire
 * directories — one of them 118 files — never mentioned. The root cause was not
 * a bad model; it was an input that never said "there are five tasks here".
 *
 * Four claims are defended:
 *
 *   1. the directory view is decided by counts, not by a fixed depth;
 *   2. a derivation that cites a path or a count is structural reasoning, not
 *      transcription — while an echoed document heading is still refused;
 *   3. a task-level status needs evidence, and "no evidence" is stated rather
 *      than silently rendered as draft;
 *   4. when the session engine is missing, the prompt says so in words.
 *
 * Run: node test/derivation-context.test.mjs   (after `npm run build`)
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (path) => pathToFileURL(join(here, '..', 'lib', path)).href

const {
  renderTaskDirectories,
  taskDirectoryView,
} = await import(lib('evidence/discover.js'))
const {
  DerivationOutputSchema,
  buildDerivationPrompt,
  looksLikeTranscription,
  renderSessionEvidence,
  reviewDerivation,
} = await import(lib('analysis/derive.js'))

let passed = 0
let failed = 0
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
    return
  }
  failed += 1
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` -- ${String(detail).slice(0, 700)}`}`)
}

const DAY = 86_400_000
const at = (iso) => Date.parse(iso)
const file = (path, category, bytes, iso) => ({ path, category, bytes, modifiedAt: at(iso) })
const scanOf = (files) => ({
  files,
  skippedDirs: [],
  truncated: 0,
  seen: files.length,
  warnings: [],
})

const CONTEXT = {
  role: '研究者',
  intent: '把几件并行的任务推进到可交付',
  constraints: [],
  stakeholders: [],
  projectSummary: '',
  stage: '',
  deliverables: [],
}

try {
  console.log('\n[directories] top-level directories are the tasks, with counts')

  const workspace = scanOf([
    file('系庆ppt/定稿/系庆PPT定稿v12.pptx', 'document', 4_000_000, '2026-09-20'),
    file('系庆ppt/素材/节目单.docx', 'document', 100_000, '2026-09-18'),
    file('系庆ppt/素材/照片.png', 'raw-data', 800_000, '2026-09-01'),
    file('人智协作：工程心理学的途径/论文/初稿.docx', 'document', 300_000, '2026-08-30'),
    file('人智协作：工程心理学的途径/论文/定稿.docx', 'document', 320_000, '2026-09-25'),
    file('人智协作：工程心理学的途径/data/trials.csv', 'raw-data', 2_000_000, '2026-07-01'),
    file('2026省会换届/方案/方案.md', 'document', 20_000, '2026-06-01'),
    file('萌老师要求帮忙事项/清单.md', 'document', 5_000, '2026-09-10'),
    file('实验心理学修订/修订说明.md', 'document', 6_000, '2026-05-01'),
    file('_work/scratch.md', 'document', 100, '2026-09-30'),
    file('_tmp_charter/x.md', 'document', 100, '2026-09-30'),
    file('.metacog/state.json', 'raw-data', 100, '2026-09-30'),
    file('node_modules/pkg/index.js', 'code', 100, '2026-09-30'),
    file('README.md', 'document', 500, '2026-09-30'),
  ])
  const view = taskDirectoryView(workspace)
  const names = view.roots.map((root) => root.name)

  check('the level is the top one when several directories exist', view.level === 1, view.reason)
  check(
    'every real task directory is present',
    ['系庆ppt', '人智协作：工程心理学的途径', '2026省会换届', '萌老师要求帮忙事项', '实验心理学修订'].every(
      (name) => names.includes(name),
    ),
    names.join(','),
  )
  check(
    'underscore and dot directories are excluded',
    !names.some((name) => name.startsWith('_')) && !names.includes('.metacog'),
    names.join(','),
  )
  check('infrastructure directories are excluded', !names.includes('node_modules'), names.join(','))
  check('root files are counted separately', view.rootFiles === 1, view.rootFiles)

  const yanchu = view.roots.find((root) => root.name === '系庆ppt')
  check('a directory carries its file count', yanchu.files === 3, JSON.stringify(yanchu))
  check('and its per-category split', yanchu.categories.document === 2 && yanchu.categories['raw-data'] === 1)
  check('and its newest change', yanchu.latestModifiedAt === at('2026-09-20') && yanchu.latestFileName.includes('v12'))
  check('and its two-level subdirectory names', yanchu.subdirectories.includes('定稿/') && yanchu.subdirectories.some((entry) => entry.includes('素材/')), yanchu.subdirectories.join(','))
  check('documents outrank raw data in the representative files', yanchu.topFiles[0].endsWith('.pptx') || yanchu.topFiles[0].endsWith('.docx'), yanchu.topFiles.join(','))

  const rendered = renderTaskDirectories(view)
  check('the render states the task count', rendered.includes('5 个'), rendered.slice(0, 200))
  check('and each directory with its counts', rendered.includes('系庆ppt/') && rendered.includes('3 个文件'), rendered.slice(0, 400))

  console.log('\n[directories] a single wrapping directory is descended one level')

  const wrapped = scanOf([
    file('proj/a/one.md', 'document', 1000, '2026-09-01'),
    file('proj/a/two.md', 'document', 1000, '2026-09-02'),
    file('proj/a/three.md', 'document', 1000, '2026-09-03'),
    file('proj/b/one.md', 'document', 1000, '2026-09-04'),
    file('proj/b/two.md', 'document', 1000, '2026-09-05'),
  ])
  const wrappedView = taskDirectoryView(wrapped)
  check('the level below is read instead of the wrapper', wrappedView.level === 2, wrappedView.reason)
  check('the wrapper itself is not a task', !wrappedView.roots.some((root) => root.path === 'proj'), JSON.stringify(wrappedView.roots.map((root) => root.path)))
  check('the directories inside it are the tasks', wrappedView.roots.map((root) => root.path).join(',') === 'proj/a,proj/b', wrappedView.roots.map((root) => root.path).join(','))
  check('and the reason cites the share', wrappedView.reason.includes('%'), wrappedView.reason)

  const flat = scanOf([
    file('one.md', 'document', 1000, '2026-09-01'),
    file('two.md', 'document', 1000, '2026-09-02'),
  ])
  const flatView = taskDirectoryView(flat)
  check('a workspace with no task directories says so', flatView.roots.length === 0 && renderTaskDirectories(flatView).includes('0 个'))

  console.log('\n[transcription] structural evidence is reasoning, not echoing')

  check(
    'a directory-backed derivation passes',
    looksLikeTranscription(
      '系庆ppt',
      '系庆ppt/ 目录下有 38 个文件，其中 12 个是 pptx，最新改动是定稿 v12，说明这件事已接近交付。',
      ['系庆ppt/定稿/系庆PPT定稿v12.pptx'],
    ) === false,
  )
  check(
    'a path alone with a bare echo still fails',
    looksLikeTranscription('系庆ppt', '系庆ppt/', ['系庆ppt/']) === true,
  )
  check(
    'a copied chapter heading is still refused',
    looksLikeTranscription(
      '研究一：群体决策中的信息共享',
      '研究一：群体决策中的信息共享，见初稿。',
      ['初稿.docx'],
    ) === true,
  )
  check(
    'an explanation that does not echo the title passes',
    looksLikeTranscription(
      '完成系庆晚会',
      '目录里有三版节目单和两份主持词，v12 定稿已经生成，剩下的是交付。',
      [],
    ) === false,
  )

  console.log('\n[status] a task-level status needs evidence')

  const goalOf = (over) => ({
    tempId: 'g1',
    depth: 1,
    title: '系庆ppt',
    derivation: '系庆ppt/ 目录下有 38 个文件，多数是 pptx 素材与定稿。',
    evidence: ['系庆ppt/'],
    status: 'draft',
    statusBasis: 'none',
    statusEvidence: '无完成证据',
    ...over,
  })
  const outputOf = (goals, questions = []) =>
    DerivationOutputSchema.parse({
      evidenceManifest: [],
      goals,
      contradictions: [],
      projectProfile: { summary: '', stage: '', deliverables: [] },
      noContradictionFound: true,
      openQuestions: questions,
    })

  {
    const review = reviewDerivation(outputOf([goalOf({ status: 'done', statusBasis: 'none', statusEvidence: '' })]))
    check(
      'a done status with no evidence is rejected',
      review.rejections.some((item) => item.code === 'STATUS_WITHOUT_EVIDENCE'),
      JSON.stringify(review.rejections),
    )
    check('and the status is pulled back to draft', review.output.goals[0].status === 'draft', review.output.goals[0].status)
    check(
      'and its confidence is capped',
      review.capped.some((item) => item.reason === 'STATUS_WITHOUT_EVIDENCE'),
      JSON.stringify(review.capped),
    )
  }

  {
    const review = reviewDerivation(
      outputOf([
        goalOf({
          status: 'done',
          statusBasis: 'mtime',
          statusEvidence: '最后修改 2026-06-01',
          derivation: '系庆ppt/ 有 38 个文件，最后修改 2026-06-01，按陈旧程度推断已完成。',
        }),
      ]),
    )
    check(
      'a date-only completion is capped as weak',
      review.capped.some((item) => item.reason === 'STATUS_FROM_MTIME_ONLY'),
      JSON.stringify(review.capped),
    )
    check(
      'and the user is asked to confirm it',
      review.questions.some((question) => question.includes('最后修改时间')),
      JSON.stringify(review.questions),
    )
  }

  {
    const review = reviewDerivation(
      outputOf([
        goalOf({ status: 'done', statusBasis: 'none', statusEvidence: '无完成证据', derivation: '系庆ppt/ 有 38 个文件，无完成证据，暂按未判定处理。' }),
      ]),
    )
    const silent = review.questions.filter((question) => question.includes('未判定'))
    check('stating "无完成证据" is accepted without the aggregate question', silent.length === 0, JSON.stringify(review.questions))
  }

  {
    const review = reviewDerivation(
      outputOf([
        goalOf({ derivation: '系庆ppt/ 有 38 个文件，多数是 pptx 素材。' }),
        goalOf({ tempId: 'g2', title: '人智协作', derivation: '人智协作/ 有 118 个文件，包含论文初稿与数据。' }),
      ]),
    )
    check(
      'silent drafts are named in one aggregate question',
      review.questions.some((question) => question.includes('未判定') && question.includes('系庆ppt') && question.includes('人智协作')),
      JSON.stringify(review.questions),
    )
  }

  {
    const review = reviewDerivation(
      outputOf([
        goalOf({
          status: 'done',
          statusBasis: 'deliverable',
          statusEvidence: '系庆PPT定稿v12.pptx',
          derivation: '系庆ppt/ 目录里有「系庆PPT定稿v12.pptx」，版本号已收敛，属交付文件。',
        }),
      ]),
    )
    check('a deliverable-backed status is kept', review.output.goals[0].status === 'done', JSON.stringify(review.output.goals[0]))
    check('and not capped for status', !review.capped.some((item) => item.reason.startsWith('STATUS')), JSON.stringify(review.capped))
  }

  {
    const review = reviewDerivation(
      outputOf([goalOf({ depth: 2, title: '整理节目单', status: 'done', statusBasis: 'none', statusEvidence: '' })]),
    )
    check('the status gate is about task-level goals, not every child', review.output.goals[0].status === 'done', review.output.goals[0].status)
  }

  console.log('\n[sessions] missing content search is stated, never fabricated')

  const degraded = renderSessionEvidence({
    sessions: [
      {
        sessionId: 's1',
        title: '把系庆ppt 收尾',
        lastActivityAt: '2026-09-20T10:00:00.000Z',
        archived: true,
        matchedBy: 'cwd',
        directory: '系庆ppt',
      },
    ],
    contentSearchUsed: false,
    degradedReason: '宿主未提供 sessionQuery 服务',
  })
  check('the session is listed by title and directory', degraded.includes('把系庆ppt 收尾') && degraded.includes('系庆ppt'))
  check('the archived flag is visible', degraded.includes('已归档'))
  check('and the degradation is stated in words', degraded.includes('会话内容未参与判定'), degraded)
  check('with its reason', degraded.includes('未提供 sessionQuery'), degraded)

  const withContent = renderSessionEvidence({
    sessions: [
      {
        sessionId: 's2',
        title: '人智协作定稿讨论',
        lastActivityAt: '2026-09-25T08:00:00.000Z',
        archived: false,
        matchedBy: 'content',
        directory: '人智协作：工程心理学的途径',
        snippet: '论文已经定稿，明天提交。',
      },
    ],
    contentSearchUsed: true,
  })
  check('a content hit carries its snippet', withContent.includes('论文已经定稿'), withContent)
  check('and no degradation note when content was searched', !withContent.includes('未参与判定'))

  console.log('\n[prompt] the structure and the session material reach the model')

  const prompt = buildDerivationPrompt({
    materials: workspace,
    context: CONTEXT,
    directories: view,
    sessions: {
      sessions: [
        {
          sessionId: 's1',
          title: '把系庆ppt 收尾',
          lastActivityAt: '2026-09-20T10:00:00.000Z',
          archived: true,
          matchedBy: 'cwd',
          directory: '系庆ppt',
        },
      ],
      contentSearchUsed: false,
      degradedReason: '宿主未提供 sessionQuery 服务',
    },
  })
  check('the prompt names the task directories', prompt.includes('任务级目录') && prompt.includes('系庆ppt/'), prompt.slice(0, 400))
  check('it states the one-goal-per-directory rule', prompt.includes('每个目录一个目标'), prompt.slice(0, 1200))
  check('it requires an explicit status basis', prompt.includes('statusBasis') && prompt.includes('statusEvidence'))
  check('it forbids silent merging', prompt.includes('不得默默合并或丢弃'))
  check('it allows structural facts as derivations', prompt.includes('不算转录'))
  check('it carries the degradation note', prompt.includes('会话内容未参与判定'))

  const promptWithoutSessions = buildDerivationPrompt({ materials: workspace, context: CONTEXT, directories: view })
  check('without session material the prompt omits the block rather than inventing one', !promptWithoutSessions.includes('会话证据'))
} finally {
  // Nothing to clean up: this file reads no fixture directories.
}

console.log(`\nDerivation context: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
