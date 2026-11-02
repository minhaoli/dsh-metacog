/**
 * `metacog_read_document` and the OOXML extractor.
 *
 * The plugin carries its own ZIP reader because an Office file is a ZIP of XML
 * and the metacognitive session cannot rely on Python being installed. These
 * tests build real containers byte by byte (stored, no compression) so the
 * extractor is exercised against the actual format rather than a mock.
 *
 * Run: node test/office-read.test.mjs
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libUrl = pathToFileURL(join(here, '..', 'lib', 'index.js')).href
const ooxmlUrl = pathToFileURL(join(here, '..', 'lib', 'evidence', 'ooxml.js')).href

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

/** CRC32, required by the ZIP format even when nothing verifies it. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/** Build a ZIP archive with every entry stored uncompressed. */
function buildZip(files) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    nameBytes.copy(local, 30)
    locals.push(local, data)

    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)
    centrals.push(central)

    offset += local.length + data.length
  }

  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, directory, eocd])
}

/** A minimal but structurally valid .docx. */
function docx(paragraphs) {
  const body = paragraphs.map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join('')
  return buildZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'word/document.xml':
      `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`,
  })
}

/** A minimal .xlsx with a shared string table and one sheet. */
function xlsx(rows) {
  const shared = rows.map((row) => `<si><t>${row[0]}</t></si>`).join('')
  const sheetRows = rows
    .map(
      (row, index) =>
        `<row r="${index + 1}"><c r="A${index + 1}" t="s"><v>${index}</v></c>` +
        `<c r="B${index + 1}"><v>${row[1]}</v></c></row>`,
    )
    .join('')
  return buildZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst>${shared}</sst>`,
    'xl/worksheets/sheet1.xml':
      `<?xml version="1.0"?><worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
  })
}

const { apply } = await import(libUrl)
const { extractOfficeText } = await import(ooxmlUrl)

