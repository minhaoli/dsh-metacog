/**
 * The settings card's tree tab: does it actually draw a tree?
 *
 * The bug this guards was visible to the user before it was visible to any test:
 * nodes were sorted by `depth` and printed flat, so every L2 sat in one block and
 * read as if it belonged to *every* L1. The shape has to follow `parentId`.
 *
 * Three kinds of bad data are load-bearing here, because all three occur in
 * stored trees and two of them can hang a browser:
 *
 *   - an orphan (`parentId` names no node) must still be visible, at the root,
 *     marked as broken;
 *   - a loop (A→B→A) must be cut, deterministically, before any walk goes round
 *     it forever;
 *   - siblings must keep the order the server sent, so a refresh does not
 *     reshuffle rows under the reader's eyes.
 *
 * Run: node test/client-tree.test.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

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

/** A react stand-in, same contract as client-card.test.mjs. */
const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useRef(initial) {
    return { current: initial ?? null }
  },
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
}

let moduleExports
const loader = {
  load({ factory }) {
    moduleExports = factory((name) => {
      if (name === 'react') return reactStub
      throw new Error(`unexpected require: ${name}`)
    })
  },
}

globalThis.window = { __ModuleLoader__: loader }
await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`)

const tree = moduleExports?.__tree
const node = (id, parentId, over) => ({ id, parentId, title: id, depth: 1, ...(over || {}) })

console.log('\n[shape] a forest follows parentId, not depth')

{
  const nodes = [
    node('root', null, { title: '根目标' }),
    node('a', 'root', { title: 'A 策略' }),
    node('a1', 'a', { title: 'A-1 步骤' }),
    node('a2', 'a', { title: 'A-2 步骤' }),
    node('b', 'root', { title: 'B 策略' }),
  ]
  const rows = tree.flattenForest(nodes)
  const order = rows.map((row) => row.node.id)
  check('the rows are in depth-first order', order.join(',') === 'root,a,a1,a2,b', order.join(','))

  const a = rows.find((row) => row.node.id === 'a')
  const a1 = rows.find((row) => row.node.id === 'a1')
  const a2 = rows.find((row) => row.node.id === 'a2')
  const b = rows.find((row) => row.node.id === 'b')
  check('a child comes after its own parent', rows.indexOf(a1) > rows.indexOf(a))
  check('and before the next sibling of that parent', rows.indexOf(a1) < rows.indexOf(b))
  check('the child indent is deeper than its parent', a1.prefix.length > a.prefix.length, `${JSON.stringify(a1.prefix)} vs ${JSON.stringify(a.prefix)}`)
  check(
    'the L2 is not drawn at the L1 level',
    a1.prefix.startsWith('│  ') && a1.prefix.length > b.prefix.length,
    `${JSON.stringify(a1.prefix)} vs ${JSON.stringify(b.prefix)}`,
  )
  check('connectors mark branches and the last child', a.prefix === '├─ ' && a2.prefix.startsWith('│  └─ '), `${JSON.stringify(a.prefix)} / ${JSON.stringify(a2.prefix)}`)
  check('the last root has the closing connector', b.prefix === '└─ ', JSON.stringify(b.prefix))
  check('the root itself has no connector', rows[0].prefix === '', JSON.stringify(rows[0].prefix))
  check(
    'each row says whether it has children',
    rows.find((row) => row.node.id === 'a').hasChildren === true &&
      rows.find((row) => row.node.id === 'a1').hasChildren === false,
  )
}

console.log('\n[orphan] a parentId that names no node is shown at the root, marked')

{
  const nodes = [
    node('root', null, { title: '根' }),
    node('lost', 'ghost', { title: '断链的目标' }),
    node('selfish', 'selfish', { title: '指向自己' }),
  ]
  const rows = tree.flattenForest(nodes)
  check('the orphan is rendered', rows.some((row) => row.node.id === 'lost'))
  check('at the root level', rows.find((row) => row.node.id === 'lost').depth === 0)
  check('and marked as unattached', rows.find((row) => row.node.id === 'lost').broken === 'unattached')
  check('a self-parent is treated the same way', rows.find((row) => row.node.id === 'selfish').broken === 'unattached')
}

console.log('\n[cycle] a loop is cut, and the walk terminates')

{
  const nodes = [
    node('x', 'y', { title: 'X' }),
    node('y', 'x', { title: 'Y' }),
    node('root', null, { title: '根' }),
  ]
  const started = Date.now()
  const rows = tree.flattenForest(nodes)
  const elapsed = Date.now() - started
  check('the walk returns instead of recursing forever', elapsed < 1000, `${elapsed}ms`)
  check('no node is dropped', rows.length === nodes.length, String(rows.length))
  const broken = rows.filter((row) => row.broken === 'cycleBroken')
  check('exactly one link is cut', broken.length === 1, JSON.stringify(rows.map((row) => [row.node.id, row.broken])))
  check('the cut node sits at the root', broken[0].depth === 0, JSON.stringify(broken[0]))
}

console.log('\n[stable] siblings keep the order the server sent')

{
  const nodes = [
    node('root', null),
    node('third', 'root', { title: 'C' }),
    node('first', 'root', { title: 'A' }),
    node('second', 'root', { title: 'B' }),
  ]
  const order = tree.flattenForest(nodes).map((row) => row.node.id)
  check('siblings are not re-sorted alphabetically', order.join(',') === 'root,third,first,second', order.join(','))
  const again = tree.flattenForest(nodes).map((row) => row.rowKey === undefined ? row.node.id : row.rowKey)
  check('a second call produces the same order', again.join(',') === order.join(','))
}

console.log('\n[edge] empty and malformed input')

{
  check('an empty list renders nothing', tree.flattenForest([]).length === 0)
  check('undefined renders nothing', tree.flattenForest(undefined).length === 0)
  const rows = tree.flattenForest([null, { id: 'ok', title: '只有 id', parentId: '' }, { id: 42 }])
  check('nodes without a usable id are skipped', rows.length === 1 && rows[0].node.id === 'ok', JSON.stringify(rows.map((row) => row.node)))
}

console.log('\n[source] the flat depth-sorted rendering is gone')

{
  check(
    'the depth sort is no longer in the tree tab',
    !source.includes('sort((left, right) => left.depth - right.depth)'),
  )
  check('both panels build a forest', (source.match(/flattenForest\(/g) || []).length >= 2)
  check('the connector prefix is rendered in both panels', (source.match(/S\.treePrefix/g) || []).length >= 2)
  check(
    'the help no longer says the left column is depth',
    !source.includes('每行左边是深度') && source.includes('缩进与 `├─`/`└─` 表示父子关系'),
  )
  check('the help states that all nodes are shown (no server-side collapse)', source.includes('全部节点都显示'))
  check('broken links carry a visible tag', source.includes('未挂接') && source.includes('环已断开'))
}

console.log(`\nClient tree: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
