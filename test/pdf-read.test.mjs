/**
 * PDF reading acceptance.
 *
 * The fixture is a hand-written single-page PDF with a correct cross-reference
 * table, so the test does not depend on any sample file or on a library that can
 * *write* PDFs.
 *
 * Run: node test/pdf-read.test.mjs
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libUrl = pathToFileURL(join(here, '..', 'lib', 'index.js')).href
const pdfUrl = pathToFileURL(join(here, '..', 'lib', 'evidence', 'pdf.js')).href

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

/** Build a minimal valid PDF containing one line of text. */
function buildPdf(text) {
  const content = `BT /F1 24 Tf 20 100 Td (${text}) Tj ET`
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]

  let pdf = '%PDF-1.4\n'
  const offsets = []
  bodies.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefStart = pdf.length
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

const { apply } = await import(libUrl)
const { extractPdfText } = await import(pdfUrl)

const root = await mkdtemp(join(tmpdir(), 'metacog-pdf-'))
try {
  const pdfBytes = buildPdf('METACOG-PDF-MARKER')
  await writeFile(join(root, 'sample.pdf'), pdfBytes)
  await writeFile(join(root, 'plain.txt'), '不是 PDF\n')

  console.log('\n=== P1: 直接抽取 ===')
  const direct = await extractPdfText(join(root, 'sample.pdf'), 5000)
  check('抽取成功', direct.ok === true, JSON.stringify(direct).slice(0, 240))
  if (direct.ok) {
    check('文本里有标记', direct.text.includes('METACOG-PDF-MARKER'), direct.text.slice(0, 120))
    check('页数为 1', direct.pages === 1, String(direct.pages))
    check('note 说明来自文本层', direct.note.includes('pypdf'), direct.note)
  }

  console.log('\n=== P2: 没有解释器时如实报告 ===')
  const missing = await extractPdfText(join(root, 'sample.pdf'), 5000, ['definitely-not-python-xyz'])
  check('返回失败', missing.ok === false, JSON.stringify(missing).slice(0, 200))
  check('错误码是 PDF_NO_PYTHON', missing.code === 'PDF_NO_PYTHON', String(missing.code))
  check(
    '说明里点名试着找过的解释器',
    missing.ok === false && missing.reason.includes('definitely-not-python-xyz'),
    missing.ok === false ? missing.reason : '',
  )

  console.log('\n=== P3: 截断生效 ===')
  const clipped = await extractPdfText(join(root, 'sample.pdf'), 12)
  // A budget too small to hold the marker returns nothing rather than
  // overshooting, so check the marker at a budget that can carry it.
  check(
    '配额小于提示串时返回空串',
    clipped.ok === true && clipped.text === '' && clipped.truncated === true,
    JSON.stringify({ len: clipped.ok ? clipped.text.length : '?', truncated: clipped.truncated }),
  )
  const clippedReadable = await extractPdfText(join(root, 'sample.pdf'), 24)
  check(
    '抽出但被截断',
    clippedReadable.ok === true && clippedReadable.text.includes('已截断'),
    JSON.stringify(clippedReadable).slice(0, 200),
  )
  // The sample is 32 characters, so the budgets must sit below that to cut it.
  for (const budget of [16, 20, 24, 30]) {
    const cut = await extractPdfText(join(root, 'sample.pdf'), budget)
    check(
      `maxChars=${budget} 严格不超发`,
      cut.ok === true && cut.text.length <= budget,
      `${cut.ok ? cut.text.length : '?'} > ${budget}`,
    )
    check(
      `maxChars=${budget} 报告 truncated`,
      cut.ok === true && cut.truncated === true && typeof cut.totalChars === 'number',
      JSON.stringify({ truncated: cut.truncated, totalChars: cut.totalChars }),
    )
  }
  const wholePdf = await extractPdfText(join(root, 'sample.pdf'), 100_000)
  check('未截断时 truncated 为 false', wholePdf.ok === true && wholePdf.truncated === false, String(wholePdf.truncated))

  console.log('\n=== P4: 工具路由 ===')
  const tools = new Map()
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return { get: () => root, defaultDirectory: root }
      if (name === 'tools') return this.tools
      return undefined
    },
    logger: { debug() {}, info() {}, warn() {} },
    on: () => () => {},
    effect: () => {},
    tools: { register: (d) => (tools.set(d.name, d), () => tools.delete(d.name)) },
    workingDirectory: { get: () => root, defaultDirectory: root },
  }
  apply(ctx, {})

  const call = (name, args) =>
    tools.get(name).execute(args, {
      callId: 'c',
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent: { id: 'pdf-test' },
    })

  const viaTool = await call('metacog_read_document', { path: 'sample.pdf' })
  check('工具读 PDF 成功', viaTool.ok === true, JSON.stringify(viaTool).slice(0, 240))
  check('format 标为 pdf', viaTool.data?.format === 'pdf', String(viaTool.data?.format))
  check('文本带回标记', String(viaTool.data?.text).includes('METACOG-PDF-MARKER'))
  check('chars 与文本长度一致', viaTool.data?.chars === viaTool.data?.text.length)

  const textFile = await call('metacog_read_document', { path: 'plain.txt' })
  check('文本文件被拒', textFile.ok === false && textFile.error.code === 'NOT_OFFICE', JSON.stringify(textFile).slice(0, 160))

  const escaped = await call('metacog_read_document', { path: '../../etc/passwd' })
  check(
    '越出项目的路径被拒',
    escaped.ok === false && escaped.error.code === 'PATH_OUTSIDE_PROJECT',
    JSON.stringify(escaped).slice(0, 160),
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n=== PDF 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