const root = await mkdtemp(join(tmpdir(), 'metacog-office-'))
try {
  const tools = new Map()
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return this.workingDirectory
      if (name === 'tools') return this.tools
      return undefined
    },
    logger: { debug() {}, info() {}, warn() {} },
    on: () => () => {},
    effect: () => {},
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      // The plugin reads the global tool list at mount; an empty one is enough
      // here because this file tests the document tool, not the whitelist.
      schemas: () => [],
    },
    workingDirectory: { get: () => root, defaultDirectory: root },
  }
  apply(ctx, {})

  function call(name, args) {
    return tools.get(name).execute(args, {
      callId: `call-${Math.random().toString(16).slice(2)}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent: { id: 'agent-office-test' },
    })
  }

  console.log('\n=== O1: docx 正文抽取 ===')
  await mkdir(join(root, '文档'), { recursive: true })
  await writeFile(
    join(root, '文档', '章程修订说明.docx'),
    docx(['第一条 会员类别调整', '第二条 党支部设置', '第三条 条款重编号']),
  )
  const doc = await call('metacog_read_document', { path: '文档/章程修订说明.docx' })
  check('docx 读取成功', doc.ok === true, JSON.stringify(doc).slice(0, 300))
  check('拿到正文', String(doc.data?.text).includes('第一条 会员类别调整'), String(doc.data?.text))
  check('段落不粘连', String(doc.data?.text).includes('第二条 党支部设置'))
  check('标注来源部件', doc.data?.note === 'word/document.xml', String(doc.data?.note))
  check('格式字段正确', doc.data?.format === 'docx', String(doc.data?.format))

  console.log('\n=== O2: xlsx 单元格抽取 ===')
  await writeFile(
    join(root, '预算.xlsx'),
    xlsx([
      ['差旅', 12000],
      ['材料', 3500],
    ]),
  )
  const sheet = await call('metacog_read_document', { path: '预算.xlsx' })
  check('xlsx 读取成功', sheet.ok === true, JSON.stringify(sheet).slice(0, 300))
  check('共享字符串解出文字', String(sheet.data?.text).includes('差旅'), String(sheet.data?.text))
  check('数值单元格保留', String(sheet.data?.text).includes('12000'), String(sheet.data?.text))

  console.log('\n=== O3: 边界与拒绝 ===')
  await writeFile(join(root, 'README.md'), '# 项目\n')
  const text = await call('metacog_read_document', { path: 'README.md' })
  check('文本文件被拒绝并指向 read', text.ok === false && text.error.code === 'NOT_OFFICE', JSON.stringify(text).slice(0, 200))
  check('拒绝信息提到 read', String(text.error?.message).includes('read'))

  const outside = await call('metacog_read_document', { path: '../outside.docx' })
  check(
    '项目外路径被拒绝',
    outside.ok === false && outside.error.code === 'PATH_OUTSIDE_PROJECT',
    JSON.stringify(outside).slice(0, 200),
  )

  const missing = await call('metacog_read_document', { path: '不存在.docx' })
  check('缺失文件报 FILE_NOT_FOUND', missing.ok === false && missing.error.code === 'FILE_NOT_FOUND', JSON.stringify(missing).slice(0, 200))

  await writeFile(join(root, '假文档.docx'), '这不是一个 zip')
  const fake = await call('metacog_read_document', { path: '假文档.docx' })
  check('伪装成 docx 的文本被识破', fake.ok === false && fake.error.code === 'EXTRACTION_FAILED', JSON.stringify(fake).slice(0, 300))

  console.log('\n=== O4: 直接调用抽取器 ===')
  const pdf = await extractOfficeText(join(root, 'x.pdf'))
  check('PDF 明确拒绝', pdf.ok === false && String(pdf.reason).includes('PDF'), String(pdf.reason))
  const legacy = await extractOfficeText(join(root, 'x.doc'))
  check('旧版 .doc 明确拒绝', legacy.ok === false && String(legacy.reason).includes('旧版'), String(legacy.reason))

  // Long enough that every budget below genuinely cuts it: the assertions
  // about `truncated` are only meaningful when the text really was longer.
  // Written to its own file — the short fixture above must stay short.
  const longPath = join(root, '文档', '长文档.docx')
  await writeFile(
    longPath,
    docx(Array.from({ length: 200 }, (_, index) => `第 ${index} 段：很长的段落内容用来测试截断。`)),
  )
  const capped = await extractOfficeText(longPath, 10)
  // A budget too small to hold the marker itself returns nothing: honouring the
  // cap wins over explaining why the text is short.
  check(
    '配额小于提示串时返回空串',
    capped.ok === true && capped.text === '' && capped.truncated === true,
    JSON.stringify({ len: capped.ok ? capped.text.length : '?', truncated: capped.truncated }),
  )
  const cappedReadable = await extractOfficeText(longPath, 200)
  check(
    '配额足够时给出截断提示',
    cappedReadable.ok === true && cappedReadable.text.includes('已截断'),
    String(cappedReadable.text).slice(0, 120),
  )
  // The parameter is a hard cap, not a hint: a caller that budgets 200
  // characters must not receive 216 because the marker was appended on top.
  for (const budget of [10, 50, 120, 200]) {
    const cut = await extractOfficeText(longPath, budget)
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
  const exact = await extractOfficeText(longPath, 100_000)
  check('未截断时不设 truncated', exact.ok === true && exact.truncated === undefined, String(exact.truncated))

  console.log('\n=== O5: 工具已注册并纳入白名单 ===')
  check('工具已注册', tools.has('metacog_read_document'))
  const protocol = await import(pathToFileURL(join(here, '..', 'lib', 'protocol.js')).href)
  check('在白名单里', protocol.METACOG_SESSION_TOOLS.includes('metacog_read_document'))
  check('pwsh 已放回白名单', protocol.METACOG_SESSION_TOOLS.includes('pwsh'))
  check('ask_user_question 在白名单里', protocol.METACOG_SESSION_TOOLS.includes('ask_user_question'))
  // The protocol's question rule is conditional: prefer the tool, and when the
  // deployment does not provide it, fall back to a numbered list in prose that
  // explicitly asks the user to reply. The old absolute wording is gone, so the
  // assertions below test the new contract rather than the old sentences.
  check('协议要求优先用工具提问', protocol.METACOG_PROTOCOL.includes('先调用 metacog_ask_user'))
  check(
    '常规问题必须落在工具参数里；工具不可用时用编号列表兜底并要求回复',
    protocol.METACOG_PROTOCOL.includes('问题本身必须落在工具参数里') &&
      protocol.METACOG_PROTOCOL.includes('不可用') &&
      protocol.METACOG_PROTOCOL.includes('编号列表') &&
      protocol.METACOG_PROTOCOL.includes('请直接回复编号'),
    JSON.stringify({
      toolParams: protocol.METACOG_PROTOCOL.includes('问题本身必须落在工具参数里'),
      unavailable: protocol.METACOG_PROTOCOL.includes('不可用'),
      numberedList: protocol.METACOG_PROTOCOL.includes('编号列表'),
      replyHint: protocol.METACOG_PROTOCOL.includes('请直接回复编号'),
    }),
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n=== Office 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
