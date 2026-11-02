/**
 * Keep tests away from the real user override file.
 *
 * `overridesPath()` defaults to `~/.dsh/metacog-overrides.yml`. That file is a
 * user's configuration: once it says `realtime.enabled: true`, a test that
 * mounts the plugin gets a second timer and an unrelated assertion fails. The
 * failure looks like a scheduler bug, which is why this isolation exists.
 *
 * Import this module before mounting anything (`package.json` also preloads it
 * with `--import` for the whole suite). An external `DSH_METACOG_OVERRIDES` is
 * honoured: the reverse-verification runs point it at an explicit override or
 * at malformed YAML and expect the same green result.
 *
 * @module dsh-metacog/test-isolation
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (
  typeof process.env.DSH_METACOG_OVERRIDES !== 'string' ||
  process.env.DSH_METACOG_OVERRIDES.length === 0
) {
  const dir = mkdtempSync(join(tmpdir(), 'metacog-test-overrides-'))
  // Deliberately nonexistent: `readOverrides` treats ENOENT as "no overrides",
  // which is the quiet path. A missing file cannot be mistaken for a malformed
  // one, so this fixture never writes to the developer's home directory.
  process.env.DSH_METACOG_OVERRIDES = join(dir, 'missing.yml')
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A leftover temp directory is harmless; a failed cleanup must not turn
      // into a test failure after the process is already exiting.
    }
  })
}
