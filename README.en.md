# dsh-metacog

A metacognitive monitor for [DeepSeek Harness](https://github.com/deepseek-ai) (dsh).

It makes explicit what a session is actually working toward — as a **goal tree** — and which structural tensions are slowing it down — as a **contradiction tree** — then judges every step against real tool-call traces, surfacing a card when the work drifts away.

Ships as a Cordis plugin inside a dsh profile: analysis runs server-side, with a web settings card and tree editor on the client.

## The problem it addresses

Long sessions drift. You start on A, and a dozen turns later you are busy with B, and nothing anywhere recorded whether A still mattered. Looking back, there is only a pile of tool calls and no baseline to compare against.

dsh-metacog writes the baseline down, then checks each step against it:

- **Goal tree** — L0 root → L1 → …, where every leaf carries checkable `successCriteria` and activity-alignment rules (`relevantActivities` / `allowedMethods` / `excludedActivities`)
- **Contradiction tree** — distinguishes `core` tensions (structural; they do not vanish by trying harder) from the `main` one currently limiting progress, with intensity readings and a trend computed from observation history
- **Drift judgement** — every activity is classified `aligned` / `exploratory` / `scope_drift` / `uncertain`; only grade-A evidence escalates to an interrupting card
- **Periodic reports** — daily / weekly / monthly, stating only facts: which directories were touched, which files were produced, how much time each group covers. Never advice.

## Tools

20 tools are registered:

| Group | Tools |
|---|---|
| Goal tree | `goal_tree_init` `goal_tree_confirm` `goal_tree_view` `goal_tree_edit` `generate_report` |
| Contradiction tree | `contradiction_observe` `contradiction_tree_edit` |
| Judgement | `check_drift` `resolve_intervention` |
| Planning | `metacog_declare_plan` `metacog_revise_plan` |
| Other | `metacog_scan` `metacog_draft_criteria` `metacog_merge_tree` `metacog_revise` `metacog_archive` `metacog_archive_milestone` `metacog_purge` `metacog_read_document` `metacog_ask_user` |

There are also 17 web HTTP endpoints (`metacog/tree`, `metacog/settings`, `metacog/reports`, `metacog/verdicts`, …) and a hand-written settings card, `client.js`.

## Install

Not published to npm. Mount it from a local directory.

```bash
git clone https://github.com/minhaoli/dsh-metacog.git
cd dsh-metacog
npm install
npm run build
```

Then, inside your dsh profile (e.g. `~/.dsh/profiles/desktop/`), place the package under `node_modules` and insert the mount row into `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-metacog
      name: dsh-metacog
```

On Windows a directory junction is easier than copying:

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-metacog" `
  -Target "D:\path\to\dsh-metacog"
```

Restart dsh to load it.

## Configuration

Runtime config lives under the plugin's `config` in `~/.dsh/cordis.patch.yml`:

```yaml
- id: dsh-metacog
  name: dsh-metacog
  config:
    schedule:
      checkIntervalMinutes: 60
    thresholds:
      windowMinutes: 120
      repeatThreshold: 3
      minConfidence: 0.6
      highIntensityThreshold: 4
      staleDaysThreshold: 7
```

The settings card can also write `~/.dsh/metacog-overrides.yml`. Both are equivalent and require a restart.

## Where data lives

Per-project data is written under `<project>/.metacog/`: `activities/` (activity stream), `signals/` (judgement signals), `audit/` (append-only hash-chained audit log), `snapshots/` (goal tree snapshots), `reports/`, `state/`.

Cross-workspace summary reports go to `~/.dsh/metacog-global/`; the project registry is `~/.dsh/metacog-projects.json`.

All of it is runtime data and is not distributed with the source. `.metacog/` is excluded via `.gitignore`.

## Development

```bash
npm run build        # tsc: src/ -> lib/
npm run check:fresh  # verify build artifacts are not stale
npm test             # unit tests
npm run test:all     # full suite (acceptance, integration, behaviour tracking)
```

Source is in `src/` (60 files, pure ESM TypeScript); build output in `lib/`. `client.js` is hand-written JS and is never compiled.

## Docs

| File | Contents |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Architecture design, the basis for the current implementation |
| [`docs/design-goal-contradiction.md`](docs/design-goal-contradiction.md) | Rules for identifying goals and contradictions |
| [`docs/session-protocol.md`](docs/session-protocol.md) | The session protocol layer |
| [`docs/plugin-contract.md`](docs/plugin-contract.md) | Cordis dependency declaration semantics |
| [`docs/known-issues.md`](docs/known-issues.md) | Known defects, deliberately left unfixed |

The design docs are written in Chinese.

## Limitations

- Implements the Cordis plugin contract, not a generic npm middleware — it will not run outside a dsh host
- `src/evidence/pdf.ts` needs an external `python` (or `python3`) with `pypdf`; without it, only PDF evidence extraction is affected
- `package.json` is marked `private: true` on purpose, to prevent accidental publishing
- No release-versioning semantics yet; `0.1.0` is the initial version

## License

No license has been chosen yet. Until one is added, treat this as all rights reserved.
