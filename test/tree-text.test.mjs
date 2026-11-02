/**
 * `src/analysis/tree-text.ts`: rebuild a forest from parentId and render it.
 *
 * The cases are the ones a preview actually meets: a normal two-level tree, a
 * sibling order that must not wobble between renders, an orphan whose parent
 * was dropped, and a cycle that must be cut instead of walked forever.
 *
 * Run: node test/tree-text.test.mjs   (after `npm run build`)
 */
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (path) => pathToFileURL(join(here, '..', 'lib', path)).href
const { buildTree, renderTreeText } = await import(lib('analysis/tree-text.js'))

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

const node = (id, parentId, title, createdAt = '2026-01-01T00:00:00.000Z') => ({
  id,
  parentId,
  title,
  createdAt,
})

// ------------------------------------------------------------------ normal
console.log('\n[normal] a child is indented inside its own parent')
{
  const tree = buildTree([
    node('a', null, 'L1 甲'),
    node('b', 'a', 'L2 甲一'),
    node('c', null, 'L1 乙'),
  ])
  const text = renderTreeText(tree.roots)
  const lines = text.split('\n')
  check('two roots', tree.roots.length === 2, String(tree.roots.length))
  check('three lines', lines.length === 3, text)
  check('the L1s are at the left edge', lines[0] === 'L1 甲' && lines[2] === 'L1 乙', text)
  check('the L2 is indented under its parent', /^\s+└─ L2 甲一$/.test(lines[1]), lines[1])
  check('the L2 is not at the left edge', lines[1] !== 'L2 甲一', lines[1])
  check('the L2 line follows its own parent', lines.indexOf('L1 甲') < lines.indexOf(lines[1]) && lines.indexOf(lines[1]) < lines.indexOf('L1 乙'), text)
}

// ------------------------------------------------------------------- order
console.log('\n[order] siblings sort by createdAt, then title, deterministically')
{
  const nodes = [
    node('b', 'a', '子B', '2026-01-02T00:00:00.000Z'),
    node('a', null, '甲', '2026-01-01T00:00:00.000Z'),
    node('c', 'a', '子A', '2026-01-02T00:00:00.000Z'),
  ]
  const first = renderTreeText(buildTree(nodes).roots)
  const second = renderTreeText(buildTree([...nodes].reverse()).roots)
  check('the same tree renders identically regardless of input order', first === second, `${first}\n---\n${second}`)
  const lines = first.split('\n')
  check('createdAt decides the sibling order', lines[1].includes('子A') && lines[2].includes('子B'), first)
  check('title breaks a createdAt tie', lines[1].includes('子A'), first)
}

// ----------------------------------------------------------------- orphan
console.log('\n[orphan] a missing parent becomes a marked root')
{
  const tree = buildTree([
    node('a', null, '正常根'),
    node('x', 'missing', '孤立节点'),
  ])
  check('the orphan is reported', tree.orphans.length === 1 && tree.orphans[0].id === 'x', JSON.stringify(tree.orphans))
  check('the orphan is attached at the root', tree.roots.length === 2, String(tree.roots.length))
  const text = renderTreeText(tree.roots)
  check('the orphan is marked in the text', text.includes('孤立节点 [孤立]'), text)
  check('the warning names the missing parent', tree.warnings.some((line) => line.includes('missing')), JSON.stringify(tree.warnings))
}

// ------------------------------------------------------------------ cycle
console.log('\n[cycle] a cycle is cut, marked, and never walked forever')
{
  const tree = buildTree([
    node('a', 'b', '环甲'),
    node('b', 'a', '环乙'),
  ])
  check('the cycle is reported', tree.cycleIds.length >= 2, JSON.stringify(tree.cycleIds))
  check('one cycle node becomes a root', tree.roots.length === 1, String(tree.roots.length))
  const text = renderTreeText(tree.roots)
  check('the broken link is marked in the text', /\[环断\]/.test(text), text)
  check('the cycle nodes still render', text.includes('环甲') && text.includes('环乙'), text)
  check('a warning explains the cut', tree.warnings.some((line) => line.includes('环')), JSON.stringify(tree.warnings))

  // A self-parent must terminate too.
  const self = buildTree([node('s', 's', '自环')])
  check('a self-parent is cut', self.roots.length === 1, String(self.roots.length))
  check('the self-cycle renders', renderTreeText(self.roots).includes('自环'), renderTreeText(self.roots))
}

// ------------------------------------------------------------- two roots
console.log('\n[forest] multiple roots and empty input')
{
  const tree = buildTree([
    node('a', null, 'A根'),
    node('b', null, 'B根'),
    node('c', 'a', '子一'),
  ])
  const text = renderTreeText(tree.roots)
  check('both roots render', text.includes('A根') && text.includes('B根'), text)
  check('the child stays under the first root', /A根\n\s+└─ 子一\nB根/.test(text), text)
  check('an empty forest renders empty', renderTreeText(buildTree([]).roots) === '')
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
