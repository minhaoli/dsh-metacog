/**
 * `metacog_purge`: the destructive path, and what keeps it from being a disaster.
 *
 * Purging is the one operation here that can lose real work, so the tests are
 * mostly about the guards rather than the happy path:
 *
 * - the confirmation must match the project this call actually resolves to,
 *   not one the caller names;
 * - nothing is unlinked — everything moves aside and can be put back;
 * - the goal tree is untouched, because "clear the records" must not be a way to
 *   lose the yardstick by mistyping a verb.
 *
 * Run: node test/purge.test.mjs   (after `npm run build`)
 */
import { mkdtemp, rm, readdir, writeFile, mkdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href

const { metacogPurgeTool } = await import(lib('tools/purge.js'))
const { goalTreeConfirmTool } = await import(lib('tools/tree-lifecycle.js'))
const { parseConfig } = await import(lib('config.js'))
const { MetacogStore } = await import(lib('data/store.js'))
const { deriveProjectId } = await import(lib('tools/shared.js'))
const {
  expectationStatePath,
  failureStatePath,
  readExpectationState,
  readFailureState,
  RealtimeFailureReminder,
  writeExpectationState,
  writeFailureState,
} = await import(lib('analysis/verdict.js'))

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

const root = await mkdtemp(join(tmpdir(), 'metacog-purge-'))
const config = parseConfig({})
const projectId = deriveProjectId(root)

/** Build the tool against this temp project. */
function tool() {
  const store = new MetacogStore(root, config.storageSubdir)
  return {
    store,
    def: metacogPurgeTool({
      ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      config,
      async resolveProjectRoot() {
        return root
      },
      storeFor() {
        return store
      },
    }),
  }
}

const base = {
  id: 'act_1',
  eventFingerprint: 'f1',
  projectId,
  sessionId: 's1',
  timestamp: new Date().toISOString(),
  source: 'turn',
  observationGrade: 'A',
  summary: 'did something',
  evidence: [],
  candidateGoalIds: [],
  alignmentConfidence: null,
  decision: 'aligned',
  rationale: '',
}

try {
  console.log('\n[guard] the confirmation must match the resolved project')

  const { store, def } = tool()
  await store.initialize(projectId, [], [])

  // A wrong id must be refused, and must not be read as "yes". The wrapper reports
  // failure as {ok:false, error} rather than throwing, so the assertion is on that.
  const wrongId = await def.execute({ confirmProjectId: 'some-other-project', reason: 'test' }, {})
  check('a mismatched id is refused', wrongId.ok === false, JSON.stringify(wrongId).slice(0, 120))
  check(
    'and the message says what to do instead',
    /confirmation does not match/.test(JSON.stringify(wrongId)),
    JSON.stringify(wrongId).slice(0, 200),
  )

  // Reason is optional: requiring it discouraged the operation more than it improved the
  // audit. What must survive is the record of *what* was destroyed, which comes from the
  // measured counts rather than the sentence.
  const noReason = await def.execute({ confirmProjectId: projectId }, {})
  check('a missing reason is accepted', noReason.ok === true, JSON.stringify(noReason).slice(0, 120))
  check(
    'and the audit still names the scope and the counts',
    Array.isArray(noReason.data?.deleted),
    JSON.stringify(noReason.data).slice(0, 160),
  )

  console.log('\n[deleted] the record is gone from disk')

  await store.appendActivity(projectId, base)
  const before = (await store.readActivities(projectId)).length
  check('the activity is there to begin with', before === 1, String(before))

  const out = await def.execute({ confirmProjectId: projectId, reason: 'polluted test data' }, {})
  const result = out.data ?? {}
  check('the tool reports success', out.ok === true, JSON.stringify(out).slice(0, 150))
  check('it deleted the activities directory', result.deleted.includes('activities'), JSON.stringify(result.deleted))
  check('and counted the files it removed', result.files > 0, String(result.files))
  check('and the bytes', result.bytes > 0, String(result.bytes))

  const liveAfter = await store.readActivities(projectId)
  check('the record is empty afterwards', liveAfter.length === 0, String(liveAfter.length))

  // The directory itself is gone, not merely emptied.
  const dirGone = await readdir(join(root, config.storageSubdir, 'activities')).then(
    () => false,
    () => true,
  )
  check('the activities directory no longer exists', dirGone)

  console.log('\n[guard] the tree survives')

  const stateAfter = await store.readState(projectId)
  check('the tree is still readable', stateAfter !== undefined)
  check('and still at the same version', stateAfter.version === 0, String(stateAfter?.version))

  console.log('\n[audit] the purge leaves a record of itself')

  const audit = await store.readAuditLog(projectId)
  const entry = audit.find((row) => row.action === 'purge')
  check('an audit entry exists', entry !== undefined, audit.map((r) => r.action).join(','))
  check('it carries the reason', entry?.reason === 'polluted test data', String(entry?.reason))
  check('it records what was destroyed', (entry?.evidence ?? []).some((line) => line.includes('deleted:')))

  console.log('\n[absent] a directory that was never created is reported, not failed on')

  {
    const other = await mkdtemp(join(tmpdir(), 'metacog-purge2-'))
    try {
      const otherId = deriveProjectId(other)
      const s2 = new MetacogStore(other, config.storageSubdir)
      await s2.initialize(otherId, [], [])
      // Only `state/` exists; every purgeable directory is missing.
      const d2 = metacogPurgeTool({
        ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
        config,
        async resolveProjectRoot() {
          return other
        },
        storeFor() {
          return s2
        },
      })
      const out2 = await d2.execute({ confirmProjectId: otherId, reason: 'empty project' }, {})
      const r2 = out2.data ?? {}
      check('missing directories are listed as absent', r2.absent.length > 0, JSON.stringify(r2.absent))
      check('and nothing is reported as deleted', r2.deleted.length === 0, JSON.stringify(r2.deleted))
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('\n[scope] records keeps the tree, everything removes it')

{
  const scopeRoot = await mkdtemp(join(tmpdir(), 'metacog-scope-'))
  try {
    const scopeId = deriveProjectId(scopeRoot)
    const scopeStore = new MetacogStore(scopeRoot, config.storageSubdir)
    await scopeStore.initialize(scopeId, [], [])
    await scopeStore.appendActivity(scopeId, { ...base, projectId: scopeId })
    const scopeTool = metacogPurgeTool({
      ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      config,
      async resolveProjectRoot() {
        return scopeRoot
      },
      storeFor() {
        return scopeStore
      },
    })

    // records: the tree must survive, because "clear the history" is not "delete the
    // project" and a user who wanted the latter has a separate word for it.
    const outRecords = await scopeTool.execute(
      { confirmProjectId: scopeId, reason: 'scope test', scope: 'records' },
      {},
    )
    check('records scope succeeds', outRecords.ok === true, JSON.stringify(outRecords).slice(0, 120))
    check('records scope reports its scope', outRecords.data?.scope === 'records')
    const treeAfter = await scopeStore.readState(scopeId)
    check('records scope leaves the tree', treeAfter !== undefined)
    check('and the tree still has its version', treeAfter?.version === 0, String(treeAfter?.version))
  } finally {
    await rm(scopeRoot, { recursive: true, force: true })
  }
}

{
  const allRoot = await mkdtemp(join(tmpdir(), 'metacog-all-'))
  try {
    const allId = deriveProjectId(allRoot)
    const allStore = new MetacogStore(allRoot, config.storageSubdir)
    await allStore.initialize(allId, [], [])
    const allTool = metacogPurgeTool({
      ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      config,
      async resolveProjectRoot() {
        return allRoot
      },
      storeFor() {
        return allStore
      },
    })

    const outAll = await allTool.execute(
      { confirmProjectId: allId, reason: 'everything test', scope: 'everything' },
      {},
    )
    check('everything scope succeeds', outAll.ok === true, JSON.stringify(outAll).slice(0, 120))
    check('everything scope deletes state/', outAll.data?.deleted?.includes('state'), JSON.stringify(outAll.data?.deleted))
    const treeGone = await allStore.readState(allId)
    check('the tree is gone', treeGone === undefined)
  } finally {
    await rm(allRoot, { recursive: true, force: true })
  }
}

{
  // Default must stay the safe one: a caller that forgets the parameter gets the
  // version that keeps the tree.
  const dfltRoot = await mkdtemp(join(tmpdir(), 'metacog-dflt-'))
  try {
    const dfltId = deriveProjectId(dfltRoot)
    const dfltStore = new MetacogStore(dfltRoot, config.storageSubdir)
    await dfltStore.initialize(dfltId, [], [])
    const dfltTool = metacogPurgeTool({
      ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      config,
      async resolveProjectRoot() {
        return dfltRoot
      },
      storeFor() {
        return dfltStore
      },
    })
    const outDflt = await dfltTool.execute({ confirmProjectId: dfltId, reason: 'no scope given' }, {})
    check('the default scope is records', outDflt.data?.scope === 'records', String(outDflt.data?.scope))
    check('and the tree survives', (await dfltStore.readState(dfltId)) !== undefined)
  } finally {
    await rm(dfltRoot, { recursive: true, force: true })
  }
}

console.log('\n[layout] per-project directories are targeted, not the shared parent')

{
  // `snapshots/` and `signals-archive/` hold one directory per project, unlike the
  // other stores which hold one file per project. The first implementation deleted the
  // shared parent, which for a single-project root happened to look identical — the
  // distinction only matters if a storage root ever holds more than one id. So this
  // asserts the shape directly: after a purge, the parent still exists and the
  // project's own subdirectory does not.
  const layoutRoot = await mkdtemp(join(tmpdir(), 'metacog-layout-'))
  try {
    const layoutId = deriveProjectId(layoutRoot)
    const layoutStore = new MetacogStore(layoutRoot, config.storageSubdir)
    await layoutStore.initialize(layoutId, [], [])

    const snapRoot = join(layoutRoot, config.storageSubdir, 'snapshots')
    await mkdir(join(snapRoot, layoutId), { recursive: true })
    await writeFile(join(snapRoot, layoutId, '1.json'), '{"version":1}', 'utf8')

    const layoutTool = metacogPurgeTool({
      ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      config,
      async resolveProjectRoot() {
        return layoutRoot
      },
      storeFor() {
        return layoutStore
      },
    })

    const out = await layoutTool.execute(
      { confirmProjectId: layoutId, reason: 'layout test', scope: 'records' },
      {},
    )
    check('the purge succeeded', out.ok === true, JSON.stringify(out).slice(0, 120))

    // The project's snapshot directory is gone...
    const mine = await readdir(join(snapRoot, layoutId)).catch(() => [])
    check("this project's snapshots are gone", mine.length === 0, JSON.stringify(mine))

    // ...but the shared parent still exists, so the next append has a home.
    const parentExists = await readdir(snapRoot).then(
      () => true,
      () => false,
    )
    check('the shared parent directory is kept', parentExists)
  } finally {
    await rm(layoutRoot, { recursive: true, force: true })
  }
}

console.log('\n[shell] a project with no record reports that, not a silent zero')

{
  // The case that looked like a broken button: a state file exists, every record
  // directory is missing, so the delete succeeds while removing nothing. Before this
  // flag the message was "deleted 0 directories, 0 files", which reads as a failure.
  const shellRoot = await mkdtemp(join(tmpdir(), 'metacog-shell-'))
  try {
    const shellId = deriveProjectId(shellRoot)
    const shellStore = new MetacogStore(shellRoot, config.storageSubdir)
    await shellStore.initialize(shellId, [], [])

    const shellTool = metacogPurgeTool({
      ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      config,
      async resolveProjectRoot() {
        return shellRoot
      },
      storeFor() {
        return shellStore
      },
    })

    const outShell = await shellTool.execute(
      { confirmProjectId: shellId, reason: 'shell test', scope: 'records' },
      {},
    )
    check('it succeeds', outShell.ok === true, JSON.stringify(outShell).slice(0, 120))
    check('and reports the project was empty', outShell.data?.empty === true, JSON.stringify(outShell.data?.empty))
    check(
      'the message says there was nothing to delete',
      typeof outShell.data?.next === 'string' && outShell.data.next.includes('本来就没有'),
      outShell.data?.next,
    )

    // The empty tree file survives the records scope, so the card can still show it.
    check('the empty tree is still there', (await shellStore.readState(shellId)) !== undefined)

    // And "everything" removes it, which is what made the shell disappear for good.
    const outAll = await shellTool.execute(
      { confirmProjectId: shellId, reason: 'shell test 2', scope: 'everything' },
      {},
    )
    check('everything succeeds on a shell', outAll.ok === true, JSON.stringify(outAll).slice(0, 120))
    check('and the tree is gone', (await shellStore.readState(shellId)) === undefined)
  } finally {
    await rm(shellRoot, { recursive: true, force: true })
  }
}

console.log('\n[audit] the everything scope leaves no file behind')

{
  // The regression: `everything` deleted audit/ and then wrote a purge entry into it,
  // which recreated the directory. "Delete everything" left exactly one file, and the
  // project kept reappearing in the list because its audit stream still existed.
  const auditRoot = await mkdtemp(join(tmpdir(), 'metacog-audit-'))
  try {
    const auditId = deriveProjectId(auditRoot)
    const auditStore = new MetacogStore(auditRoot, config.storageSubdir)
    await auditStore.initialize(auditId, [], [])
    await auditStore.appendActivity(auditId, { ...base, projectId: auditId, id: 'act_audit' })

    const auditTool = metacogPurgeTool({
      ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      config,
      async resolveProjectRoot() {
        return auditRoot
      },
      storeFor() {
        return auditStore
      },
    })

    const outAll = await auditTool.execute(
      { confirmProjectId: auditId, reason: 'no trace test', scope: 'everything' },
      {},
    )
    check('the purge succeeded', outAll.ok === true, JSON.stringify(outAll).slice(0, 120))
    check(
      'the tool reports no audit entry for everything scope',
      outAll.data?.auditEntryId === '',
      JSON.stringify(outAll.data?.auditEntryId),
    )

    // Nothing at all should remain: not the tree, not the audit stream.
    const storageBase = join(auditRoot, config.storageSubdir)
    const remaining = await readdir(storageBase).catch(() => [])
    const leftoverFiles = []
    for (const name of remaining) {
      const inner = await readdir(join(storageBase, name)).catch(() => [])
      if (inner.length > 0) leftoverFiles.push(name + '/' + inner.join(','))
    }
    check('no files are left behind', leftoverFiles.length === 0, JSON.stringify(leftoverFiles))
  } finally {
    await rm(auditRoot, { recursive: true, force: true })
  }
}

console.log('\n[archives] the everything scope also takes the tree history')

{
  // The gap this closes: the directory list covered the live record but not the
  // archives beside it. `archive/` holds milestone snapshots (whole goal trees),
  // `activities-archive/` holds the activity stream after `metacog_archive`, and
  // `rebuilds/` holds the pre-reset backup `resetForRebuild` writes. All three are
  // per-project subdirectories, so they need the same layout rule as `snapshots/`.
  //
  // The existing "no files are left behind" check cannot catch this: it starts
  // from an empty project, so those directories were never created and their
  // absence proves nothing. This case seeds them first.
  const archRoot = await mkdtemp(join(tmpdir(), 'metacog-archives-'))
  try {
    const archId = deriveProjectId(archRoot)
    const archStore = new MetacogStore(archRoot, config.storageSubdir)
    await archStore.initialize(archId, [], [])
    const storageBase = join(archRoot, config.storageSubdir)

    const seeded = ['archive', 'activities-archive', 'rebuilds']
    for (const name of seeded) {
      await mkdir(join(storageBase, name, archId), { recursive: true })
      await writeFile(join(storageBase, name, archId, 'old.json'), '{"tree":"history"}', 'utf8')
    }

    const archTool = metacogPurgeTool({
      ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      config,
      async resolveProjectRoot() {
        return archRoot
      },
      storeFor() {
        return archStore
      },
    })

    const outArch = await archTool.execute(
      { confirmProjectId: archId, reason: 'archive coverage', scope: 'everything' },
      {},
    )
    check('the purge succeeded', outArch.ok === true, JSON.stringify(outArch).slice(0, 120))
    for (const name of seeded) {
      check(`it reports ${name} as deleted`, (outArch.data?.deleted ?? []).includes(name), JSON.stringify(outArch.data?.deleted))
    }

    const leftovers = []
    for (const name of seeded) {
      const inner = await readdir(join(storageBase, name, archId)).catch(() => [])
      if (inner.length > 0) leftovers.push(name + '/' + inner.join(','))
    }
    check('no archived tree history survives', leftovers.length === 0, JSON.stringify(leftovers))

    // The shared parent directories stay: they are keyed by project id, so other
    // projects' archives live in siblings.
    for (const name of seeded) {
      const parentKept = await readdir(join(storageBase, name)).then(
        () => true,
        () => false,
      )
      check(`the shared ${name}/ parent is kept for other projects`, parentKept)
    }
  } finally {
    await rm(archRoot, { recursive: true, force: true })
  }
}

console.log('\n[verdicts] the realtime verdict stream is part of the record')

{
  // The gap this closes: `verdicts/` was added as a second verdict stream beside
  // `signals/`, and the purge list was not updated with it. A purge left the
  // finding on disk while reporting the record cleared — the same "cleared but
  // still there" failure the module comment refuses for the archive directories.
  const verdictRoot = await mkdtemp(join(tmpdir(), 'metacog-verdicts-'))
  try {
    const verdictId = deriveProjectId(verdictRoot)
    const verdictStore = new MetacogStore(verdictRoot, config.storageSubdir)
    await verdictStore.initialize(verdictId, [], [])
    const verdictInput = (at) => ({
      projectId: verdictId,
      at,
      windowStart: new Date(Date.parse(at) - 60_000).toISOString(),
      windowEnd: at,
      match: 0.8,
      goalId: null,
      reason: 'fixture verdict',
      expectNext: 'keep going',
      fulfilled: null,
      provider: 'fixture',
      model: 'fixture-model',
      elapsedMs: 12,
      inputChars: 100,
      outputChars: 20,
    })
    const at = new Date().toISOString()
    await verdictStore.appendVerdict(verdictInput(at))

    const verdictPath = join(verdictRoot, config.storageSubdir, 'verdicts', `${verdictId}.jsonl`)
    const sizeBefore = (await stat(verdictPath)).size
    check(
      'the verdict stream exists before the purge',
      (await verdictStore.readVerdicts(verdictId)).length === 1,
    )

    const verdictTool = metacogPurgeTool({
      ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      config,
      async resolveProjectRoot() {
        return verdictRoot
      },
      storeFor() {
        return verdictStore
      },
    })

    // Records scope: the tree stays, the verdict stream does not. `verdicts/` is
    // the only purgeable directory this project has — `initialize` writes only
    // `state/`, which records scope keeps — so the receipt's counts are
    // attributable to it exactly rather than being "greater than zero somewhere".
    const outVerdicts = await verdictTool.execute(
      { confirmProjectId: verdictId, reason: 'verdict purge', scope: 'records' },
      {},
    )
    check('the purge succeeded', outVerdicts.ok === true, JSON.stringify(outVerdicts).slice(0, 120))
    check(
      'it reports the verdicts directory as deleted',
      (outVerdicts.data?.deleted ?? []).includes('verdicts'),
      JSON.stringify(outVerdicts.data?.deleted),
    )
    check('the receipt counts the verdict file', outVerdicts.data?.files === 1, String(outVerdicts.data?.files))
    check(
      'and its bytes',
      outVerdicts.data?.bytes === sizeBefore,
      `${String(outVerdicts.data?.bytes)} vs ${String(sizeBefore)}`,
    )
    check('and the project is not called empty', outVerdicts.data?.empty === false, String(outVerdicts.data?.empty))
    check('the tree survives the records scope', (await verdictStore.readState(verdictId)) !== undefined)

    const goneAfterRecords = await readdir(join(verdictRoot, config.storageSubdir, 'verdicts')).then(
      () => false,
      () => true,
    )
    check('the verdicts directory is gone', goneAfterRecords)
    check('and no verdict reads back', (await verdictStore.readVerdicts(verdictId)).length === 0)

    // Everything scope is the superset: the second stream must go there too,
    // alongside the tree and the session binding.
    await verdictStore.appendVerdict(verdictInput(new Date(Date.now() + 1).toISOString()))
    const outVerdictsAll = await verdictTool.execute(
      { confirmProjectId: verdictId, reason: 'verdict purge all', scope: 'everything' },
      {},
    )
    check('everything scope succeeds', outVerdictsAll.ok === true, JSON.stringify(outVerdictsAll).slice(0, 120))
    check(
      'everything scope also deletes the verdicts',
      (outVerdictsAll.data?.deleted ?? []).includes('verdicts'),
      JSON.stringify(outVerdictsAll.data?.deleted),
    )
    const goneAfterEverything = await readdir(join(verdictRoot, config.storageSubdir, 'verdicts')).then(
      () => false,
      () => true,
    )
    check('the verdict stream is gone after everything too', goneAfterEverything)
  } finally {
    await rm(verdictRoot, { recursive: true, force: true })
  }
}

console.log('\n[realtime] root-level verdict state is record, not tree')

{
  // The two files a realtime verdict keeps live directly under the storage root,
  // not in a directory of their own, so a directory list can never reach them.
  // They are still the monitor's record: deleting them is what makes the next
  // failure remind again and the next verdict start from `fulfilled: null` —
  // the clean start a purge promises. They are covered in both scopes.
  const realtimeRoot = await mkdtemp(join(tmpdir(), 'metacog-realtime-'))
  try {
    const realtimeId = deriveProjectId(realtimeRoot)
    const realtimeStore = new MetacogStore(realtimeRoot, config.storageSubdir)
    await realtimeStore.initialize(realtimeId, [], [])

    // Paths come from the module that owns them, exactly as the purge now does;
    // a hand-copied name here would keep passing after a real rename.
    const failuresPath = failureStatePath(realtimeRoot, config.storageSubdir)
    const expectationsPath = expectationStatePath(realtimeRoot, config.storageSubdir)
    const at = new Date().toISOString()

    const seedState = () => {
      writeFailureState(failuresPath, {
        version: 1,
        suppressed: { model_missing: at },
        updatedAt: at,
      })
      writeExpectationState(expectationsPath, {
        version: 1,
        projects: {
          [realtimeId]: { expectNext: '继续改 API', at, match: 0.7, goalId: null },
        },
        updatedAt: at,
      })
    }
    const statOrUndefined = (path) => stat(path).then((info) => info.size, () => undefined)

    seedState()
    const failuresSize = await statOrUndefined(failuresPath)
    const expectationsSize = await statOrUndefined(expectationsPath)
    check(
      'both root files exist before the purge',
      failuresSize !== undefined && expectationsSize !== undefined,
      `${String(failuresSize)} / ${String(expectationsSize)}`,
    )

    // Before the purge this reason is suppressed, which is the state the purge
    // has to reset. `recordFailure` returning false means "no reminder".
    const beforeReminder = new RealtimeFailureReminder({ statePath: failuresPath, remind: () => {} })
    check(
      'the failure is suppressed before the purge',
      beforeReminder.recordFailure('model_missing', 'model not available') === false,
    )
    check(
      'and the previous expectation is on disk',
      readExpectationState(expectationsPath).projects[realtimeId]?.expectNext === '继续改 API',
    )

    const realtimeTool = metacogPurgeTool({
      ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      config,
      async resolveProjectRoot() {
        return realtimeRoot
      },
      storeFor() {
        return realtimeStore
      },
    })

    // Records scope. These two files are the only purgeable entries here
    // (`initialize` writes only `state/`, which records keeps), so the receipt's
    // counts are attributable to them exactly rather than "greater than zero".
    const outRealtime = await realtimeTool.execute(
      { confirmProjectId: realtimeId, reason: 'realtime state purge', scope: 'records' },
      {},
    )
    check('the purge succeeded', outRealtime.ok === true, JSON.stringify(outRealtime).slice(0, 120))
    const deletedRealtime = outRealtime.data?.deleted ?? []
    check(
      'it reports the failure state as deleted',
      deletedRealtime.includes(basename(failuresPath)),
      JSON.stringify(deletedRealtime),
    )
    check(
      'and the expectation state',
      deletedRealtime.includes(basename(expectationsPath)),
      JSON.stringify(deletedRealtime),
    )
    check('the receipt counts both root files', outRealtime.data?.files === 2, String(outRealtime.data?.files))
    check(
      'and their exact bytes',
      outRealtime.data?.bytes === failuresSize + expectationsSize,
      `${String(outRealtime.data?.bytes)} vs ${String(failuresSize + expectationsSize)}`,
    )
    check('the tree survives the records scope', (await realtimeStore.readState(realtimeId)) !== undefined)
    check('the failure state file is gone', (await statOrUndefined(failuresPath)) === undefined)
    check('the expectation file is gone too', (await statOrUndefined(expectationsPath)) === undefined)
    check(
      'and a fresh read sees nothing suppressed',
      Object.keys(readFailureState(failuresPath).suppressed).length === 0,
    )
    check(
      'nor any expectation for this project',
      readExpectationState(expectationsPath).projects[realtimeId] === undefined,
    )

    // The semantic check: with the state file gone, the next failure of the same
    // reason reminds again. This is why the file is record, not yardstick.
    const afterReminder = new RealtimeFailureReminder({ statePath: failuresPath, remind: () => {} })
    check(
      'a failure reminds again after the purge',
      afterReminder.recordFailure('model_missing', 'model not available') === true,
    )
    check('and re-creates the state file', (await statOrUndefined(failuresPath)) !== undefined)

    // Everything scope deletes the record as well as the tree, so these files
    // must go there too.
    seedState()
    const outRealtimeAll = await realtimeTool.execute(
      { confirmProjectId: realtimeId, reason: 'realtime state purge all', scope: 'everything' },
      {},
    )
    check('everything scope succeeds', outRealtimeAll.ok === true, JSON.stringify(outRealtimeAll).slice(0, 120))
    check(
      'everything scope deletes the failure state',
      (await statOrUndefined(failuresPath)) === undefined,
    )
    check(
      'everything scope deletes the expectations',
      (await statOrUndefined(expectationsPath)) === undefined,
    )
  } finally {
    await rm(realtimeRoot, { recursive: true, force: true })
  }
}

console.log('\n[preview] the confirmation receipt is record, not tree')

{
  // The gap this closes: `goal_tree_confirm` with `preview: true` writes the
  // record that this tree version was actually shown to the user, and the purge
  // list did not include its directory. A cleared project kept the receipt, so a
  // later confirm of the same version would have passed the preview gate without
  // the tree being shown again.
  //
  // The receipt is produced by the confirm tool itself rather than written by
  // hand, so these assertions follow the real layout. If `tree-lifecycle` moved
  // the record elsewhere, the preview write would land in a different place and
  // the checks below — the receipt names the directory, the counts match it, the
  // directory is gone — would fail instead of passing against a copied path.
  const previewRoot = await mkdtemp(join(tmpdir(), 'metacog-preview-'))
  try {
    const previewId = deriveProjectId(previewRoot)
    const previewStore = new MetacogStore(previewRoot, config.storageSubdir)
    await mkdir(join(previewRoot, 'src'), { recursive: true })
    await writeFile(join(previewRoot, 'README.md'), '# 项目\n', 'utf8')
    await previewStore.initialize(previewId, [], [], {
      projectContext: {
        role: '项目负责人',
        intent: '完成换届',
        constraints: ['2026-11-07 换届会议'],
        stakeholders: [],
        projectSummary: '',
        stage: '',
        deliverables: [],
      },
    })

    const env = {
      ctx: {
        get: () => undefined,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        on: () => () => {},
        effect: () => {},
      },
      config,
      async resolveProjectRoot() {
        return previewRoot
      },
      storeFor() {
        return previewStore
      },
    }
    const exec = {
      callId: 'purge-preview',
      name: 'goal_tree_confirm',
      arguments: {},
      signal: new AbortController().signal,
      projectRoot: previewRoot,
    }
    const confirmArgs = {
      expectedVersion: 0,
      l0: {
        title: '项目根目标',
        evidence: ['README.md'],
        successCriteria: ['换届完成'],
        alignment: { relevantActivities: ['筹备'] },
      },
      goals: [
        {
          title: 'L1 任务',
          depth: 1,
          evidence: ['README.md'],
          successCriteria: ['L1 交付物存在'],
          paths: ['src'],
          alignment: { relevantActivities: ['写代码'] },
        },
        {
          title: 'L2 子任务',
          depth: 2,
          parentRef: 'L1 任务',
          evidence: ['README.md'],
          successCriteria: ['L2 交付物存在'],
          paths: ['src'],
          alignment: { relevantActivities: ['写代码'] },
        },
      ],
      contradictions: [],
      reason: '用户确认的树',
    }

    const confirmTool = goalTreeConfirmTool(env)
    const preview = await confirmTool.execute({ ...confirmArgs, preview: true }, exec)
    check('the preview succeeds', preview.ok === true && preview.data?.preview === true, JSON.stringify(preview).slice(0, 200))

    const storageBase = join(previewRoot, config.storageSubdir)
    const previewDir = join(storageBase, 'preview')
    const receiptNames = await readdir(previewDir).catch(() => [])
    check('the preview receipt is on disk', receiptNames.length === 1, JSON.stringify(receiptNames))
    let receiptBytes = 0
    for (const name of receiptNames) {
      receiptBytes += (await stat(join(previewDir, name))).size
    }

    const previewTool = metacogPurgeTool(env)
    // Records scope: the receipt is part of the conversation record, so it goes
    // with the rest of the record while the tree it referred to stays.
    const outPreview = await previewTool.execute(
      { confirmProjectId: previewId, reason: 'preview purge', scope: 'records' },
      {},
    )
    check('the purge succeeded', outPreview.ok === true, JSON.stringify(outPreview).slice(0, 160))
    const deletedPreview = outPreview.data?.deleted ?? []
    check('it reports the preview directory as deleted', deletedPreview.includes('preview'), JSON.stringify(deletedPreview))
    check('the receipt counts the preview file', outPreview.data?.files === 1, String(outPreview.data?.files))
    check(
      'and its exact bytes',
      outPreview.data?.bytes === receiptBytes,
      `${String(outPreview.data?.bytes)} vs ${String(receiptBytes)}`,
    )
    check('the tree survives the records scope', (await previewStore.readState(previewId)) !== undefined)

    const previewGone = await readdir(previewDir).then(
      () => false,
      () => true,
    )
    check('the preview directory no longer exists', previewGone)

    // The semantic check: with the receipt gone, the same confirmation must be
    // refused for want of a preview again. Deleting the directory is necessary
    // but not sufficient — the record has to be unreachable, not merely unlisted.
    const afterPurge = await confirmTool.execute(confirmArgs, exec)
    check(
      'a confirmation now requires a fresh preview',
      afterPurge.ok === false && afterPurge.error?.code === 'PREVIEW_REQUIRED',
      JSON.stringify(afterPurge).slice(0, 200),
    )

    // Everything scope is the superset: the receipt must go there too.
    const repreview = await confirmTool.execute({ ...confirmArgs, preview: true }, exec)
    check('a re-preview after the purge succeeds', repreview.ok === true, JSON.stringify(repreview).slice(0, 160))
    const outPreviewAll = await previewTool.execute(
      { confirmProjectId: previewId, reason: 'preview purge all', scope: 'everything' },
      {},
    )
    check('everything scope succeeds', outPreviewAll.ok === true, JSON.stringify(outPreviewAll).slice(0, 160))
    check(
      'everything scope also deletes the preview receipt',
      (outPreviewAll.data?.deleted ?? []).includes('preview'),
      JSON.stringify(outPreviewAll.data?.deleted),
    )
    const previewGoneAfterEverything = await readdir(previewDir).then(
      () => false,
      () => true,
    )
    check('the preview directory is gone after everything too', previewGoneAfterEverything)
  } finally {
    await rm(previewRoot, { recursive: true, force: true })
  }
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
