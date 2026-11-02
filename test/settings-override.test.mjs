/**
 * The settings override file: safe writes, safe failures.
 *
 * This is the one place in the plugin that writes a file the plugin did not create,
 * so the tests are almost entirely about what happens when it goes wrong:
 *
 * - A value that cannot load must be refused before it reaches disk, because the
 *   next start would otherwise need manual repair.
 * - A corrupt override file must cost the overrides, not the plugin.
 * - The profile config must never be modified. The card writes its own file.
 *
 * Run: node test/settings-override.test.mjs   (after `npm run build`)
 */
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href

const settings = await import(lib('settings.js'))
const { parseConfig } = await import(lib('config.js'))

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

// The module resolves the override path from homedir(); point HOME at a temp dir so
// the test never touches the real one.
const fakeHome = await mkdtemp(join(tmpdir(), 'metacog-home-'))
const realHome = process.env.HOME
const realUserProfile = process.env.USERPROFILE
const realOverrides = process.env.DSH_METACOG_OVERRIDES
// The suite-level isolation preload points overrides at a temp path; this test
// specifically exercises the HOME-derived default, so it clears that redirect
// and puts it back in `finally`.
delete process.env.DSH_METACOG_OVERRIDES
process.env.HOME = fakeHome
// Windows: os.homedir() reads USERPROFILE.
process.env.USERPROFILE = fakeHome

// Re-import after changing the environment so the module picks up the new homedir.
const settingsFresh = await import(`${lib('settings.js')}?home=${encodeURIComponent(fakeHome)}`)

const overridesPath = () => join(fakeHome, '.dsh', 'metacog-overrides.yml')

try {
  console.log('\n[read] no override file means the profile config is used verbatim')

  {
    const profile = { thresholds: { windowMinutes: 120, repeatThreshold: 3 } }
    const result = settingsFresh.resolveConfig(profile)
    check('it reports no overrides applied', result.applied === false)
    check('and keeps the profile value', result.config.thresholds.windowMinutes === 120)
  }

  console.log('\n[write] an editable value lands in the override file')

  {
    const profile = {}
    await settingsFresh.writeOverride('thresholds.windowMinutes', 90, profile)
    const raw = await readFile(overridesPath(), 'utf8')
    check('the file exists', raw.length > 0)
    check('and carries the value', /windowMinutes:\s*90/.test(raw), raw.slice(0, 120))

    const merged = settingsFresh.resolveConfig(profile)
    check('the merged config sees it', merged.config.thresholds.windowMinutes === 90, String(merged.config.thresholds.windowMinutes))
    check('and reports overrides applied', merged.applied === true)
  }

  console.log('\n[write] a second write keeps the first')

  {
    const profile = {}
    await settingsFresh.writeOverride('quiet.enabled', true, profile)
    const merged = settingsFresh.resolveConfig(profile)
    check('the earlier override survives', merged.config.thresholds.windowMinutes === 90)
    check('and the new one applies', merged.config.quiet.enabled === true)
  }

  console.log('\n[refuse] a value that cannot load is rejected before it reaches disk')

  {
    const before = await readFile(overridesPath(), 'utf8')

    // 0 is out of range for staleDaysThreshold: it is positive-int, and a zero here
    // is the exact value that once stopped the whole plugin from mounting.
    let refused = false
    try {
      await settingsFresh.writeOverride('thresholds.staleDaysThreshold', 0, {})
    } catch {
      refused = true
    }
    check('a zero is refused', refused)

    let refusedUnknown = false
    try {
      await settingsFresh.writeOverride('storageSubdir', '../outside', {})
    } catch {
      refusedUnknown = true
    }
    check('a non-editable path is refused', refusedUnknown)

    const after = await readFile(overridesPath(), 'utf8')
    check('the file is unchanged after a refused write', before === after)
  }

  console.log('\n[corrupt] a broken override file costs the overrides, not the plugin')

  {
    await mkdir(dirname(overridesPath()), { recursive: true })
    await writeFile(overridesPath(), 'thresholds: [unclosed\n', 'utf8')
    const profile = { thresholds: { windowMinutes: 120 } }
    let threw = false
    let result
    try {
      result = settingsFresh.resolveConfig(profile)
    } catch {
      threw = true
    }
    check('resolving does not throw', threw === false)
    check('it falls back to the profile value', result?.config.thresholds.windowMinutes === 120)
  }

  console.log('\n[corrupt] an out-of-range override falls back too')

  {
    await writeFile(overridesPath(), 'thresholds:\n  windowMinutes: 0\n', 'utf8')
    const profile = { thresholds: { windowMinutes: 120 } }
    const result = settingsFresh.resolveConfig(profile)
    check('the bad value is ignored', result.config.thresholds.windowMinutes === 120, String(result.config.thresholds.windowMinutes))
    check('and the problem is reported', typeof result.problem === 'string')
    check('overrides are marked not applied', result.applied === false)
  }

  console.log('\n[scope] the editable list excludes what would move or unprotect data')

  {
    const paths = settingsFresh.EDITABLE_PATHS
    check('storageSubdir is not editable', !paths.includes('storageSubdir'))
    check('observationPolicy is not editable', !paths.some((p) => p.startsWith('observationPolicy')))
    check('quiet mode is editable', paths.includes('quiet.enabled'))
    check('the hard block is editable', paths.includes('gate.level3HardBlock'))
    check('thresholds are editable', paths.includes('thresholds.windowMinutes'))
  }

  console.log('\n[parse] a config from profile + overrides still satisfies the schema')

  {
    await rm(overridesPath(), { force: true })
    const merged = settingsFresh.resolveConfig({ thresholds: { repeatThreshold: 5 } })
    const parsed = parseConfig({})
    check('the merged object has every documented section', typeof merged.config.thresholds === 'object')
    check('and keeps unknown-to-it defaults intact', merged.config.thresholds.windowMinutes === parsed.thresholds.windowMinutes)
  }
} finally {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  if (realUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realUserProfile
  if (realOverrides === undefined) delete process.env.DSH_METACOG_OVERRIDES
  else process.env.DSH_METACOG_OVERRIDES = realOverrides
  await rm(fakeHome, { recursive: true, force: true })
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
