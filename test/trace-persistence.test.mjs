/**
 * The trace must survive the trip from the collector to disk.
 *
 * This exists because it did not. The collector computed `toolNames`, the signal
 * layer read `activity.toolNames`, and every test passed — but `ActivityRecordSchema`
 * had no such field and `onActivity` never handed it over, so the store silently
 * dropped it and 2339 real records came out with no trace at all. Nothing failed;
 * the data was simply not there.
 *
 * So this asserts the end of the chain rather than its middle: write through the
 * real store, read the file back, and check the trace is in it.
 *
 * Run: node test/trace-persistence.test.mjs   (after `npm run build`)
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href

const { ActivityRecordSchema } = await import(lib('data/types.js'))
const { MetacogStore } = await import(lib('data/store.js'))
const { deriveProjectId } = await import(lib('tools/shared.js'))

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

const root = await mkdtemp(join(tmpdir(), 'metacog-trace-'))
const projectId = deriveProjectId(root)
const store = new MetacogStore(root, '.metacog')
const ts = new Date().toISOString()

const base = {
  projectId,
  sessionId: 's1',
  timestamp: ts,
  source: 'turn',
  observationGrade: 'A',
  summary: '做了一些事',
  evidence: [],
  candidateGoalIds: [],
  alignmentConfidence: null,
  decision: 'aligned',
  rationale: '',
}

console.log('\n[schema] trace is optional and survives parsing')

{
  const withTrace = ActivityRecordSchema.parse({
    ...base,
    id: 'act_a',
    eventFingerprint: 'f-a',
    trace: {
      toolNames: ['read', 'edit', 'pwsh'],
      toolResults: [{ tool: 'pwsh', ok: true, excerpt: '8 passed', outcome: 'tests-pass' }],
    },
  })
  check('trace is kept', Array.isArray(withTrace.trace?.toolNames))
  check('all three tool names survive in order', JSON.stringify(withTrace.trace?.toolNames) === JSON.stringify(['read', 'edit', 'pwsh']))
  check('the result outcome survives', withTrace.trace?.toolResults[0].outcome === 'tests-pass')

  const withoutTrace = ActivityRecordSchema.parse({ ...base, id: 'act_b', eventFingerprint: 'f-b' })
  check('a record with no trace stays undefined, not []', withoutTrace.trace === undefined)

  const emptyTrace = ActivityRecordSchema.parse({
    ...base,
    id: 'act_c',
    eventFingerprint: 'f-c',
    trace: { toolNames: [], toolResults: [] },
  })
  check('an explicit empty trace is [], not undefined', Array.isArray(emptyTrace.trace?.toolNames))
  check(
    'so "no tools" and "no trace" remain distinguishable',
    emptyTrace.trace !== undefined && withoutTrace.trace === undefined,
  )
}

console.log('\n[store] the trace reaches the file on disk')

try {
  await store.appendActivity(projectId, {
    ...base,
    id: 'act_persist',
    eventFingerprint: 'f-persist',
    trace: {
      toolNames: ['read', 'grep', 'edit'],
      toolResults: [{ tool: 'edit', ok: true, excerpt: 'ok', outcome: null }],
    },
  })

  const path = join(root, '.metacog', 'activities', `${projectId}.jsonl`)
  const raw = await readFile(path, 'utf8')
  const stored = JSON.parse(raw.trim().split('\n').filter(Boolean).pop())

  check('the written line carries a trace object', stored.trace !== undefined, JSON.stringify(Object.keys(stored)))
  check(
    'with the tool sequence intact',
    JSON.stringify(stored.trace?.toolNames) === JSON.stringify(['read', 'grep', 'edit']),
    JSON.stringify(stored.trace?.toolNames),
  )
  check('and the result', stored.trace?.toolResults?.[0]?.tool === 'edit')

  // And it reads back through the store's own parser, not just as raw JSON.
  const readBack = await store.readActivities(projectId)
  const found = readBack.find((r) => r.id === 'act_persist')
  check('readActivities returns the trace too', found?.trace?.toolNames?.length === 3)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
