/**
 * Readability guards.
 *
 * A real session hit this: it called `read` on a directory, got
 * `E_UNSUPPORTED_FILE: Path is a binary file`, then did the same thing on an
 * Office document and concluded "Office binaries unreadable, no shell. So my
 * evidence base is the two .md files" — abandoning a project whose substance was
 * entirely in .docx files.
 *
 * The tooling was not broken; the surface told it nothing. So:
 *   - `metacog_scan` marks every file with `readable`;
 *   - the title list says how many files in a group cannot be decoded;
 *   - the protocol names `glob` for directories and explains Office/PDF.
 *
 * Run: node test/evidence-readable.test.mjs
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const discoverUrl = pathToFileURL(join(here, '..', 'lib', 'evidence', 'discover.js')).href
const protocolUrl = pathToFileURL(join(here, '..', 'lib', 'protocol.js')).href
const libUrl = pathToFileURL(join(here, '..', 'lib', 'index.js')).href

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

const { renderTitles, isTextReadable } = await import(discoverUrl)
const { METACOG_PROTOCOL } = await import(protocolUrl)
const { apply } = await import(libUrl)

console.log('\n=== R1: 文本 / 二进制判定 ===')
for (const path of ['a/b/notes.md', 'README.md', 'x/data.csv', 'src/main.ts', 'p.tex', 'c.yaml']) {
  check(`${path} 可读`, isTextReadable(path) === true)
}
for (const path of ['报告.docx', 'slides.pptx', 'sheet.xlsx', 'paper.pdf', 'img.png', 'noext']) {
  check(`${path} 不可读`, isTextReadable(path) === false)
}
check('扩展名大小写不敏感', isTextReadable('NOTES.MD') === true)

console.log('\n=== R2: 标题清单会点名二进制文件的数量 ===')
{
  const files = [
    { path: 'README.md', category: 'document', bytes: 100, modifiedAt: 3 },
    { path: '章程.docx', category: 'document', bytes: 9000, modifiedAt: 2 },
    { path: '报告.docx', category: 'document', bytes: 8000, modifiedAt: 1 },
  ]
  const scan = { files, seen: 3, skippedDirs: [], warnings: [], truncated: 0 }
  const text = renderTitles(scan)
  check('清单点名 2 个需专用工具的文档', text.includes('其中 2 个是文档（docx/xlsx/pptx/pdf）'), text)
  check('清单指向专用读取工具', text.includes('metacog_read_document'))
  check('Office 文件本身仍然列出', text.includes('章程.docx') && text.includes('报告.docx'))
}
{
  const files = [{ path: 'README.md', category: 'document', bytes: 100, modifiedAt: 1 }]
  const text = renderTitles({ files, seen: 1, skippedDirs: [], warnings: [], truncated: 0 })
  check('全可读时不出现文档提示', !text.includes('是文档（'), text)
}

console.log('\n=== R3: 协议里必须给出可用工具 ===')
check('协议提到 glob 列子目录', METACOG_PROTOCOL.includes('glob'))
check('协议点名 Office 与 PDF', METACOG_PROTOCOL.includes('docx') && METACOG_PROTOCOL.includes('PDF'))
check('协议禁止据此断言项目无法分析', METACOG_PROTOCOL.includes('不要因为 read 读不出'))
check('协议指向 reader 字段', METACOG_PROTOCOL.includes('reader'))
check('协议点名 metacog_read_document', METACOG_PROTOCOL.includes('metacog_read_document'))

console.log('\n=== R4: metacog_scan 输出逐文件标 reader ===')
{
  const root = await mkdtemp(join(tmpdir(), 'metacog-readable-'))
  const tools = new Map()
  try {
    await writeFile(join(root, 'README.md'), '# 项目\n')
    await writeFile(join(root, '章程对比说明.md'), '# 说明\n')
    await writeFile(join(root, '章程修订.docx'), 'not really a docx')
    await mkdir(join(root, '附录'), { recursive: true })
    await writeFile(join(root, '附录', '附录一.pdf'), 'not really a pdf')

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
      },
      workingDirectory: { get: () => root, defaultDirectory: root },
    }
    apply(ctx, {})

    const outcome = await tools.get('metacog_scan').execute(
      {},
      {
        callId: 'scan-1',
        name: 'metacog_scan',
        arguments: {},
        signal: new AbortController().signal,
        agent: { id: 'agent-readable-test' },
      },
    )
    check('扫描成功', outcome.ok === true, JSON.stringify(outcome).slice(0, 200))

    const byPath = new Map((outcome.data?.files ?? []).map((file) => [file.path, file]))
    check('列出了 README.md', byPath.has('README.md'), [...byPath.keys()].join(', '))
    check('md 标记可读', byPath.get('README.md')?.readable === true)
    check('md 的 reader 是 read', byPath.get('README.md')?.reader === 'read', String(byPath.get('README.md')?.reader))
    check('docx 标记不可读', byPath.get('章程修订.docx')?.readable === false, String(byPath.get('章程修订.docx')?.readable))
    check(
      'docx 的 reader 指向专用工具',
      byPath.get('章程修订.docx')?.reader === 'metacog_read_document',
      String(byPath.get('章程修订.docx')?.reader),
    )
    check('pdf 的 reader 指向专用工具', byPath.get('附录/附录一.pdf')?.reader === 'metacog_read_document', String(byPath.get('附录/附录一.pdf')?.reader))
    check('pdf 不算纯文本可读', byPath.get('附录/附录一.pdf')?.readable === false, String(byPath.get('附录/附录一.pdf')?.readable))
    check('next 不再要求先问用户', !String(outcome.data?.next).includes('问清角色'), String(outcome.data?.next))
    check('next 指向 glob', String(outcome.data?.next).includes('glob'), String(outcome.data?.next))

    // The mount reads the global tool list here; the fixture exposes none, so
    // the whitelist must degrade to "skip everything unknown" rather than throw.
    check('缺 schemas 时仍能扫描', outcome.ok === true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log(`\n=== Readable 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
