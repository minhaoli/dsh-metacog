/**
 * Shared scaffolding for `scripts/verify-*.mjs`.
 *
 * These are throwaway proof harnesses: each one mounts the plugin against a
 * fabricated host, calls tools, and prints PASS/FAIL lines. The mounting, the
 * counting and the invocation-context shape were copied into every script, so a
 * change to the host interface meant sixteen edits. They live here instead.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** This file's own directory: scripts resolve the checkout relative to it, not to cwd. */
const here = dirname(fileURLToPath(import.meta.url))

/**
 * Resolve a path inside this checkout — `'lib/index.js'`, `'docs/x.md'` — to a file: URL.
 *
 * Absolute, so a verify script runs from any working directory. `lib` is the one
 * import every script needs, which is why it is a named export rather than a raw join.
 */
export function libUrl(...segments) {
  return pathToFileURL(join(here, '..', ...segments)).href
}

/**
 * Mount the plugin on a host good enough for its tool registry, and hand back
 * the registry.
 *
 * `stubs` carry per-script services (`subagents`, `sessions`, …). Each one is
 * returned from `ctx.get(name)` *and* spread onto `ctx`, because the plugin reads
 * a few services both ways — including `workingDirectory`, which the multi-project
 * script replaces with a session-aware stub.
 *
 * `apply` is the plugin's own entry point, passed in rather than imported here so
 * this module stays free of any assumption about where the built plugin lives —
 * the script already resolves that to import the tools it asserts on.
 */
export function mountHost(apply, root, stubs = {}) {
  const tools = new Map()
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return this.workingDirectory
      if (name === 'tools') return this.tools
      return stubs[name]
    },
    logger: { debug() {}, info() {}, warn() {} },
    on: () => () => {},
    effect: () => {},
    tools: { register: (definition) => (tools.set(definition.name, definition), () => tools.delete(definition.name)) },
    workingDirectory: { get: () => root, defaultDirectory: root },
    ...stubs,
  }
  apply(ctx, {})
  return { ctx, tools }
}

/**
 * The pass/fail counter pair and its `check()`.
 *
 * Two scripts print `ok`/`—` instead of `PASS`/`--`; both are accepted so the
 * harness can serve all sixteen without changing what any of them prints.
 * `exit()` is the script's last statement: it prints the summary line the caller
 * already parses, then exits non-zero when anything failed.
 *
 * `predicate: true` reads the second argument as the condition rather than as the
 * outcome. The two are the opposite polarity — `check(label, ok)` versus
 * `check(name, condition)` — and a script that has always passed a predicate must
 * keep passing one, or every assertion in it silently inverts.
 */
export function createChecker(style = 'PASS', { predicate = false } = {}) {
  const counts = { passed: 0, failed: 0 }
  // Both styles print `  <mark> <label>`; they differ in the mark and in the
  // separator before `detail`, so each style names its own three pieces.
  const [passMark, separator] = style === 'ok' ? ['ok  ', '—'] : ['PASS ', '--']
  const check = (label, ok, detail) => {
    if (predicate) ok = Boolean(ok)
    if (ok) {
      counts.passed += 1
      console.log(`  ${passMark} ${label}`)
    } else {
      counts.failed += 1
      console.log(`  FAIL  ${label}${detail === undefined ? '' : ` ${separator} ${detail}`}`)
    }
  }
  /** Print a summary and exit: `0` only when nothing failed. */
  const exit = (summary = `\n${counts.passed} passed, ${counts.failed} failed`) => {
    console.log(summary)
    process.exit(counts.failed === 0 ? 0 : 1)
  }
  return { check, exit, counts }
}
