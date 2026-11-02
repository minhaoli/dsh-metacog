/**
 * Verify the settings card's Client half registers where it claims to.
 *
 * A Client plugin is a module-loader factory, so the browser is not required to
 * prove the wiring: stub `window.__ModuleLoader__`, run the factory, and drive
 * `apply` with a recording `slots` service. What this cannot prove is how the
 * card looks once rendered — that needs the page.
 *
 * Usage: node scripts/verify-card-client.mjs
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createChecker } from './_harness.mjs'

const { check, exit } = createChecker('ok', { predicate: true })

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'client.js'), 'utf8')

/** Minimal React surface the module touches at load time. */
const reactStub = {
  createElement: () => null,
  Fragment: Symbol('Fragment'),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
}

let loaded
const previousWindow = globalThis.window
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}

try {
  // The file is a classic script that installs itself on `window`; evaluating it
  // through a function keeps its scope local and returns nothing.
  const run = new Function(source)
  run()
} finally {
  globalThis.window = previousWindow
}

check('module registers itself with the loader', loaded !== undefined)
check('module id is the package name', loaded?.id === 'dsh-metacog', loaded?.id)
check('factory is a function', typeof loaded?.factory === 'function')

const requirer = (name) => {
  if (name === 'react') return reactStub
  throw new Error(`unexpected require: ${name}`)
}
const plugin = loaded.factory(requirer)

check('plugin declares an inject list', Array.isArray(plugin.inject))
check('plugin injects the slots service', plugin.inject.includes('slots'), JSON.stringify(plugin.inject))
check('plugin exposes apply', typeof plugin.apply === 'function')

const injections = []
const registrations = []
const ctx = {
  slots: {
    inject(slot, callback) {
      injections.push(slot)
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  effect: (fn) => fn(),
}

plugin.apply(ctx)

check('registers into two slots', injections.length === 2, String(injections.length))
check('first slot is the bundle config area', injections[0] === 'plugins.bundle.config', injections[0])
check('second slot is the settings sidebar', injections[1] === 'settings.section', injections[1])
check('registered two components', registrations.length === 2, String(registrations.length))

const registration = registrations[0]
check('registration names the slot', registration?.options?.name === 'plugins.bundle.config', registration?.options?.name)
check('registration keys on the bundle package name', registration?.options?.key === 'dsh-metacog', registration?.options?.key)

const section = registrations[1]
check('settings entry names the slot', section?.options?.name === 'settings.section', section?.options?.name)
check('settings entry has its own id', section?.options?.id === 'metacog', section?.options?.id)
check('settings entry carries a nav label', typeof section?.options?.label === 'function' || typeof section?.options?.label === 'string')
check('both slots share one component', section?.component === registration?.component)
check('registration supplies a component', typeof registration?.component === 'function')

// The card must not be a stub: it has to reach the host route and render the
// three sections the feature list promises.
check('component reads the projects endpoint', source.includes('/api/metacog/projects'))
check('component can generate a report', source.includes("'/api/metacog/report'"))
check('component can archive signals', source.includes('/api/metacog/signals/archive'))
check('component honours the summary view', source.includes("props.view === 'summary'"))
check('component uses theme tokens only', !/#[0-9a-fA-F]{6}\b/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')))

exit()
