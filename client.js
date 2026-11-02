/**
 * dsh-metacog settings card — the Client half.
 *
 * Three tabs, not one long column: 状态 answers "what is happening", 树 answers "what
 * is the yardstick", 设置 answers "what can I change". The earlier version stacked
 * sections in a flat list, which read as a wall of numbers and buried the one thing
 * a person opens the card for — whether anything needs them.
 *
 * Two rules carried over from the design mockup, both about honesty rather than
 * layout:
 *
 * - Every number that can mislead carries the sentence that says why. The drift
 *   share is the clearest case: 80% looks alarming until you know most of it is a
 *   criteria gap, and the card says so instead of letting the bar speak alone.
 * - Settings say what they do and what happens if you change them. A parameter
 *   without that is a number nobody dares touch.
 *
 * Written as plain JavaScript on purpose. A Client half is loaded by the module
 * loader as a lazy factory, so there is no build step to go stale and no second
 * React copy to resolve.
 */
window.__ModuleLoader__.load({
  id: 'dsh-metacog',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    const CARD_KEY = 'dsh-metacog'
    const CARD_KEY_SLOT = 'plugins.bundle.config'
    const SETTINGS_SLOT = 'settings.section'
    const EMPTY = {}

    /**
     * The four decisions, with the label the card shows and a hint for the tooltip.
     *
     * Kept as a list of triples rather than an object so the render order is the
     * order they are declared in — a decision surface whose buttons move around is
     * one you have to re-read every time.
     */
    const DECISION_LABELS = [
      ['continue', '继续', '这不是偏离，照原计划推进'],
      ['realign', '纠正', '确实偏了，拉回原目标'],
      ['modify_goals', '改目标', '目标本身要调整，去改树'],
      ['dismiss', '忽略', '这条判断不可信，不再考虑'],
    ]

    /** Human label per cadence, used by the report panel and its buttons. */
    const REPORT_LABELS = { daily: '日报', weekly: '周报', monthly: '月报' }

    /**
     * The statuses a goal can hold, in the order the schema declares them.
     *
     * Hard-coded rather than fetched: the edit form needs them on first paint, and
     * a select that arrives one round trip late is one the user already clicked past.
     */
    const GOAL_STATUSES = ['draft', 'active', 'at_risk', 'blocked', 'done', 'deprecated']

    /**
     * What each cadence covers and where it lives.
     *
     * The nesting is the part a reader cannot guess: a weekly report is built
     * from that week's dailies and a monthly from that month's weeklies, so the
     * panel says so rather than leaving two reports that disagree looking equally
     * authoritative.
     */
    const REPORT_HINTS = {
      daily: '一天一份，文件名是日期，放在 日报/年份_月份/。',
      weekly: '一周一份，文件名是当周周一，放在 周报/年份_季度/。内容汇总这一周的日报。',
      monthly: '一月一份，文件名是当月一号，放在 月报/年份/。内容汇总这一月的周报。',
    }

    // ---------------------------------------------------------------- data

    /** Read one JSON endpoint; a failure becomes a value the card can render. */
    function api(path, method, body) {
      return fetch(path, {
        method: method || 'GET',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
        .then((response) =>
          response
            .json()
            .catch(() => ({ ok: false, error: 'HTTP ' + response.status + '（响应不是 JSON）' }))
            .then((json) => {
              // Carry the status through. A 403 and a rule rejection both look like
              // "something failed" in a message; the number says which layer refused,
              // and that is the first question anyone debugging this will ask.
              if (json && json.ok === false && json.status === undefined) {
                return { ...json, status: response.status }
              }
              return json
            }),
        )
        .catch((error) => ({ ok: false, error: '网络错误：' + String((error && error.message) || error) }))
    }

    /** Bytes to a short human string. */
    function size(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / (1024 * 1024)).toFixed(1) + ' MB'
    }

    /** `2026-10-28T06:56:45.272Z` → `10-28 06:56`. */
    function when(iso) {
      if (typeof iso !== 'string' || iso.length < 16) return '—'
      return iso.slice(5, 10) + ' ' + iso.slice(11, 16)
    }

    /** Thousands separators: 2268 and 2,268 read differently. */
    function num(value) {
      const n = Number(value)
      return Number.isFinite(n) ? n.toLocaleString('en-US') : '—'
    }

    // ---------------------------------------------------------------- tree shape

    /**
     * Model choices for the realtime panel: an empty value means "follow the
     * global model", then the selected provider's models with both id and
     * display name visible.
     */
    function modelChoices(providers, provider) {
      const out = [{ value: '', label: '跟随全局' }]
      const entry = (Array.isArray(providers) ? providers : []).find(
        (item) => item && item.provider === provider,
      )
      const models = (entry && Array.isArray(entry.models) && entry.models) || []
      for (const model of models) {
        if (!model || typeof model.id !== 'string') continue
        out.push({
          value: model.id,
          label: model.displayName ? model.displayName + '（' + model.id + '）' : model.id,
        })
      }
      return out
    }

    /** `match: null` means the goal was vague; it is not a score of zero. */
    function verdictMatchLabel(match) {
      if (match === null || match === undefined) return '目标模糊，无法可靠判断'
      return '匹配 ' + Math.round(Number(match) * 100) + '%'
    }

    /** A missed expectation is a change of mind, not an alarm. */
    function verdictFulfilledLabel(fulfilled) {
      if (fulfilled === false) return '上期预期未兑现'
      if (fulfilled === true) return '上期预期已兑现'
      return ''
    }

    /** Counts shown in the top status strip. */
    function statusSummary(nodes, criteriaGap, realtimeEnabled) {
      const list = Array.isArray(nodes) ? nodes : []
      return {
        missingCriteria: Number(criteriaGap && criteriaGap.missing) || 0,
        missingPaths: list.filter((node) => !Array.isArray(node.paths) || node.paths.length === 0).length,
        missingDeadline: list.filter((node) => !node.deadline).length,
        realtimeEnabled: realtimeEnabled === true,
      }
    }

    /** The two settings writes a realtime model choice needs. */
    function realtimeSettingsPayload(provider, model) {
      return [
        { path: 'realtime.provider', value: provider },
        { path: 'realtime.model', value: model },
      ]
    }

    /**
     * Group flat nodes into a forest by `parentId`, surviving bad data.
     *
     * The settings card used to sort nodes by `depth` and print them flat, which
     * makes every L2 look like it hangs off *every* L1. A real tree has to follow
     * `parentId` — but the stored parent links are not trusted blindly:
     *
     * - a `parentId` that names no node (or names the node itself) becomes a root,
     *   flagged `unattached` so the reader knows the link is broken;
     * - a parent loop (A→B→A) would make any walk recursive forever. Each loop is
     *   broken at its earliest node in input order, that node becomes a root and is
     *   flagged `cycleBroken`. Nothing is dropped;
     * - siblings keep the order the server sent them, so a refresh never reshuffles
     *   the list under the reader's eyes.
     *
     * @param {Array<object>} nodes - flat nodes, each with `id` and `parentId`.
     * @returns {{roots: Array<{node: object, children: Array}>, broken: Map<string,string>}}
     */
    function buildForest(nodes) {
      const list = Array.isArray(nodes) ? nodes.filter((node) => node && typeof node.id === 'string' && node.id !== '') : []
      const indexOf = new Map()
      list.forEach((node, index) => {
        if (!indexOf.has(node.id)) indexOf.set(node.id, index)
      })
      const byId = new Map()
      for (const node of list) if (!byId.has(node.id)) byId.set(node.id, node)

      /** How each node's broken link was repaired, keyed by node id. */
      const broken = new Map()
      const parentOf = new Map()
      for (const node of list) {
        const parentId = typeof node.parentId === 'string' ? node.parentId : ''
        if (parentId === '') {
          parentOf.set(node.id, null)
          continue
        }
        if (parentId === node.id || !byId.has(parentId)) {
          parentOf.set(node.id, null)
          broken.set(node.id, 'unattached')
          continue
        }
        parentOf.set(node.id, parentId)
      }

      // Break loops. Standard parent-chain walk with three states: a node met
      // again while still on the current chain means the chain closed on itself.
      // The loop is cut at its earliest node in input order, so the break point is
      // stable across refreshes.
      const state = new Map()
      for (const node of list) {
        if (state.get(node.id) === 2) continue
        const chain = []
        let cursor = node.id
        for (;;) {
          const mark = state.get(cursor)
          if (mark === 1) {
            const start = chain.indexOf(cursor)
            const cycle = start < 0 ? [] : chain.slice(start)
            const pick = pickCycleBreak(cycle, indexOf, byId)
            if (pick !== undefined) {
              parentOf.set(pick, null)
              broken.set(pick, 'cycleBroken')
            }
            break
          }
          if (mark === 2) break
          state.set(cursor, 1)
          chain.push(cursor)
          const parentId = parentOf.get(cursor)
          if (parentId === null || parentId === undefined) break
          cursor = parentId
        }
        for (const id of chain) state.set(id, 2)
      }

      const childrenOf = new Map()
      const roots = []
      for (const node of list) {
        const parentId = parentOf.get(node.id)
        if (parentId === null || parentId === undefined) {
          roots.push(node)
          continue
        }
        const bucket = childrenOf.get(parentId)
        if (bucket === undefined) childrenOf.set(parentId, [node])
        else bucket.push(node)
      }
      const build = (node) => ({
        node,
        broken: broken.get(node.id),
        children: (childrenOf.get(node.id) ?? []).map(build),
      })
      return { roots: roots.map(build), broken }
    }

    /** Deterministically choose the loop's break point: earliest input order. */
    function pickCycleBreak(ids, indexOf, byId) {
      let best
      let bestIndex = Number.POSITIVE_INFINITY
      for (const id of new Set(ids)) {
        if (!byId.has(id)) continue
        const index = indexOf.get(id)
        if (index === undefined) continue
        if (index < bestIndex) {
          bestIndex = index
          best = id
        }
      }
      return best
    }

    /**
     * Flatten a forest into render rows, each carrying its connector prefix.
     *
     * The prefix is the tree: `├─ ` for a node with following siblings, `└─ `
     * for the last one, and `│  `/`   ` under each ancestor so a whole subtree
     * visibly belongs to the row above it.
     *
     * @param {Array<object>} nodes - flat nodes.
     * @returns {Array<{node: object, depth: number, prefix: string, broken?: string, hasChildren: boolean}>}
     */
    function flattenForest(nodes) {
      const rows = []
      const walk = (branch, ancestorPrefix, isLast, depth) => {
        const connector = depth === 0 ? '' : isLast ? '└─ ' : '├─ '
        const prefix = ancestorPrefix + connector
        rows.push({
          node: branch.node,
          depth,
          prefix,
          hasChildren: branch.children.length > 0,
          ...(branch.broken === undefined ? {} : { broken: branch.broken }),
        })
        const childPrefix = ancestorPrefix + (depth === 0 ? '' : isLast ? '   ' : '│  ')
        branch.children.forEach((child, index) => {
          walk(child, childPrefix, index === branch.children.length - 1, depth + 1)
        })
      }
      const forest = buildForest(nodes)
      forest.roots.forEach((root, index) => walk(root, '', index === forest.roots.length - 1, 0))
      return rows
    }

    // ---------------------------------------------------------------- styling
    // Only theme tokens: a renamed token degrades the look, it never breaks it.
    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '4px 0 8px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: 1.65,
      },
      head: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      title: { fontSize: 17, fontWeight: 650, margin: 0 },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 22,
        padding: '0 9px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-brand-primary)',
      },
      badgeGray: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 22,
        padding: '0 9px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      dot: { width: 6, height: 6, borderRadius: '50%', background: 'currentColor' },
      sub: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, margin: 0 },

      intro: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '12px 14px',
        fontSize: 12.5,
        position: 'relative',
      },
      introTitle: { margin: '0 0 6px', fontSize: 12.5, fontWeight: 650 },
      introList: { margin: 0, paddingLeft: 18, color: 'var(--dsw-alias-label-secondary)' },
      introClose: {
        position: 'absolute',
        right: 10,
        top: 6,
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 15,
        background: 'none',
        border: 'none',
        padding: 0,
        fontFamily: 'inherit',
      },

      tabs: {
        display: 'flex',
        gap: 2,
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        margin: '2px 0 4px',
      },
      tab: {
        padding: '7px 14px',
        fontSize: 13,
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        border: 'none',
        background: 'none',
        borderBottom: '2px solid transparent',
        marginBottom: -1,
        fontFamily: 'inherit',
      },
      tabOn: {
        padding: '7px 14px',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        border: 'none',
        background: 'none',
        borderBottom: '2px solid var(--dsw-alias-brand-primary)',
        marginBottom: -1,
        fontWeight: 600,
        fontFamily: 'inherit',
      },

      picker: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        flexWrap: 'wrap',
      },
      select: {
        fontFamily: 'inherit',
        fontSize: 12.5,
        padding: '5px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        minWidth: 230,
      },
      meta: {
        marginLeft: 'auto',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
        textAlign: 'right',
      },

      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '14px 16px',
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
      cardTitle: { margin: 0, fontSize: 13, fontWeight: 650 },
      right: { marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' },

      help: { margin: '0 0 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      helpSummary: {
        cursor: 'pointer',
        color: 'var(--dsw-alias-brand-primary)',
        fontSize: 12,
        listStyle: 'none',
      },
      helpBody: {
        marginTop: 6,
        padding: '9px 11px',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        lineHeight: 1.75,
      },

      stats: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 },
      stat: {
        padding: '10px 12px',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
        position: 'relative',
      },
      statK: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      statV: { fontSize: 20, fontWeight: 650, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 },
      statVWarn: {
        fontSize: 20,
        fontWeight: 650,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1.3,
        color: 'var(--dsw-alias-state-warning-primary)',
      },
      statD: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },

      bar: {
        display: 'flex',
        height: 10,
        borderRadius: 5,
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-2)',
        marginTop: 14,
      },
      // Completion block. Its own container rather than a `Stat` because it carries
      // a bar and per-depth rows, not one number.
      progressBlock: {
        marginTop: 14,
        padding: '12px 14px',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      progressHead: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
      progressLabel: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
      progressValue: { fontSize: 22, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' },
      progressDetail: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
      progressBar: {
        display: 'flex',
        height: 8,
        borderRadius: 4,
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-1)',
        marginTop: 10,
      },
      progressDepths: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 },
      progressDepthRow: { display: 'grid', gridTemplateColumns: '58px 1fr 44px', alignItems: 'center', gap: 8 },
      progressDepthLabel: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
      progressDepthBar: {
        display: 'flex',
        height: 5,
        borderRadius: 3,
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      progressDepthValue: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', textAlign: 'right' },
      legend: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 14,
        marginTop: 8,
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-secondary)',
      },
      legendItem: { display: 'inline-flex', alignItems: 'center', gap: 5 },
      sw: { width: 8, height: 8, borderRadius: 2 },

      statusStrip: {
        display: 'flex',
        gap: 8,
        flexWrap: 'wrap',
        alignItems: 'center',
        margin: '2px 0 4px',
        fontSize: 12,
      },
      warnLine: {
        padding: '9px 12px',
        borderRadius: 8,
        fontSize: 12,
        lineHeight: 1.7,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-state-warning-primary)',
        border: '1px solid var(--dsw-alias-state-warning-primary)',
        marginTop: 12,
      },
      okLine: {
        padding: '9px 12px',
        borderRadius: 8,
        fontSize: 12,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-state-success-primary)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      dangerLine: {
        padding: '9px 12px',
        borderRadius: 8,
        fontSize: 12,
        lineHeight: 1.7,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-state-error-primary)',
        border: '1px solid var(--dsw-alias-state-error-primary)',
      },
      // Top-of-card feedback. Deliberately louder than `okLine`: it has to be
      // noticed from wherever the button was, which may be a full page of
      // settings below.
      noticeBar: {
        padding: '10px 12px',
        marginBottom: 12,
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1.6,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-state-success-primary)',
        border: '2px solid var(--dsw-alias-state-success-primary)',
      },
      dangerBar: {
        padding: '10px 12px',
        marginBottom: 12,
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1.6,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-state-error-primary)',
        border: '2px solid var(--dsw-alias-state-error-primary)',
      },
      busyBar: {
        padding: '8px 12px',
        marginBottom: 12,
        borderRadius: 8,
        fontSize: 12,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },

      // Status tags for the "needs you" list. Four fixed tones rather than a colour
      // prop: a tag whose colour is decided at the call site drifts into eight
      // shades of meaning nobody can decode.
      stRowTag: {
        flex: '0 0 auto',
        height: 19,
        padding: '0 7px',
        borderRadius: 5,
        fontSize: 11,
        display: 'inline-flex',
        alignItems: 'center',
        fontWeight: 600,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-state-warning-primary)',
      },
      stRowTagInfo: {
        flex: '0 0 auto',
        height: 19,
        padding: '0 7px',
        borderRadius: 5,
        fontSize: 11,
        display: 'inline-flex',
        alignItems: 'center',
        fontWeight: 600,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-brand-primary)',
      },
      stRowTagWarn: {
        flex: '0 0 auto',
        height: 19,
        padding: '0 7px',
        borderRadius: 5,
        fontSize: 11,
        display: 'inline-flex',
        alignItems: 'center',
        fontWeight: 600,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-state-error-primary)',
      },
      stRowTagOk: {
        flex: '0 0 auto',
        height: 19,
        padding: '0 7px',
        borderRadius: 5,
        fontSize: 11,
        display: 'inline-flex',
        alignItems: 'center',
        fontWeight: 600,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-state-success-primary)',
      },

      todo: {
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '9px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      todoBody: { flex: 1, minWidth: 0 },
      todoT: { fontSize: 12.5 },
      todoS: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' },
      // One pending intervention card. Bordered and inset so two cards on the
      // same page do not read as one long paragraph with eight buttons.
      decisionCard: {
        marginTop: 10,
        padding: '12px 14px',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      decisionHead: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 8,
      },
      decisionWhen: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
      decisionId: {
        marginLeft: 'auto',
        fontSize: 10.5,
        color: 'var(--dsw-alias-label-tertiary)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      decisionSummary: { fontSize: 12.5, lineHeight: 1.7, marginBottom: 8 },
      decisionActions: { marginBottom: 10 },
      decisionAction: {
        fontSize: 11.5,
        lineHeight: 1.7,
        color: 'var(--dsw-alias-label-secondary)',
      },
      decisionForm: { display: 'flex', gap: 8, marginBottom: 10 },
      todoAct: {
        marginLeft: 'auto',
        color: 'var(--dsw-alias-brand-primary)',
        cursor: 'pointer',
        fontSize: 12,
        whiteSpace: 'nowrap',
        background: 'none',
        border: 'none',
        fontFamily: 'inherit',
        padding: 0,
      },

      list: { display: 'flex', flexDirection: 'column' },
      listRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        fontSize: 12.5,
      },
      rowTime: {
        color: 'var(--dsw-alias-label-tertiary)',
        fontVariantNumeric: 'tabular-nums',
        flex: '0 0 66px',
      },
      rowLv: {
        flex: '0 0 auto',
        fontSize: 11,
        padding: '0 6px',
        height: 18,
        borderRadius: 4,
        display: 'inline-flex',
        alignItems: 'center',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      rowName: { flex: '0 0 130px', color: 'var(--dsw-alias-label-primary)' },
      rowTxt: {
        flex: 1,
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },

      form: { display: 'grid', gridTemplateColumns: '190px 1fr', gap: '10px 16px', alignItems: 'center' },
      formK: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12.5 },
      formKSmall: {
        display: 'block',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 11,
        fontWeight: 400,
      },
      input: {
        fontFamily: 'inherit',
        fontSize: 12.5,
        padding: '5px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        width: 130,
      },
      inputWide: {
        fontFamily: 'inherit',
        fontSize: 12.5,
        padding: '6px 9px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        width: '100%',
        minWidth: 0,
      },

      formValue: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 },
      // The two purge scopes as clickable cards rather than a select: the difference
      // between "records" and "everything" is the goal tree, and a dropdown hides
      // that in a collapsed list.
      copyLine: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        padding: '8px 0',
        // Spans both columns of the surrounding 190px/1fr grid. Without this it ate one
        // cell and every following label/input pair landed one slot out of place, which
        // made the reason field a few pixels wide and effectively invisible.
        gridColumn: '1 / -1',
      },
      // Monospace and full width: the id is the thing being confirmed, so it must not
      // be the thing that gets truncated. It was shown only as a placeholder inside a
      // narrow input, and the visible tail was not the id at all.
      copyId: {
        fontFamily: 'ui-monospace, Consolas, monospace',
        fontSize: 12,
        padding: '3px 8px',
        borderRadius: 6,
        border: '1px dashed var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        wordBreak: 'break-all',
        textAlign: 'left',
      },
      scopeChoices: { display: 'flex', flexDirection: 'column', gap: 6 },
      scopeOn: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 8,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        fontSize: 12.5,
        flexWrap: 'wrap',
      },
      scopeOff: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 8,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        fontSize: 12.5,
        flexWrap: 'wrap',
      },
      scopeHint: {
        flexBasis: '100%',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 11,
        marginLeft: 22,
      },
      detailInline: { display: 'flex', alignItems: 'center', flexWrap: 'wrap' },
      actions: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
      button: {
        fontFamily: 'inherit',
        height: 27,
        padding: '0 11px',
        borderRadius: 6,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12.5,
      },
      primary: {
        fontFamily: 'inherit',
        height: 27,
        padding: '0 11px',
        borderRadius: 6,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
        fontSize: 12.5,
      },
      danger: {
        fontFamily: 'inherit',
        height: 27,
        padding: '0 11px',
        borderRadius: 6,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: 12.5,
      },
      small: { height: 23, padding: '0 8px', fontSize: 11.5 },

      pre: {
        margin: '10px 0 0',
        padding: '12px 14px',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        fontFamily: 'ui-monospace, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.7,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: 240,
        overflow: 'auto',
      },

      // minmax(0, 1fr), not 1fr: with a bare 1fr the left column refuses to shrink below
      // its content's intrinsic width, and the browser resolves the overflow by
      // squashing the flexible text inside it — which showed up as goal titles cut
      // to two characters and an ellipsis.
      // A vertical list rather than the earlier two-column tree + detail panel.
      // The panel cost the title 300px of a narrow card, which cut goal names to two
      // characters and made every row ambiguous; expanding in place keeps the full
      // width available and removes the max-height that hid rows below the fold.
      goalList: { display: 'flex', flexDirection: 'column', gap: 6 },
      goalRow: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        overflow: 'hidden',
      },
      goalHead: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        cursor: 'pointer',
        fontSize: 12.5,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      goalHeadOn: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        cursor: 'pointer',
        fontSize: 12.5,
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      goalCaret: {
        flex: '0 0 auto',
        width: 10,
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 10,
      },
      // The connector prefix *is* the structure: monospace and preformatted, so
      // `│  ` and `├─ ` line up, and no colour or weight is doing the work.
      treePrefix: {
        flex: '0 0 auto',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-tertiary)',
        whiteSpace: 'pre',
      },
      // A repair notice, not a hierarchy decoration: only broken links get one.
      treeTag: {
        flex: '0 0 auto',
        fontSize: 10.5,
        padding: '0 5px',
        borderRadius: 4,
        color: 'var(--dsw-alias-label-tertiary)',
        border: '1px dashed var(--dsw-alias-border-l1)',
      },
      goalTitle: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      goalBadge: {
        flex: '0 0 auto',
        fontSize: 10.5,
        padding: '0 6px',
        height: 17,
        borderRadius: 4,
        display: 'inline-flex',
        alignItems: 'center',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      goalBadgeWarn: {
        flex: '0 0 auto',
        fontSize: 10.5,
        padding: '0 6px',
        height: 17,
        borderRadius: 4,
        display: 'inline-flex',
        alignItems: 'center',
        color: 'var(--dsw-alias-state-warning-primary)',
        fontWeight: 600,
      },
      goalBody: {
        padding: '10px 12px 12px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      treeWrap: {
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 320px',
        gap: 14,
        alignItems: 'start',
      },
      tree: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: 8,
        overflow: 'auto',
        maxHeight: 520,
      },
      node: {
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '6px 8px',
        borderRadius: 7,
        cursor: 'pointer',
        fontSize: 12.5,
        lineHeight: 1.4,
      },
      nodeOn: {
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '6px 8px',
        borderRadius: 7,
        cursor: 'pointer',
        fontSize: 12.5,
        lineHeight: 1.4,
        background: 'var(--dsw-alias-bg-layer-2)',
        boxShadow: 'inset 0 0 0 1px var(--dsw-alias-brand-primary)',
      },
      nodeDepth: {
        flex: '0 0 auto',
        fontSize: 10.5,
        color: 'var(--dsw-alias-label-tertiary)',
        fontVariantNumeric: 'tabular-nums',
        width: 20,
        textAlign: 'center',
      },
      nodeTitle: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      nodeCrit: {
        flex: '0 0 auto',
        fontSize: 10.5,
        color: 'var(--dsw-alias-label-tertiary)',
        fontVariantNumeric: 'tabular-nums',
      },
      nodeCritNone: {
        flex: '0 0 auto',
        fontSize: 10.5,
        color: 'var(--dsw-alias-state-warning-primary)',
        fontWeight: 600,
      },
      st: {
        flex: '0 0 auto',
        fontSize: 10.5,
        padding: '0 5px',
        height: 16,
        borderRadius: 3,
        display: 'inline-flex',
        alignItems: 'center',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      detail: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: 14,
        position: 'sticky',
        top: 12,
      },
      detailTitle: { margin: '0 0 3px', fontSize: 13.5, fontWeight: 650 },
      detailPath: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, marginBottom: 12 },
      kv: { display: 'grid', gridTemplateColumns: '82px 1fr', gap: '7px 10px', fontSize: 12 },
      kvK: { color: 'var(--dsw-alias-label-secondary)' },
      kvV: { color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-word' },
      chips: { display: 'flex', flexWrap: 'wrap', gap: 4 },
      chip: {
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      chipNone: {
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 999,
        color: 'var(--dsw-alias-state-warning-primary)',
        border: '1px solid var(--dsw-alias-state-warning-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },

      gloss: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      glossTh: {
        textAlign: 'left',
        color: 'var(--dsw-alias-label-secondary)',
        fontWeight: 600,
        padding: '6px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      glossTd: {
        padding: '6px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        verticalAlign: 'top',
        color: 'var(--dsw-alias-label-secondary)',
      },
      glossTdFirst: {
        padding: '6px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        verticalAlign: 'top',
        whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 600,
      },

      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 },
      ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 12 },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 },
    }

    // ---------------------------------------------------------------- pieces

    /** One labelled number, with the sentence that qualifies it. */
    function Stat(props) {
      return h(
        'div',
        { style: S.stat },
        h('div', { style: S.statK }, props.label),
        h('div', { style: props.warn ? S.statVWarn : S.statV }, props.value),
        props.detail ? h('div', { style: S.statD }, props.detail) : null,
      )
    }

    /** A collapsed help block: explains, and stays out of the way until asked. */
    function Help(props) {
      return h(
        'details',
        { style: S.help },
        h('summary', { style: S.helpSummary }, props.title || '这几个数字是什么意思'),
        h('div', { style: S.helpBody }, props.children),
      )
    }

    /** A card with a heading and optional right-side controls. */
    function Card(props) {
      return h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.cardHead },
          h('h3', { style: S.cardTitle }, props.title),
          props.right ? h('span', { style: S.right }, props.right) : null,
        ),
        props.children,
      )
    }

    /** Key/value rows, two columns. */
    function Rows(props) {
      const entries = (props.entries || []).filter((entry) => entry !== undefined && entry !== null)
      if (entries.length === 0) return h('div', { style: S.muted }, props.empty || '无')
      return h(
        'div',
        { style: S.kv },
        entries.flatMap((entry, index) => [
          h('div', { key: 'k' + index, style: S.kvK }, entry[0]),
          h('div', { key: 'v' + index, style: S.kvV }, entry[1]),
        ]),
      )
    }

    /** One line of a label/control form row. */
    /**
     * Two grid cells: a label column and a control column.
     *
     * Takes the control as an explicit second argument rather than through
     * `props.children`. Every caller wrote `FormRow({...}, h('input', ...))`, which
     * passes the input positionally — and a plain function only ever sees its first
     * argument, so the control was dropped and every row rendered as a label with an
     * empty value cell. Nothing threw; the inputs simply were not there.
     */
    function FormRow(props, control) {
      const id = props.rowId || String(props.label) + '-' + String(props.hint || '')
      return [
        h(
          'div',
          { key: id + '-k', style: S.formK },
          props.label,
          props.hint ? h('small', { style: S.formKSmall }, props.hint) : null,
        ),
        h('div', { key: id + '-v', style: S.formValue }, control),
      ]
    }

    const GLOSSARY = [
      ['判据', '目标上写的「哪些活动算服务于我」。relevantActivities 与 allowedMethods 是能匹配的判据；successCriteria 只是验收条件，不参与匹配。'],
      ['偏离', '活动对不上任何目标，也没有被预先授权。'],
      ['待定', '证据等级不够，程序不下结论。'],
      ['合理探索', '命中了目标的允许方法或相关活动。'],
      ['对齐', '确认服务于某个目标。当前恒为 0，因为多数目标没写判据。'],
      ['信号', '一次升级记录。等级 L0–L3 决定打扰你的程度。'],
      ['干预卡', 'L2 及以上弹出的待决事项，要你选继续 / 纠正 / 改目标 / 忽略。'],
      ['core 矛盾', '由根目标隐含、长期存在、再努力也不会消失的张力。'],
      ['main 矛盾', '此刻正在卡住进度的那个张力。'],
      ['强度', '1–5。由多次观察算趋势，不是模型随口给的。'],
      ['校准', '把分数变成概率。未校准前系统只给分数。'],
    ]

    // ---------------------------------------------------------------- card

    /** The card itself. */
    function MetacogCard(props) {
      const [projects, setProjects] = useState([])
      const [activeId, setActiveId] = useState(null)
      const [tab, setTab] = useState('status')
      const [reports, setReports] = useState([])
      const [open, setOpen] = useState(null)
      // Which cadence the report panel is showing. This is a *view* selector, not
      // an action: switching it used to generate a report as a side effect, so
      // looking at the weekly list silently wrote a weekly file.
      const [reportType, setReportType] = useState('daily')
      // One reason per pending card, keyed by id: two cards can be on screen at
      // once and a single shared field would carry one card's sentence into the
      // other's audit entry.
      const [decisionReason, setDecisionReason] = useState({})
      // The goal being edited, as a draft of the fields the card can change. Null
      // when no edit form is open.
      const [goalDraft, setGoalDraft] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [introOpen, setIntroOpen] = useState(true)
      const [nodeId, setNodeId] = useState(null)
      const [usage, setUsage] = useState(null)
      const [llm, setLlm] = useState(null)
      const [milestoneLabel, setMilestoneLabel] = useState('')
      const [milestoneNote, setMilestoneNote] = useState('')
      // Archived milestones, newest first. Archive used to be write-only: a
      // milestone could be recorded but never seen again, so the comparison it
      // exists for had both halves on disk with no way to line them up.
      const [milestones, setMilestones] = useState([])
      const [openMilestone, setOpenMilestone] = useState(null)
      const [purgeId, setPurgeId] = useState('')
      const [purgeReason, setPurgeReason] = useState('')
      const [purgeScope, setPurgeScope] = useState('records')
      const [purgeTarget, setPurgeTarget] = useState(null)
      const [editable, setEditable] = useState([])
      const [drafts, setDrafts] = useState({})
      // Realtime monitor: the model catalog is a separate read, and its failure
      // must stay visible rather than collapsing into an empty dropdown.
      const [models, setModels] = useState([])
      const [modelsError, setModelsError] = useState(null)
      const [manualProvider, setManualProvider] = useState('')
      const [manualModel, setManualModel] = useState('')
      // Recent verdicts, newest first, as returned by the route.
      const [verdicts, setVerdicts] = useState([])
      const [verdictError, setVerdictError] = useState(null)
      // A criteria suggestion is staged here; nothing is written until the user
      // ticks items and presses confirm.
      const [criteriaDraft, setCriteriaDraft] = useState(null)
      const [criteriaSelected, setCriteriaSelected] = useState({})

      const load = useCallback(async (options) => {
        const clearError = !options || options.clearError !== false
        const result = await api('/api/metacog/projects')
        if (!result || !result.ok) {
          setError((result && result.error) || '无法读取监控数据')
          return
        }
        // Only the initial load and a deliberate refresh clear the error. An action that
        // failed and then reloaded the list used to have its message wiped here, which is
        // why a rejected delete looked like a button that did nothing.
        if (clearError) setError(null)
        setProjects(result.projects || [])
        setActiveId(
          (current) => current || (result.projects && result.projects[0] && result.projects[0].projectId) || null,
        )
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const active = useMemo(
        () => projects.find((project) => project.projectId === activeId),
        [projects, activeId],
      )

      // Defaults to the active project, but is its own choice: a settings page that can
      // only clean up the directory it happens to be opened from forces the user to
      // switch workspaces just to delete something.
      const purgeTargetProject = useMemo(
        () => projects.find((project) => project.projectId === purgeTarget) || active,
        [projects, purgeTarget, active],
      )
      const purgeTargetId = (purgeTargetProject && purgeTargetProject.projectId) || ''

      const loadReports = useCallback(async (projectId) => {
        if (!projectId) return
        const result = await api('/api/metacog/reports?projectId=' + encodeURIComponent(projectId))
        setReports(result && result.ok ? result.reports || [] : [])
      }, [])

      useEffect(() => {
        if (activeId) loadReports(activeId)
      }, [activeId, loadReports])

      const loadUsage = useCallback(async (projectId) => {
        if (!projectId) {
          setUsage(null)
          return
        }
        const result = await api('/api/metacog/usage?projectId=' + encodeURIComponent(projectId))
        setUsage(result && result.ok ? result.usage : null)
      }, [])

      useEffect(() => {
        loadUsage(activeId)
      }, [activeId, loadUsage])

      const loadMilestones = useCallback(async (projectId) => {
        if (!projectId) {
          setMilestones([])
          return
        }
        const result = await api('/api/metacog/milestone?projectId=' + encodeURIComponent(projectId))
        setMilestones(result && result.ok ? result.milestones : [])
      }, [])

      useEffect(() => {
        loadMilestones(activeId)
      }, [activeId, loadMilestones])

      useEffect(() => {
        api('/api/metacog/llm').then((result) => setLlm(result && result.ok ? result.llm : null))
      }, [])

      const loadSettings = useCallback(async () => {
        const result = await api('/api/metacog/settings')
        setEditable(result && result.ok ? result.editable || [] : [])
      }, [])

      useEffect(() => {
        loadSettings()
      }, [loadSettings])

      const loadModels = useCallback(async () => {
        const result = await api('/api/metacog/models')
        if (!result || !result.ok) {
          setModels([])
          setModelsError((result && result.error) || '无法读取模型列表')
          return
        }
        setModels(result.providers || [])
        setModelsError(null)
      }, [])

      useEffect(() => {
        loadModels()
      }, [loadModels])

      const loadVerdicts = useCallback(async (projectId) => {
        if (!projectId) {
          setVerdicts([])
          return
        }
        const result = await api(
          '/api/metacog/verdicts?projectId=' + encodeURIComponent(projectId) + '&limit=20',
        )
        if (!result || !result.ok) {
          setVerdicts([])
          setVerdictError((result && result.error) || '无法读取判定记录')
          return
        }
        setVerdicts(result.verdicts || [])
        setVerdictError(null)
      }, [])

      useEffect(() => {
        loadVerdicts(activeId)
      }, [activeId, loadVerdicts])

      // Feedback is keyed by the panel that produced it.
      //
      // A single bar at the top of the card was reported twice as easy to miss: the
      // click happened at the bottom of a long settings page and the message
      // appeared somewhere else entirely. So each action names its scope and the
      // message renders next to the buttons that caused it.
      //
      // The success/error asymmetry stays: a success clears itself, an error does
      // not, because an error is something the user has to read and act on.
      const noticeTimer = useRef(null)
      const [feedback, setFeedback] = useState({})
      const showNotice = useCallback((scope, message) => {
        setFeedback((current) => ({ ...current, [scope]: { kind: 'notice', text: message } }))
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => {
          setFeedback((current) => {
            const entry = current[scope]
            if (entry === undefined || entry.kind !== 'notice') return current
            const next = { ...current }
            delete next[scope]
            return next
          })
          noticeTimer.current = null
        }, 3000)
      }, [])
      const showError = useCallback((scope, message) => {
        setFeedback((current) => ({ ...current, [scope]: { kind: 'error', text: message } }))
      }, [])
      const clearFeedback = useCallback((scope) => {
        setFeedback((current) => {
          if (current[scope] === undefined) return current
          const next = { ...current }
          delete next[scope]
          return next
        })
      }, [])
      // Cancel a pending dismissal on unmount so it cannot touch a dead component.
      useEffect(
        () => () => {
          if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
        },
        [],
      )

      /**
       * Render whatever feedback belongs to one panel.
       *
       * @param scope - the panel name the action was invoked from.
       */
      const feedbackFor = (scope) => {
        const entry = feedback[scope]
        if (entry === undefined) return null
        return h('div', { style: entry.kind === 'error' ? S.dangerBar : S.noticeBar }, entry.text)
      }

      const act = useCallback(
        async (scope, run) => {
          setBusy(true)
          clearFeedback(scope)
          try {
            const outcome = await run()
            if (outcome && outcome.ok) showNotice(scope, outcome.message || '完成')
            else {
              const detail = (outcome && outcome.error) || '操作失败'
              const status = outcome && outcome.status
              showError(scope, status === undefined ? detail : detail + '（HTTP ' + status + '）')
            }
            // Keep the message on screen when the action failed; refresh silently when
            // it worked.
            await load({ clearError: outcome !== undefined && outcome.ok === true })
            if (activeId) {
              await loadReports(activeId)
              await loadUsage(activeId)
            }
          } finally {
            setBusy(false)
          }
        },
        [activeId, clearFeedback, load, loadReports, loadUsage, showError, showNotice],
      )

      const generate = useCallback(
        (type) =>
          act('reports', async () => {
            const result = await api('/api/metacog/report', 'POST', { projectId: activeId, type })
            return result && result.ok
              ? { ok: true, message: '已生成报告 ' + result.report.type + '（' + result.report.chars + ' 字）' }
              : result
          }),
        [act, activeId],
      )

      // Opening the file or its folder is a shell action on the host, not a
      // download: the file already exists next to the project's data. `at` picks
      // the period's bucket, so the button opens the period being looked at
      // rather than today's file.
      const openReport = useCallback(
        (what) => {
          const newest = reports.filter((report) => report.type === reportType)[0]
          const at = newest ? newest.periodEnd : new Date().toISOString()
          return act('reports', async () => {
            const result = await api('/api/metacog/report/open', 'POST', {
              projectId: activeId,
              type: reportType,
              what,
              at,
            })
            if (!result || !result.ok) {
              return { ok: false, error: (result && result.error) || '打开失败' }
            }
            return { ok: true, message: what === 'folder' ? '已打开报告目录' : '已用系统默认程序打开报告' }
          })
        },
        [act, activeId, reportType, reports],
      )

      // Settle one pending card. The reason is required by the route, and the
      // button is disabled until it is present, so a missing reason never reaches
      // the server.
      const settle = useCallback(
        (interventionId, decision) =>
          act('todo', async () => {
            const rationale = (decisionReason[interventionId] || '').trim()
            if (rationale.length === 0) {
              return { ok: false, error: '先写一句理由' }
            }
            const result = await api('/api/metacog/intervention', 'POST', {
              projectId: activeId,
              interventionId,
              decision,
              rationale,
            })
            if (!result || !result.ok) return result
            // Drop the reason once it has been recorded: leaving it would attach
            // this sentence to the next card that appears in the same slot.
            setDecisionReason((current) => {
              const next = { ...current }
              delete next[interventionId]
              return next
            })
            return { ok: true, message: '已记录决定：' + decision }
          }),
        [act, activeId, decisionReason],
      )

      // Save one goal edit. The version comes from the payload the card is showing,
      // so a tree someone else changed in the meantime is refused rather than
      // overwritten — the same compare-and-set the tool enforces for a model.
      const saveGoal = useCallback(
        () =>
          act('tree', async () => {
            const draft = goalDraft
            if (draft === null) return { ok: false, error: '没有正在编辑的目标' }
            if (draft.reason.trim().length === 0) return { ok: false, error: '先写一句改它的理由' }
            const updates = {
              id: draft.id,
              title: draft.title,
              description: draft.description,
              status: draft.status,
              priority: Number(draft.priority) || 0,
              // An empty string clears the deadline, which is what the tool
              // documents; leaving it out would silently keep the old one.
              deadline: draft.deadline,
              paths: String(draft.pathsText || '')
                .split('\n')
                .map((item) => item.trim())
                .filter((item) => item.length > 0),
            }
            const result = await api('/api/metacog/tree/edit', 'POST', {
              projectId: activeId,
              args: { expectedVersion: draft.version, updates: [updates], reason: draft.reason },
            })
            if (!result || !result.ok) return result
            setGoalDraft(null)
            return { ok: true, message: '已保存「' + draft.title + '」' }
          }),
        [act, activeId, goalDraft],
      )

      const archive = useCallback(
        () =>
          act('data', async () => {
            const result = await api('/api/metacog/signals/archive', 'POST', { projectId: activeId })
            if (!result || !result.ok) return result
            return {
              ok: true,
              message:
                result.archived === 0
                  ? '当前信号流为空，没有可归档的内容'
                  : '已归档 ' + result.archived + ' 条信号',
            }
          }),
        [act, activeId],
      )

      const sweep = useCallback(
        () =>
          act('data', async () => {
            const result = await api('/api/metacog/sweep', 'POST', { projectId: activeId })
            if (!result || !result.ok) return result
            const s = result.sweep
            return {
              ok: true,
              message: s.ran
                ? '巡检完成：' + s.hints.length + ' 条提示，用时 ' + s.elapsedMs + ' ms'
                : '巡检没有运行：这个项目不在守护列表里',
            }
          }),
        [act, activeId],
      )

      const archiveMilestone = useCallback(
        () =>
          act('milestone', async () => {
            if (milestoneLabel.trim().length === 0) return { ok: false, error: '先给这个里程碑起个名字' }
            // The note is optional: requiring it produced one-word answers, and the
            // label plus the snapshot already identify what was archived.
            const result = await api('/api/metacog/milestone', 'POST', {
              projectId: activeId,
              label: milestoneLabel.trim(),
              note: milestoneNote.trim(),
            })
            if (!result || !result.ok) return result
            setMilestoneLabel('')
            setMilestoneNote('')
            // Refresh the list so the new entry appears without a reload: an
            // archive action whose result is invisible is one you press twice.
            await loadMilestones(activeId)
            return { ok: true, message: '已归档版本 ' + result.version + ' 的快照与判定统计' }
          }),
        [act, activeId, milestoneLabel, milestoneNote, loadMilestones],
      )

      // Open one archived milestone in full: the tree it captured and the counts
      // beside it. That is the pair the archive exists to preserve.
      const showMilestone = useCallback(
        (path) =>
          act('milestone', async () => {
            const result = await api(
              '/api/metacog/milestone?projectId=' +
                encodeURIComponent(activeId) +
                '&milestonePath=' +
                encodeURIComponent(path),
            )
            if (!result || !result.ok) return result
            setOpenMilestone(result.milestone)
            return { ok: true, message: '' }
          }),
        [act, activeId],
      )

      const purge = useCallback(
        () =>
          act('danger', async () => {
            const target = purgeTargetProject && purgeTargetProject.projectId
            if (!target) return { ok: false, error: '先选要删除的项目' }
            if (purgeId.trim() !== target) return { ok: false, error: '输入的 id 与所选项目不符' }
            const result = await api('/api/metacog/purge', 'POST', {
              projectId: target,
              confirmProjectId: purgeId.trim(),
              reason: purgeReason.trim(),
              scope: purgeScope,
            })
            if (!result || !result.ok) return result
            const d = result.purged
            setPurgeId('')
            setPurgeReason('')
            if (d.empty === true) {
              // "0 directories, 0 files" is indistinguishable from a broken button. This
              // project had nothing but an empty tree file, and saying so is the answer.
              return {
                ok: true,
                message:
                  '这个项目本来就没有可删的记录 —— 只有一个空的目标树文件。' +
                  (purgeScope === 'everything' ? '现在它也被删掉了。' : '选「全部清空」可以连它一起删。'),
              }
            }
            return {
              ok: true,
              message:
                '已删除 ' + (d.deleted || []).length + ' 个目录、' + (d.files || 0) +
                ' 个文件（' + size(d.bytes) + '）。' +
                (purgeScope === 'everything' ? '目标树也已删除。' : '目标树未受影响。'),
            }
          }),
        [act, purgeTargetProject, purgeId, purgeReason, purgeScope],
      )

      /**
       * One numeric setting, as the two grid cells the parameters card uses.
       *
       * Returns an array because the card lays label and control out as siblings
       * in a two-column grid; `FormRow` would nest them and break that layout.
       * Seven copies of this existed inline and had already drifted — one compared
       * against the wrong key and never showed its save button.
       */
      const numberField = (path, label, hint, min, max, step) => [
        h(
          'div',
          { key: path + '-k', style: S.formK },
          label,
          h('small', { style: S.formKSmall }, hint),
        ),
        h(
          'div',
          { key: path + '-v', style: S.detailInline },
          h('input', {
            style: S.input,
            type: 'number',
            min,
            max,
            step,
            value: String(valueOf(path, '')),
            onChange: (event) =>
              setDrafts({ ...drafts, [path]: event.target.value === '' ? '' : Number(event.target.value) }),
          }),
          isDirty(path)
            ? h(
                'button',
                {
                  type: 'button',
                  style: Object.assign({}, S.primary, S.small, { marginLeft: 8 }),
                  disabled: busy,
                  onClick: () => saveSetting(path),
                },
                '保存',
              )
            : null,
        ),
      ]

      const saveSetting = useCallback(
        (path) =>
          act('settings', async () => {
            const value = drafts[path]
            const result = await api('/api/metacog/settings', 'POST', { path, value })
            if (!result || !result.ok) return result
            await loadSettings()
            setDrafts((current) => {
              const next = { ...current }
              delete next[path]
              return next
            })
            return { ok: true, message: '已保存 ' + path + '，重启 DSH 后生效' }
          }),
        [act, drafts, loadSettings],
      )

      /**
       * Save the realtime provider/model pair.
       *
       * The settings route writes one path per request, so a model choice is two
       * writes. Doing them in one `act` keeps a half-saved pair (provider without
       * model) from looking like success.
       */
      const saveRealtimeModel = useCallback(
        (provider, model) =>
          act('settings', async () => {
            const [providerWrite, modelWrite] = realtimeSettingsPayload(provider, model)
            const first = await api('/api/metacog/settings', 'POST', providerWrite)
            if (!first || !first.ok) return first
            const second = await api('/api/metacog/settings', 'POST', modelWrite)
            if (!second || !second.ok) return second
            await loadSettings()
            return {
              ok: true,
              message:
                provider === '' || model === ''
                  ? '已保存：实时监控跟随全局模型'
                  : '已保存实时监控模型：' + provider + ' / ' + model + '，重启 DSH 后生效',
            }
          }),
        [act, loadSettings],
      )

      /** Ask the backend for criteria suggestions; stage them, never write. */
      const draftCriteria = useCallback(
        (node) =>
          act('criteria', async () => {
            const result = await api('/api/metacog/criteria', 'POST', {
              projectId: activeId,
              goalIds: [node.id],
            })
            if (!result || !result.ok) return result
            const suggestion = (result.suggestions || []).find((item) => item.goalId === node.id)
            if (!suggestion) return { ok: false, error: '模型没有给出这个目标的判据建议' }
            if (suggestion.status !== 'suggested' || suggestion.relevantActivities.length === 0) {
              return {
                ok: false,
                error:
                  suggestion.reason ||
                  '模型没能给出可用判据；没有把空数组当成「没有建议」',
              }
            }
            const selected = {}
            for (const item of suggestion.relevantActivities) selected[item] = true
            setCriteriaDraft({
              nodeId: node.id,
              title: node.title,
              version: (active && active.version) || 0,
              suggestion,
            })
            setCriteriaSelected(selected)
            return { ok: true, message: '建议已生成：勾选后点「确认写入」，不会自动改树' }
          }),
        [act, activeId, active],
      )

      /** Write only the ticked criteria, through the governed tree-edit route. */
      const confirmCriteria = useCallback(
        () =>
          act('criteria', async () => {
            if (criteriaDraft === null) return { ok: false, error: '没有待确认的判据建议' }
            const picked = criteriaDraft.suggestion.relevantActivities.filter(
              (item) => criteriaSelected[item] === true,
            )
            if (picked.length === 0) return { ok: false, error: '至少勾选一条判据再确认' }
            const result = await api('/api/metacog/tree/edit', 'POST', {
              projectId: activeId,
              args: {
                expectedVersion: criteriaDraft.version,
                updates: [
                  {
                    id: criteriaDraft.nodeId,
                    relevantActivities: picked,
                    excludedActivities: criteriaDraft.suggestion.excludedActivities || [],
                  },
                ],
                reason: '用户确认采纳判据建议',
              },
            })
            if (!result || !result.ok) return result
            setCriteriaDraft(null)
            setCriteriaSelected({})
            await load({ clearError: false })
            return { ok: true, message: '已写入勾选的判据' }
          }),
        [act, activeId, criteriaDraft, criteriaSelected, load],
      )


      const valueOf = useCallback(
        (path, fallback) => {
          if (Object.prototype.hasOwnProperty.call(drafts, path)) return drafts[path]
          const entry = editable.find((item) => item.path === path)
          return entry === undefined ? fallback : entry.value
        },
        [drafts, editable],
      )

      const isDirty = useCallback(
        (path) => Object.prototype.hasOwnProperty.call(drafts, path),
        [drafts],
      )

      const show = useCallback(
        async (reportId) => {
          if (open && open.id === reportId) {
            setOpen(null)
            return
          }
          const result = await api(
            '/api/metacog/report?projectId=' +
              encodeURIComponent(activeId) +
              '&reportId=' +
              encodeURIComponent(reportId),
          )
          if (result && result.ok) setOpen(result.report)
        },
        [activeId, open],
      )

      // The bundle list asks for one line; the full card belongs to `page`.
      // All hooks above have run, so this early return cannot change hook order.
      if (props && props.view === 'summary') {
        const head = active || projects[0]
        if (!head) return h('div', { style: S.muted }, '元认知监控 · 还没有已建树的项目')
        return h(
          'div',
          { style: S.muted },
          '元认知监控 · ' +
            num(head.goals.total) +
            ' 目标 · ' +
            num(head.activities.total) +
            ' 活动 · ' +
            num(head.judgments.pending) +
            ' 待复核',
        )
      }

      if (error && projects.length === 0) {
        return h('div', { style: S.root }, h('div', { style: S.error }, error))
      }

      if (projects.length === 0) {
        return h(
          'div',
          { style: S.root },
          error ? h('div', { style: S.dangerLine }, error) : null,
          h(
            'div',
            { style: S.muted },
            '这个工作区还没有已确认的目标树。先用 goal_tree_init 与 goal_tree_confirm 建树，卡片就会显示统计数据。',
          ),
        )
      }

      // ---------------------------------------------------------- tab: status

      const statusTab = () => {
        const counts = (active && active.activities) || EMPTY
        const total = Number(counts.total) || 0
        // Only the selected cadence is listed: the panel is a view of one file
        // per cadence now, so mixing three streams into one list made the counts
        // meaningless.
        const shownReports = reports.filter((report) => report.type === reportType)
        const parts = [
          { key: 'scopeDrift', label: '偏离', value: Number(counts.scopeDrift) || 0 },
          { key: 'uncertain', label: '待定', value: Number(counts.uncertain) || 0 },
          { key: 'exploratory', label: '合理探索', value: Number(counts.exploratory) || 0 },
          { key: 'aligned', label: '对齐', value: Number(counts.aligned) || 0 },
        ]
        const gap = (active && active.criteriaGap) || EMPTY
        const missing = Number(gap.missing) || 0
        const goalsTotal = Number(gap.total) || 0
        // Computed server-side by the same function the report prints, so the two
        // cannot disagree about how far along the tree is.
        const progress = (active && active.progress) || null

        return [
          // ---------------- 当前状态
          h(
            Card,
            {
              key: 'status',
              title: '当前状态',
              right: h('span', { style: S.muted }, active ? 'v' + active.version + ' · ' + when(active.updatedAt) : ''),
            },
            h(
              Help,
              null,
              h('div', null, h('b', null, '活动'), '：监控记下的每一条行为（改文件、跑命令、提问、汇报）。'),
              h('div', null, h('b', null, '待复核'), '：程序觉得可能偏了、但还没让模型看过的条数。'),
              h('div', null, h('b', null, '活跃信号'), '：已经升级到需要你注意的偏离记录；归档的是历史噪音。'),
              h('div', null, h('b', null, '分布条'), '：所有活动被判成了什么。判定只有四种，见下面图例。'),
            ),
            // Overall completion, at the top of the status tab.
            //
            // The data was already computed for the report; the card simply never
            // showed it, so "how far along is this project" could only be answered
            // by generating a report. The per-depth bars are there because a single
            // ratio hides which layer is stuck.
            progress && progress.totalGoals > 0
              ? h(
                  'div',
                  { style: S.progressBlock },
                  h(
                    'div',
                    { style: S.progressHead },
                    h('span', { style: S.progressLabel }, '完成度'),
                    h('span', { style: S.progressValue }, Math.round((Number(progress.completion) || 0) * 100) + '%'),
                    h(
                      'span',
                      { style: S.progressDetail },
                      progress.doneGoals + '/' + progress.totalGoals + ' 个目标' +
                        (progress.totalContradictions > 0
                          ? ' · 矛盾 ' + progress.resolvedContradictions + '/' + progress.totalContradictions + ' 已解决'
                          : ''),
                    ),
                  ),
                  h(
                    'div',
                    { style: S.progressBar },
                    h('i', {
                      style: {
                        display: 'block',
                        width: Math.round((Number(progress.completion) || 0) * 100) + '%',
                        background: 'var(--dsw-alias-state-success-primary)',
                        opacity: 0.8,
                      },
                    }),
                  ),
                  Array.isArray(progress.byDepth) && progress.byDepth.length > 1
                    ? h(
                        'div',
                        { style: S.progressDepths },
                        progress.byDepth.map((row) =>
                          h(
                            'div',
                            { key: 'd' + row.depth, style: S.progressDepthRow },
                            h('span', { style: S.progressDepthLabel }, 'depth-' + row.depth),
                            h(
                              'span',
                              { style: S.progressDepthBar },
                              h('i', {
                                style: {
                                  display: 'block',
                                  width: (row.total === 0 ? 0 : Math.round((row.done / row.total) * 100)) + '%',
                                  background: 'var(--dsw-alias-brand-primary)',
                                  opacity: 0.75,
                                },
                              }),
                            ),
                            h('span', { style: S.progressDepthValue }, row.done + '/' + row.total),
                          ),
                        ),
                      )
                    : null,
                )
              : null,
            h(
              'div',
              { style: S.stats },
              h(Stat, { label: '活动', value: num(total), detail: '最近 ' + when(counts.lastAt) }),              h(Stat, { label: '待复核', value: num(active && active.judgments.pending), detail: '已复核 ' + num(active && active.judgments.dismissed) }),
              h(Stat, { label: '待决干预卡', value: num(active && active.interventions.pending), detail: '共 ' + num(active && active.interventions.total) + ' 张' }),
              h(Stat, {
                label: '活跃信号',
                value: num(active && active.signals.live),
                detail: '归档后从零计',
                warn: Number(active && active.signals.live) > 0,
              }),
            ),
            total > 0
              ? h(
                  'div',
                  null,
                  h(
                    'div',
                    { style: S.bar },
                    parts.map((part) =>
                      h('i', {
                        key: part.key,
                        style: {
                          display: 'block',
                          width: (part.value / total) * 100 + '%',
                          background:
                            part.key === 'scopeDrift'
                              ? 'var(--dsw-alias-state-error-primary)'
                              : part.key === 'uncertain'
                                ? 'var(--dsw-alias-label-tertiary)'
                                : part.key === 'exploratory'
                                  ? 'var(--dsw-alias-brand-primary)'
                                  : 'var(--dsw-alias-state-success-primary)',
                          opacity: part.key === 'scopeDrift' ? 0.55 : 0.75,
                        },
                      }),
                    ),
                  ),
                  h(
                    'div',
                    { style: S.legend },
                    parts.map((part) =>
                      h(
                        'span',
                        { key: part.key, style: S.legendItem },
                        h('i', {
                          style: Object.assign({}, S.sw, {
                            background:
                              part.key === 'scopeDrift'
                                ? 'var(--dsw-alias-state-error-primary)'
                                : part.key === 'uncertain'
                                  ? 'var(--dsw-alias-label-tertiary)'
                                  : part.key === 'exploratory'
                                    ? 'var(--dsw-alias-brand-primary)'
                                    : 'var(--dsw-alias-state-success-primary)',
                            opacity: part.key === 'scopeDrift' ? 0.55 : 0.75,
                          }),
                        }),
                        part.label + ' ',
                        h('b', null, num(part.value)),
                      ),
                    ),
                  ),
                )
              : null,
            // The one paragraph that keeps the bar from being misread. Without it
            // "80% drift" reads as a verdict on the user's work, when it is usually
            // a statement about the yardstick.
            missing > 0
              ? h(
                  'div',
                  { style: S.warnLine },
                  '这 ' +
                    num(parts[0].value) +
                    ' 条「偏离」里，绝大多数其实是对不上任何目标——而 ' +
                    num(goalsTotal) +
                    ' 个目标里有 ' +
                    num(missing) +
                    ' 个根本没写可匹配的判据。所以这个比例反映的是判据缺口，不是你做的事真的跑偏了。',
                )
              : null,
          ),

          // ---------------- 需要你处理
          h(
            Card,
            { key: 'todo', title: '需要你处理' },
            // The decision cards below own the settle buttons, so their feedback
            // belongs here rather than at the top of the page.
            missing > 0
              ? h(
                  'div',
                  { style: S.todo },
                  h('span', { style: S.stRowTag }, '判据缺口'),
                  h(
                    'div',
                    { style: S.todoBody },
                    h('div', { style: S.todoT }, num(missing) + ' 个目标没有可匹配判据'),
                    h(
                      'div',
                      { style: S.todoS },
                      '「对齐」恒为 0 的直接原因。补 relevantActivities 或 allowedMethods 即可。',
                    ),
                  ),
                  h(
                    'button',
                    { type: 'button', style: S.todoAct, onClick: () => setTab('tree') },
                    '去看树 →',
                  ),
                )
              : h(
                  'div',
                  { style: S.todo },
                  h('span', { style: S.stRowTagOk }, '判据齐备'),
                  h('div', { style: S.todoBody }, h('div', { style: S.todoT }, '每个目标都有可匹配的判据')),
                ),
            Number(active && active.judgments.pending) > 0
              ? h(
                  'div',
                  { style: S.todo },
                  h('span', { style: S.stRowTagInfo }, '待复核'),
                  h(
                    'div',
                    { style: S.todoBody },
                    h('div', { style: S.todoT }, num(active.judgments.pending) + ' 条判定候选等待模型复核'),
                    h('div', { style: S.todoS }, '复核要会话上下文，用 /metacog-check 或在工具里触发'),
                  ),
                )
              : null,
            (active && active.interventions && active.interventions.open ? active.interventions.open : []).length > 0
              ? h(
                  'div',
                  null,
                  h(
                    'div',
                    { style: S.todo },
                    h('span', { style: S.stRowTagWarn }, '待决策'),
                    h(
                      'div',
                      { style: S.todoBody },
                      h('div', { style: S.todoT }, num(active.interventions.pending) + ' 张干预卡等待你决定'),
                      // Settling used to require a tool call in a conversation, so
                      // the card could list a decision but never take one — which is
                      // why the feedback channels stayed empty.
                      h('div', { style: S.todoS }, '直接在这里决定；理由会写进审计记录'),
                    ),
                  ),
                  active.interventions.open.map((card) =>
                    h(
                      'div',
                      { key: card.id, style: S.decisionCard },
                      h(
                        'div',
                        { style: S.decisionHead },
                        h('span', { style: S.stRowTagWarn }, 'L' + card.level),
                        h('span', { style: S.decisionWhen }, when(card.createdAt)),
                        h('span', { style: S.decisionId }, card.id),
                      ),
                      h('div', { style: S.decisionSummary }, card.promptSummary),
                      (card.suggestedActions || []).length > 0
                        ? h(
                            'div',
                            { style: S.decisionActions },
                            card.suggestedActions.map((action, index) =>
                              h('div', { key: 'a' + index, style: S.decisionAction }, '· ' + action),
                            ),
                          )
                        : null,
                      h(
                        'div',
                        { style: S.decisionForm },
                        h('input', {
                          style: S.inputWide,
                          type: 'text',
                          placeholder: '为什么这样决定（必填，写进审计）',
                          value: decisionReason[card.id] || '',
                          onChange: (event) =>
                            setDecisionReason({ ...decisionReason, [card.id]: event.target.value }),
                        }),
                      ),
                      h(
                        'div',
                        { style: S.actions },
                        DECISION_LABELS.map(([key, label, hint]) =>
                          h(
                            'button',
                            {
                              key,
                              type: 'button',
                              title: hint,
                              style: key === 'dismiss' ? S.button : S.primary,
                              disabled: busy || (decisionReason[card.id] || '').trim().length === 0,
                              onClick: () => settle(card.id, key),
                            },
                            label,
                          ),
                        ),
                      ),
                      (decisionReason[card.id] || '').trim().length === 0
                        ? h('div', { style: S.muted }, '先写一句理由，按钮才会亮')
                        : null,
                    ),
                  ),
                )
              : h(
                  'div',
                  { style: S.todo },
                  h('span', { style: S.stRowTagOk }, '无待办'),
                  h('div', { style: S.todoBody }, h('div', { style: S.todoT }, '没有待决干预卡')),
                ),
          ),

          // ---------------- 判断可信度
          h(
            Card,
            { key: 'trust', title: '判断可信度' },
            h(
              Help,
              { title: '这些数字为什么这么难看' },
              h(
                'div',
                null,
                '四条反馈通道实测都枯竭了：干预卡 3 张已结、0 条确认；判定记录全部是驳回或待复核；' +
                  '驳回原因全同一个判定。正类样本为 0，所以算不出精确率，阈值也没有校准过。',
              ),
            ),
            h(Rows, {
              entries: [
                ['已结算判定', num(active && active.judgments.dismissed) + ' 条（全部驳回）'],
                ['已确认为正类', num(active && active.judgments.confirmed) + ' 条'],
                ['精确率', '算不出（没有正类）'],
                ['阈值', '未校准，只是起点值'],
              ],
            }),
            h(
              'div',
              { style: S.warnLine },
              '在拿到正类样本之前，所有分数都只是「可疑程度」，不是概率。别把 L1 提示当成结论。',
            ),
          ),

          // ---------------- 实时判定
          h(
            Card,
            {
              key: 'verdicts',
              title: '实时判定',
              right: h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('span', { style: S.muted }, num(verdicts.length) + ' 条'),
                h(
                  'button',
                  {
                    type: 'button',
                    style: S.button,
                    disabled: busy,
                    onClick: () => loadVerdicts(activeId),
                  },
                  '刷新',
                ),
              ),
            },
            verdictError === null
              ? null
              : h('div', { style: S.dangerLine }, '判定记录读取失败：' + verdictError),
            verdicts.length === 0
              ? h('div', { style: S.muted }, '还没有判定记录。打开实时监控后，每轮判定会写在这里。')
              : h(
                  'div',
                  { style: S.list },
                  verdicts.map((record) =>
                    h(
                      'div',
                      { key: record.id, style: Object.assign({}, S.listRow, { alignItems: 'flex-start' }) },
                      h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: 3, flex: 1 } },
                        h(
                          'div',
                          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                          h('span', { style: S.rowTime }, when(record.at)),
                          h(
                            'span',
                            { style: S.goalBadge },
                            verdictMatchLabel(record.match),
                          ),
                          h(
                            'span',
                            { style: S.muted },
                            record.goalTitle || record.goalId || '未命中目标',
                          ),
                          verdictFulfilledLabel(record.fulfilled) === ''
                            ? null
                            : h(
                                'span',
                                { style: S.muted },
                                verdictFulfilledLabel(record.fulfilled),
                              ),
                        ),
                        h('div', { style: S.rowTxt }, record.reason || '（没有理由）'),
                        record.expectNext
                          ? h('div', { style: S.muted }, '预期下一步：' + record.expectNext)
                          : null,
                      ),
                    ),
                  ),
                ),
          ),

          // ---------------- 报告
          h(
            Card,
            {
              key: 'reports',
              title: '报告',
              right: h('span', { style: S.muted }, num(shownReports.length) + ' 份' + REPORT_LABELS[reportType]),
            },
            feedbackFor('reports'),
            feedbackFor('todo'),
            // Feedback sits directly above this panel's buttons. That is where the
            // click happens, so a message about opening or generating a report is
            // read without hunting for it.
            busy ? h('div', { style: S.busyBar }, '处理中…') : null,
            // Switching a cadence only changes what is listed. Generating is the
            // button beside it, so browsing the weekly list cannot write a file.
            h(
              'div',
              { style: S.actions },
              ['daily', 'weekly', 'monthly'].map((cadence) =>
                h(
                  'button',
                  {
                    key: cadence,
                    type: 'button',
                    style: cadence === reportType ? S.primary : S.button,
                    disabled: busy,
                    onClick: () => {
                      setReportType(cadence)
                      setOpen(null)
                    },
                  },
                  REPORT_LABELS[cadence],
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: Object.assign({}, S.button, { marginLeft: 10 }),
                  disabled: busy,
                  onClick: () => generate(reportType),
                },
                '生成' + REPORT_LABELS[reportType],
              ),
            ),
            h(
              'div',
              { style: Object.assign({}, S.actions, { marginTop: 8 }) },
              h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => openReport('file') }, '打开报告文件'),
              h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => openReport('folder') }, '打开报告目录'),
            ),
            h(
              'div',
              { style: Object.assign({}, S.muted, { marginTop: 8 }) },
              REPORT_HINTS[reportType],
            ),
            shownReports.length === 0
              ? h('div', { style: Object.assign({}, S.muted, { marginTop: 10 }) }, '还没有生成过' + REPORT_LABELS[reportType])
              : h(
                  'div',
                  { style: Object.assign({}, S.list, { marginTop: 6 }) },
                  shownReports
                    .slice()
                    .reverse()
                    .map((report) =>
                      h(
                        'div',
                        {
                          key: report.id,
                          style: Object.assign({}, S.listRow, { cursor: 'pointer' }),
                          onClick: () => show(report.id),
                        },
                        h('span', { style: S.rowTime }, when(report.periodStart) + ' → ' + when(report.periodEnd)),
                        h('span', { style: S.muted }, 'v' + report.goalTreeVersion),
                        h('span', { style: { marginLeft: 'auto' } }, report.chars + ' 字'),
                      ),
                    ),
                ),
            open ? h('pre', { style: S.pre }, open.markdown) : null,
          ),
        ]
      }

      // ------------------------------------------------------------ tab: tree

      const treeTab = () => {
        const nodes = (active && active.nodes) || []
        const contradictions = (active && active.contradictionNodes) || []
        const selected = nodes.find((node) => node.id === nodeId)

        return [
          h(
            Card,
            {
              key: 'tree',
              title: '目标树',
              right: h('span', { style: S.muted }, num(nodes.length) + ' 个节点'),
            },
            h(
              Help,
              { title: '这些数字与标记是什么意思' },
              h(
                'div',
                null,
                '缩进与 `├─`/`└─` 表示父子关系：每个目标的子节点都缩在它下面，' +
                  '不是按深度排成几排——「L2」只属于它自己的父节点。右边的「判据」是 ' +
                  'relevantActivities + allowedMethods 的条数，为零就标红，因为那样的目标永远判不出' +
                  '「对齐」。点一行展开详情。全部节点都显示（服务端完成态折叠未接入页面）。',
              ),
            ),
            nodes.length === 0
              ? h('div', { style: S.muted }, '还没有目标节点')
              : h(
                  'div',
                  { style: S.goalList },
                  flattenForest(nodes).map((row) => {
                      const node = row.node
                      const criteria =
                        (node.relevantActivities || []).length + (node.allowedMethods || []).length
                      const expanded = node.id === nodeId
                      return h(
                        'div',
                        { key: node.id, style: S.goalRow },
                        h(
                          'div',
                          {
                            style: expanded ? S.goalHeadOn : S.goalHead,
                            onClick: () => setNodeId(expanded ? null : node.id),
                          },
                          h('span', { style: S.goalCaret }, expanded ? '▾' : '▸'),
                          h('span', { style: S.treePrefix }, row.prefix),
                          h('span', { style: S.goalTitle }, node.title),
                          row.broken === undefined
                            ? null
                            : h(
                                'span',
                                { style: S.treeTag },
                                row.broken === 'cycleBroken' ? '环已断开' : '未挂接',
                              ),
                          criteria === 0
                            ? h('span', { style: S.goalBadgeWarn }, '无判据')
                            : h('span', { style: S.goalBadge }, criteria + ' 判据'),
                          h('span', { style: S.goalBadge }, node.status),
                        ),
                        expanded
                          ? h(
                              'div',
                              { style: S.goalBody },
                              h(Rows, {
                                entries: [
                                  ['id', node.id],
                                  ['优先级', String(node.priority)],
                                  ['截止', node.deadline ? when(node.deadline) : '未设置'],
                                  ['描述', node.description || '（空）'],
                                ],
                              }),
                              h(
                                'div',
                                { style: Object.assign({}, S.kvK, { marginTop: 10 }) },
                                '路径归属',
                              ),
                              (node.paths || []).length > 0
                                ? h(
                                    'div',
                                    { style: Object.assign({}, S.chips, { marginTop: 6 }) },
                                    node.paths.map((item) =>
                                      h('span', { key: 'path-' + item, style: S.chip }, item),
                                    ),
                                  )
                                : h(
                                    'div',
                                    { style: S.warnLine },
                                    '未绑定目录，活动无法按路径归属。点「编辑这个目标」补相对路径。',
                                  ),
                              h('div', { style: Object.assign({}, S.kvK, { marginTop: 10 }) }, '可匹配判据'),
                              criteria === 0
                                ? h(
                                    'div',
                                    { style: S.dangerLine },
                                    '没有可匹配判据：这个目标永远判不出 aligned。用下面的「让模型给建议」生成候选，勾选并确认后才会写入。',
                                  )
                                : null,
                              h(
                                'div',
                                { style: Object.assign({}, S.chips, { marginTop: 6 }) },
                                criteria === 0
                                  ? h('span', { style: S.chipNone }, '没有判据，无法判断对齐')
                                  : [
                                      ...(node.relevantActivities || []).map((item) =>
                                        h('span', { key: 'ra-' + item, style: S.chip }, item),
                                      ),
                                      ...(node.allowedMethods || []).map((item) =>
                                        h('span', { key: 'am-' + item, style: S.chip }, item),
                                      ),
                                    ],
                              ),
                              (node.successCriteria || []).length > 0
                                ? h(
                                    'div',
                                    null,
                                    h(
                                      'div',
                                      { style: Object.assign({}, S.kvK, { marginTop: 10 }) },
                                      '验收条件（不参与匹配）',
                                    ),
                                    h(
                                      'div',
                                      { style: Object.assign({}, S.chips, { marginTop: 6 }) },
                                      node.successCriteria.map((item) =>
                                        h('span', { key: 'sc-' + item, style: S.chip }, item),
                                      ),
                                    ),
                                  )
                                : null,
                              h(
                                'div',
                                { style: Object.assign({}, S.actions, { marginTop: 10 }) },
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    style: S.button,
                                    disabled: busy,
                                    onClick: () =>
                                      setGoalDraft({
                                        id: node.id,
                                        // The version travels with the draft: it is
                                        // the token that makes this edit safe against
                                        // someone else's concurrent change.
                                        version: active.version,
                                        title: node.title,
                                        description: node.description || '',
                                        status: node.status,
                                        priority: String(node.priority),
                                        deadline: node.deadline || '',
                                        pathsText: (node.paths || []).join('\n'),
                                        reason: '',
                                      }),
                                  },
                                  '编辑这个目标',
                                ),
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    style: Object.assign({}, S.button, { marginLeft: 8 }),
                                    disabled: busy,
                                    onClick: () => draftCriteria(node),
                                  },
                                  '让模型给建议',
                                ),
                              ),
                            )
                          : null,
                      )
                    }),
                ),
          ),

          h(
            Card,
            {
              key: 'contra',
              title: '矛盾树',
              right: h('span', { style: S.muted }, num(contradictions.length) + ' 个'),
            },
            contradictions.length === 0
              ? h('div', { style: S.muted }, '还没有记录矛盾')
              : h(
                  'div',
                  { style: S.list },
                  flattenForest(contradictions).map((row) =>
                    h(
                      'div',
                      { key: row.node.id, style: S.listRow },
                      h('span', { style: S.treePrefix }, row.prefix),
                      h('span', { style: S.rowLv }, row.node.type),
                      h('span', { style: S.rowName }, row.node.title),
                      row.broken === undefined
                        ? null
                        : h(
                            'span',
                            { style: S.treeTag },
                            row.broken === 'cycleBroken' ? '环已断开' : '未挂接',
                          ),
                      h(
                        'span',
                        { style: S.rowTxt },
                        row.node.poleA && row.node.poleB
                          ? row.node.poleA + ' ↔ ' + row.node.poleB
                          : '未填写两极',
                      ),
                      h(
                        'span',
                        { style: S.muted },
                        row.node.intensity === null ? '强度未知' : '强度 ' + row.node.intensity,
                      ),
                    ),
                  ),
                ),
          ),

          // The edit form, when a goal is being changed. It sits below the tree so
          // the node list stays the thing you are looking at while typing.
          goalDraft === null
            ? null
            : h(
                Card,
                { key: 'goal-edit', title: '编辑目标：' + goalDraft.title },
                // The save button is at the bottom of this form, so its feedback
                // renders at the top of the same card — the closest panel to it.
                h(
                  'div',
                  { style: S.form },
                  FormRow(
                    { label: '标题' },
                    h('input', {
                      style: S.inputWide,
                      type: 'text',
                      value: goalDraft.title,
                      onChange: (event) => setGoalDraft({ ...goalDraft, title: event.target.value }),
                    }),
                  ),
                  FormRow(
                    { label: '描述' },
                    h('input', {
                      style: S.inputWide,
                      type: 'text',
                      value: goalDraft.description,
                      onChange: (event) => setGoalDraft({ ...goalDraft, description: event.target.value }),
                    }),
                  ),
                  FormRow(
                    { label: '状态' },
                    h(
                      'select',
                      {
                        style: S.select,
                        value: goalDraft.status,
                        onChange: (event) => setGoalDraft({ ...goalDraft, status: event.target.value }),
                      },
                      GOAL_STATUSES.map((status) => h('option', { key: status, value: status }, status)),
                    ),
                  ),
                  FormRow(
                    { label: '优先级' },
                    h('input', {
                      style: S.input,
                      type: 'number',
                      value: goalDraft.priority,
                      onChange: (event) => setGoalDraft({ ...goalDraft, priority: event.target.value }),
                    }),
                  ),
                  FormRow(
                    { label: '截止', hint: '留空即清除' },
                    h('input', {
                      style: S.input,
                      type: 'date',
                      value: goalDraft.deadline === '' ? '' : String(goalDraft.deadline).slice(0, 10),
                      onChange: (event) => setGoalDraft({ ...goalDraft, deadline: event.target.value }),
                    }),
                  ),
                  FormRow(
                    { label: '路径', hint: '一行一个相对路径；留空即不绑定' },
                    h('textarea', {
                      style: Object.assign({}, S.inputWide, { minHeight: 54, fontFamily: 'inherit' }),
                      value: goalDraft.pathsText || '',
                      placeholder: '例如：2026省会换届',
                      onChange: (event) => setGoalDraft({ ...goalDraft, pathsText: event.target.value }),
                    }),
                  ),
                  FormRow(
                    { label: '为什么改', hint: '必填，写进审计' },
                    h('input', {
                      style: S.inputWide,
                      type: 'text',
                      placeholder: '例如：目标范围缩小到只做缓存层',
                      value: goalDraft.reason,
                      onChange: (event) => setGoalDraft({ ...goalDraft, reason: event.target.value }),
                    }),
                  ),
                ),
                h(
                  'div',
                  { style: Object.assign({}, S.actions, { marginTop: 12 }) },
                  h(
                    'button',
                    {
                      type: 'button',
                      style: S.primary,
                      disabled: busy || goalDraft.reason.trim().length === 0,
                      onClick: saveGoal,
                    },
                    '保存',
                  ),
                  h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => setGoalDraft(null) }, '取消'),
                  goalDraft.reason.trim().length === 0
                    ? h('span', { style: S.muted }, '写一句理由才能保存')
                    : null,
                ),
                h(
                  'div',
                  { style: Object.assign({}, S.muted, { marginTop: 8 }) },
                  '基于版本 v' + goalDraft.version + ' 保存；如果这期间树被别处改过，保存会被拒绝而不是覆盖。',
                ),
              ),
          criteriaDraft === null
            ? null
            : h(
                Card,
                {
                  key: 'criteria-suggest',
                  title: '判据建议：' + criteriaDraft.title,
                },
                feedbackFor('criteria'),
                h(
                  'div',
                  { style: S.muted },
                  '这些只是候选。勾选后点「确认写入」才会改树；不点确认不会发出写请求。',
                ),
                h(
                  'div',
                  { style: Object.assign({}, S.chips, { marginTop: 8 }) },
                  criteriaDraft.suggestion.relevantActivities.map((item) =>
                    h(
                      'label',
                      {
                        key: 'suggest-' + item,
                        style: Object.assign({}, S.chip, { cursor: 'pointer' }),
                      },
                      h('input', {
                        type: 'checkbox',
                        checked: criteriaSelected[item] === true,
                        onChange: (event) =>
                          setCriteriaSelected({ ...criteriaSelected, [item]: event.target.checked }),
                        style: { marginRight: 5 },
                      }),
                      item,
                    ),
                  ),
                ),
                (criteriaDraft.suggestion.excludedActivities || []).length > 0
                  ? h(
                      'div',
                      { style: Object.assign({}, S.muted, { marginTop: 6 }) },
                      '模型建议排除：' + criteriaDraft.suggestion.excludedActivities.join('、'),
                    )
                  : null,
                h(
                  'div',
                  { style: Object.assign({}, S.actions, { marginTop: 10 }) },
                  h(
                    'button',
                    {
                      type: 'button',
                      style: S.primary,
                      disabled: busy,
                      onClick: confirmCriteria,
                    },
                    '确认写入勾选的判据',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: Object.assign({}, S.button, { marginLeft: 8 }),
                      disabled: busy,
                      onClick: () => {
                        setCriteriaDraft(null)
                        setCriteriaSelected({})
                      },
                    },
                    '取消',
                  ),
                ),
              ),
        ]
      }

      // ---------------------------------------------------------- tab: config

      const configTab = () => {
        const config = (active && active.config) || EMPTY
        const schedule = config.schedule || EMPTY
        const thresholds = config.thresholds || EMPTY
        const gate = config.gate || EMPTY
        const storage = (active && active.data) || EMPTY
        const storageEntries = Object.keys(storage)
          .sort()
          .map((name) => [name, size(storage[name])])
        const realtimeProvider = String(valueOf('realtime.provider', '') || '')
        const realtimeModel = String(valueOf('realtime.model', '') || '')
        const providers = Array.isArray(models) ? models : []
        const selectedProvider = providers.find((item) => item.provider === realtimeProvider)
        const providerModels = (selectedProvider && selectedProvider.models) || []

        return [
          h(
            Card,
            {
              key: 'switches',
              title: '监控开关',
              right: editable.length > 0 ? h('span', { style: S.muted }, '改完重启生效') : null,
            },
            feedbackFor('settings'),
            h(
              Help,
              { title: '这几个开关分别管什么' },
              h('div', null, h('b', null, '启用监控'), '：总开关。关掉后工具还在，但不再巡检、不再判定。'),
              h(
                'div',
                null,
                h('b', null, '静默模式'),
                '：照常记录和判定，只是不弹提示、不弹卡。适合长时间挂机，结论去报告里看。',
              ),
              h(
                'div',
                null,
                h('b', null, 'Level 3 硬拦截'),
                '：偏离时真的拒绝危险操作。关掉就是影子模式——只计数不拦。',
              ),
            ),
            h(
              'div',
              { style: S.form },
              FormRow(
                { label: '启用监控' },
                h('input', {
                  type: 'checkbox',
                  checked: valueOf('enabled', true) === true,
                  onChange: (event) => setDrafts({ ...drafts, enabled: event.target.checked }),
                }),
              ),
              FormRow(
                { label: '静默模式', hint: '只记录、不打扰' },
                h('input', {
                  type: 'checkbox',
                  checked: valueOf('quiet.enabled', false) === true,
                  onChange: (event) => setDrafts({ ...drafts, 'quiet.enabled': event.target.checked }),
                }),
              ),
              FormRow(
                { label: '静默时仍拦截', hint: '静默的是提示，不是保护' },
                h('input', {
                  type: 'checkbox',
                  checked: valueOf('quiet.keepHardBlock', true) === true,
                  onChange: (event) => setDrafts({ ...drafts, 'quiet.keepHardBlock': event.target.checked }),
                }),
              ),
              FormRow(
                { label: 'Level 3 硬拦截', hint: '破坏性操作在偏离时被拒绝' },
                h('input', {
                  type: 'checkbox',
                  checked: valueOf('gate.level3HardBlock', false) === true,
                  onChange: (event) => setDrafts({ ...drafts, 'gate.level3HardBlock': event.target.checked }),
                }),
              ),
              FormRow(
                { label: '自动生成报告', hint: '每个周期自动追加一段，关掉就只能手点' },
                h('input', {
                  type: 'checkbox',
                  checked: valueOf('schedule.autoReport', true) === true,
                  onChange: (event) => setDrafts({ ...drafts, 'schedule.autoReport': event.target.checked }),
                }),
              ),
            ),
            h(
              'div',
              { style: Object.assign({}, S.actions, { marginTop: 12 }) },
              ['enabled', 'quiet.enabled', 'quiet.keepHardBlock', 'gate.level3HardBlock', 'schedule.autoReport']
                .filter((path) => isDirty(path))
                .map((path) =>
                  h(
                    'button',
                    {
                      key: path,
                      type: 'button',
                      style: S.primary,
                      disabled: busy,
                      onClick: () => saveSetting(path),
                    },
                    '保存 ' + path,
                  ),
                ),
              h(
                'span',
                { style: S.muted },
                ['enabled', 'quiet.enabled', 'quiet.keepHardBlock', 'gate.level3HardBlock', 'schedule.autoReport'].some(isDirty)
                  ? ''
                  : '改动后出现保存按钮',
              ),
            ),
          ),
          h(
            Card,
            { key: 'params', title: '判定参数' },
            h(
              Help,
              { title: '改这些会影响什么' },
              h('div', null, h('b', null, '巡检间隔'), '：多久主动看一次。调小更灵敏，但模型调用更多。'),
              h('div', null, h('b', null, '判定窗口'), '：一次判定回看多长的活动。太短会漏掉跨时段的工作。'),
              h('div', null, h('b', null, '重复升级'), '：同类信号出现几次才从「记一笔」升到「弹卡」。调大更安静。'),
              h('div', null, h('b', null, '最低置信度'), '：低于它的判定记为「待定」，不升级。'),
              h('div', null, h('b', null, '强度门槛'), '：核心矛盾要多强，L3 拦截才可能触发。'),
              h(
                'div',
                null,
                h('b', null, '陈旧判定'),
                '：目标多少天没有证据算停滞。',
                h('b', null, '不能填 0'),
                '，会拒绝加载整个插件——保存时会被挡下来。',
              ),
            ),
            h(
              'div',
              { style: S.form },
              h(
                'div',
                { key: 'thresholds.windowMinutes-k', style: S.formK },
                '判定窗口',
                '一次判定看多长活动' === undefined ? null : h('small', { style: S.formKSmall }, '一次判定看多长活动'),
              ),
              h(
                'div',
                { key: 'thresholds.windowMinutes-v', style: S.detailInline },
                h('input', {
                  style: S.input,
                  type: 'number',
                  min: 1,
                  max: 1440,
                  step: 1,
                  value: String(valueOf('thresholds.windowMinutes', '')),
                  onChange: (event) =>
                    setDrafts({
                      ...drafts,
                      'thresholds.windowMinutes': event.target.value === '' ? '' : Number(event.target.value),
                    }),
                }),
                isDirty('thresholds.windowMinutes')
                  ? h(
                      'button',
                      {
                        type: 'button',
                        style: Object.assign({}, S.primary, S.small, { marginLeft: 8 }),
                        disabled: busy,
                        onClick: () => saveSetting('thresholds.windowMinutes'),
                      },
                      '保存',
                    )
                  : null,
              ),
              h(
                'div',
                { key: 'thresholds.repeatThreshold-k', style: S.formK },
                '重复升级',
                '同类信号几次才升级' === undefined ? null : h('small', { style: S.formKSmall }, '同类信号几次才升级'),
              ),
              h(
                'div',
                { key: 'thresholds.repeatThreshold-v', style: S.detailInline },
                h('input', {
                  style: S.input,
                  type: 'number',
                  min: 1,
                  max: 99,
                  step: 1,
                  value: String(valueOf('thresholds.repeatThreshold', '')),
                  onChange: (event) =>
                    setDrafts({
                      ...drafts,
                      'thresholds.repeatThreshold': event.target.value === '' ? '' : Number(event.target.value),
                    }),
                }),
                isDirty('thresholds.repeatThreshold')
                  ? h(
                      'button',
                      {
                        type: 'button',
                        style: Object.assign({}, S.primary, S.small, { marginLeft: 8 }),
                        disabled: busy,
                        onClick: () => saveSetting('thresholds.repeatThreshold'),
                      },
                      '保存',
                    )
                  : null,
              ),
              h(
                'div',
                { key: 'thresholds.minConfidence-k', style: S.formK },
                '最低置信度',
                null,
              ),
              h(
                'div',
                { key: 'thresholds.minConfidence-v', style: S.detailInline },
                h('input', {
                  style: S.input,
                  type: 'number',
                  min: 0,
                  max: 1,
                  step: 0.05,
                  value: String(valueOf('thresholds.minConfidence', '')),
                  onChange: (event) =>
                    setDrafts({
                      ...drafts,
                      'thresholds.minConfidence': event.target.value === '' ? '' : Number(event.target.value),
                    }),
                }),
                isDirty('thresholds.minConfidence')
                  ? h(
                      'button',
                      {
                        type: 'button',
                        style: Object.assign({}, S.primary, S.small, { marginLeft: 8 }),
                        disabled: busy,
                        onClick: () => saveSetting('thresholds.minConfidence'),
                      },
                      '保存',
                    )
                  : null,
              ),
              h(
                'div',
                { key: 'thresholds.highIntensityThreshold-k', style: S.formK },
                '强度门槛',
                null,
              ),
              h(
                'div',
                { key: 'thresholds.highIntensityThreshold-v', style: S.detailInline },
                h('input', {
                  style: S.input,
                  type: 'number',
                  min: 1,
                  max: 5,
                  step: 1,
                  value: String(valueOf('thresholds.highIntensityThreshold', '')),
                  onChange: (event) =>
                    setDrafts({
                      ...drafts,
                      'thresholds.highIntensityThreshold': event.target.value === '' ? '' : Number(event.target.value),
                    }),
                }),
                isDirty('thresholds.highIntensityThreshold')
                  ? h(
                      'button',
                      {
                        type: 'button',
                        style: Object.assign({}, S.primary, S.small, { marginLeft: 8 }),
                        disabled: busy,
                        onClick: () => saveSetting('thresholds.highIntensityThreshold'),
                      },
                      '保存',
                    )
                  : null,
              ),
              h(
                'div',
                { key: 'thresholds.staleDaysThreshold-k', style: S.formK },
                '陈旧判定',
                '多少天无证据算停滞' === undefined ? null : h('small', { style: S.formKSmall }, '多少天无证据算停滞'),
              ),
              h(
                'div',
                { key: 'thresholds.staleDaysThreshold-v', style: S.detailInline },
                h('input', {
                  style: S.input,
                  type: 'number',
                  min: 1,
                  max: 365,
                  step: 1,
                  value: String(valueOf('thresholds.staleDaysThreshold', '')),
                  onChange: (event) =>
                    setDrafts({
                      ...drafts,
                      'thresholds.staleDaysThreshold': event.target.value === '' ? '' : Number(event.target.value),
                    }),
                }),
                isDirty('thresholds.staleDaysThreshold')
                  ? h(
                      'button',
                      {
                        type: 'button',
                        style: Object.assign({}, S.primary, S.small, { marginLeft: 8 }),
                        disabled: busy,
                        onClick: () => saveSetting('thresholds.staleDaysThreshold'),
                      },
                      '保存',
                    )
                  : null,
              ),
              h(
                'div',
                { key: 'schedule.checkIntervalMinutes-k', style: S.formK },
                '巡检间隔',
                '多久主动看一次' === undefined ? null : h('small', { style: S.formKSmall }, '多久主动看一次'),
              ),
              h(
                'div',
                { key: 'schedule.checkIntervalMinutes-v', style: S.detailInline },
                h('input', {
                  style: S.input,
                  type: 'number',
                  min: 1,
                  max: 1440,
                  step: 1,
                  value: String(valueOf('schedule.checkIntervalMinutes', '')),
                  onChange: (event) =>
                    setDrafts({
                      ...drafts,
                      'schedule.checkIntervalMinutes': event.target.value === '' ? '' : Number(event.target.value),
                    }),
                }),
                isDirty('schedule.checkIntervalMinutes')
                  ? h(
                      'button',
                      {
                        type: 'button',
                        style: Object.assign({}, S.primary, S.small, { marginLeft: 8 }),
                        disabled: busy,
                        onClick: () => saveSetting('schedule.checkIntervalMinutes'),
                      },
                      '保存',
                    )
                  : null,
              ),
            ),
          ),

          // The v4 signal tunables. Kept in their own card because they answer a
          // different question from the thresholds above: those say when a signal
          // escalates, these say how the per-step score is computed at all.
          h(
            Card,
            { key: 'signals', title: '信号判定' },
            h(
              Help,
              { title: '这几个数是干什么的' },
              h('div', null, h('b', null, 'EMA 权重'), '：新一步在总分里占多少。调大更敏感、也更抖；调小更平滑、也更迟钝。'),
              h('div', null, h('b', null, '提示门槛'), '：总分到这个数才在对话里提示一句。'),
              h('div', null, h('b', null, '弹卡门槛'), '：总分到这个数才开一张要你决定的卡。'),
              h('div', null, h('b', null, '连续步数'), '：要连续几步都在弹卡门槛之上，才真的弹。防止单步尖峰。'),
              h(
                'div',
                null,
                h('b', null, '覆盖率下限'),
                '：这一步有多少权重拿到了数据。低于它就不升级——0.4 表示至少一半权重可用。',
              ),
              h(
                'div',
                { style: { marginTop: 8 } },
                '注意：这几个默认值是在未校准的分数上定的，不是概率分界点。改成多少合适，只能靠你自己观察几天的误报量。',
              ),
            ),
            h(
              'div',
              { style: S.form },
              ...numberField('signals.emaBeta', 'EMA 权重', '0 到 1', 0, 1, 0.05),
              ...numberField('signals.thetaHintScore', '提示门槛', '0 到 1', 0, 1, 0.025),
              ...numberField('signals.thetaCardScore', '弹卡门槛', '0 到 1', 0, 1, 0.025),
              ...numberField('signals.consecutiveStepsForCard', '连续步数', '至少 1 步', 1, 20, 1),
              ...numberField('signals.coverageFloor', '覆盖率下限', '0 到 1', 0, 1, 0.05),
            ),
          ),

          // Collection switches. `enabled` is the master feed: off means nothing is
          // recorded at all, which is different from quiet mode (records, does not
          // interrupt).
          h(
            Card,
            { key: 'collection', title: '采集' },
            h(
              Help,
              { title: '关掉会怎样' },
              h('div', null, h('b', null, '启用采集'), '：关掉后不再记录活动。判定、报告、成就都会跟着空掉。'),
              h('div', null, h('b', null, '摘要长度'), '：一条活动最多保留多少字符。调小省空间，但报告里能看到的细节也少。'),
            ),
            h(
              'div',
              { style: S.form },
              FormRow(
                { label: '启用采集', hint: '关掉就没有任何记录' },
                h('input', {
                  type: 'checkbox',
                  checked: valueOf('collection.enabled', true) === true,
                  onChange: (event) => setDrafts({ ...drafts, 'collection.enabled': event.target.checked }),
                }),
              ),
              FormRow(
                { label: '摘要长度', hint: '一条活动保留多少字符' },
                h(
                  'div',
                  { style: S.detailInline },
                  h('input', {
                    style: S.input,
                    type: 'number',
                    min: 40,
                    max: 2000,
                    step: 20,
                    value: String(valueOf('collection.summaryMaxChars', '')),
                    onChange: (event) =>
                      setDrafts({
                        ...drafts,
                        'collection.summaryMaxChars': event.target.value === '' ? '' : Number(event.target.value),
                      }),
                  }),
                  isDirty('collection.summaryMaxChars')
                    ? h(
                        'button',
                        {
                          type: 'button',
                          style: Object.assign({}, S.primary, S.small, { marginLeft: 8 }),
                          disabled: busy,
                          onClick: () => saveSetting('collection.summaryMaxChars'),
                        },
                        '保存',
                      )
                    : null,
                ),
              ),
            ),
            h(
              'div',
              { style: Object.assign({}, S.actions, { marginTop: 12 }) },
              ['collection.enabled'].filter((path) => isDirty(path)).map((path) =>
                h(
                  'button',
                  { key: path, type: 'button', style: S.primary, disabled: busy, onClick: () => saveSetting(path) },
                  '保存 ' + path,
                ),
              ),
              ['collection.enabled'].some(isDirty) ? null : h('span', { style: S.muted }, '改动后出现保存按钮'),
            ),
          ),
          h(
            Card,
            { key: 'realtime', title: '实时监控' },
            h(
              Help,
              { title: '实时监控怎么开' },
              h('div', null, h('b', null, '总开关'), '：打开后按间隔在后台判定活动；关掉只保留手动检查。'),
              h('div', null, h('b', null, '间隔'), '：多久判一次。调小更灵敏，模型调用更多。'),
              h('div', null, h('b', null, '输入预算'), '：一次判定最多读多少字符，防止长活动撑爆上下文。'),
              h('div', null, h('b', null, '超时'), '：单次模型调用最多等多久。'),
              h('div', null, h('b', null, '低分阈值'), '：分数低于它不提示；0.3 表示只报更明确的偏离。'),
              h(
                'div',
                null,
                h('b', null, '模型'),
                '：空值表示跟随全局。列表拉不到时可以直接手填 provider/model。',
              ),
            ),
            feedbackFor('settings'),
            h(
              'div',
              { style: S.form },
              FormRow(
                { label: '启用实时监控', hint: '默认关闭；打开后才会后台判定' },
                h('input', {
                  type: 'checkbox',
                  checked: valueOf('realtime.enabled', false) === true,
                  onChange: (event) =>
                    setDrafts({ ...drafts, 'realtime.enabled': event.target.checked }),
                }),
              ),
              ...numberField('realtime.intervalMinutes', '间隔（分钟）', '多久判一次', 1, 1440, 1),
              ...numberField('realtime.maxInputTokens', '输入预算', '一次判定最多读多少字符', 100, 200000, 1000),
              ...numberField('realtime.timeoutMs', '超时（毫秒）', '单次模型调用上限', 1000, 600000, 1000),
              ...numberField('realtime.hintThreshold', '低分阈值', '低于它不提示', 0, 1, 0.05),
              FormRow(
                { label: '模型提供方', hint: '空值跟随全局' },
                h(
                  'select',
                  {
                    style: S.select,
                    value: realtimeProvider,
                    onChange: (event) =>
                      setDrafts({
                        ...drafts,
                        'realtime.provider': event.target.value,
                        'realtime.model': '',
                      }),
                  },
                  h('option', { value: '' }, '跟随全局'),
                  providers.map((item) =>
                    h(
                      'option',
                      { key: 'provider-' + item.provider, value: item.provider },
                      item.displayName || item.provider,
                    ),
                  ),
                  realtimeProvider !== '' &&
                    !providers.some((item) => item.provider === realtimeProvider)
                    ? h('option', { value: realtimeProvider }, realtimeProvider + '（当前值）')
                    : null,
                ),
              ),
              FormRow(
                { label: '模型', hint: '选择提供方后列出它的模型' },
                h(
                  'select',
                  {
                    style: S.select,
                    value: realtimeModel,
                    disabled: realtimeProvider === '',
                    onChange: (event) =>
                      setDrafts({ ...drafts, 'realtime.model': event.target.value }),
                  },
                  h('option', { value: '' }, '跟随全局'),
                  modelChoices(providers, realtimeProvider)
                    .filter((item) => item.value !== '')
                    .map((item) =>
                      h(
                        'option',
                        { key: 'model-' + item.value, value: item.value },
                        item.label,
                      ),
                    ),
                  realtimeModel !== '' &&
                    !providerModels.some((item) => item.id === realtimeModel)
                    ? h('option', { value: realtimeModel }, realtimeModel + '（当前值）')
                    : null,
                ),
              ),
            ),
            modelsError === null && models.length > 0
              ? null
              : h(
                  'div',
                  { style: S.dangerLine },
                  modelsError === null
                    ? '模型列表为空（宿主没有返回任何 provider）。可以手填 provider/model。'
                    : '模型列表读取失败：' + modelsError + '。下面可以直接手填，不必等列表恢复。',
                ),
            modelsError === null && models.length > 0
              ? null
              : h(
                  'div',
                  { style: Object.assign({}, S.form, { marginTop: 8 }) },
                  FormRow(
                    { label: '手填 provider' },
                    h('input', {
                      style: S.input,
                      type: 'text',
                      value: manualProvider,
                      placeholder: '例如 deepseek',
                      onChange: (event) => setManualProvider(event.target.value),
                    }),
                  ),
                  FormRow(
                    { label: '手填 model' },
                    h('input', {
                      style: S.input,
                      type: 'text',
                      value: manualModel,
                      placeholder: '例如 deepseek-chat',
                      onChange: (event) => setManualModel(event.target.value),
                    }),
                  ),
                  h(
                    'div',
                    { style: S.actions },
                    h(
                      'button',
                      {
                        type: 'button',
                        style: S.primary,
                        disabled: busy || manualProvider.trim() === '' || manualModel.trim() === '',
                        onClick: () =>
                          saveRealtimeModel(manualProvider.trim(), manualModel.trim()),
                      },
                      '保存手填模型',
                    ),
                  ),
                ),
            h(
              'div',
              { style: Object.assign({}, S.actions, { marginTop: 12 }) },
              isDirty('realtime.enabled')
                ? h(
                    'button',
                    {
                      type: 'button',
                      style: S.primary,
                      disabled: busy,
                      onClick: () => saveSetting('realtime.enabled'),
                    },
                    '保存开关',
                  )
                : null,
              isDirty('realtime.provider') || isDirty('realtime.model')
                ? h(
                    'button',
                    {
                      type: 'button',
                      style: Object.assign({}, S.primary, { marginLeft: 8 }),
                      disabled: busy,
                      onClick: () =>
                        saveRealtimeModel(
                          String(valueOf('realtime.provider', '') || ''),
                          String(valueOf('realtime.model', '') || ''),
                        ),
                    },
                    '保存模型选择',
                  )
                : null,
            ),
          ),
          h(
            Card,
            { key: 'llm', title: '模型' },
            h(
              Help,
              { title: '为什么这里不能改' },
              h(
                'div',
                null,
                '插件没有自己的模型配置。复核与巡检沿用调用方的模型——' +
                  '改这里会改到全局，属于另一条链路，所以卡片只显示。',
              ),
            ),
            h(Rows, {
              entries: [
                ['提供方', llm && llm.provider ? llm.provider : '未知'],
                ['模型', llm && llm.model ? llm.model : '未知'],
              ],
            }),
            h('div', { style: Object.assign({}, S.muted, { marginTop: 8 }) }, (llm && llm.note) || '读不到全局模型配置'),
          ),

          h(
            Card,
            { key: 'usage', title: '用量' },
            usage
              ? h(Rows, {
                  entries: [
                    ['活动记录', num(usage.activities)],
                    ['漂移信号', num(usage.signals)],
                    ['待复核判定', num(usage.pendingJudgments)],
                    ['待决策卡片', num(usage.pendingInterventions)],
                    ['报告', num(usage.reports)],
                    ['token 用量', '无数据'],
                  ],
                })
              : h('div', { style: S.muted }, '读取中…'),
            usage && usage.tokenUsageNote ? h('div', { style: Object.assign({}, S.muted, { marginTop: 8 }) }, usage.tokenUsageNote) : null,
          ),

          h(
            Card,
            { key: 'data', title: '数据与维护' },
            feedbackFor('data'),
            h(
              Help,
              { title: '这些按钮各自做什么' },
              h('div', null, h('b', null, '归档信号流'), '：把信号移到带日期的归档文件，等级统计从零开始。什么都不删。'),
              h('div', null, h('b', null, '立即巡检'), '：只跑静态检查与文件扫描。模型复核需要会话上下文。'),
              h(
                'div',
                null,
                h('b', null, '里程碑归档'),
                '：把当前目标树和判定统计一起存下来。以后问「换了树之后判断有没有变好」时，两半都在。',
              ),
            ),
            storageEntries.length === 0
              ? h('div', { style: S.muted }, '还没有写入任何数据')
              : h(Rows, { entries: storageEntries }),
            h(
              'div',
              { style: Object.assign({}, S.actions, { marginTop: 12 }) },
              h('button', { type: 'button', style: S.button, disabled: busy, onClick: archive }, '归档信号流'),
              h('button', { type: 'button', style: S.button, disabled: busy, onClick: sweep }, '立即巡检'),
            ),
          ),

          h(
            Card,
            { key: 'milestone', title: '里程碑归档' },
            feedbackFor('milestone'),
            h(
              'div',
              { style: S.form },
              FormRow(
                { rowId: 'ms-label', label: '名称' },
                h('input', {
                  style: S.input,
                  type: 'text',
                  placeholder: '例如 v4-confirmed',
                  value: milestoneLabel,
                  onChange: (event) => setMilestoneLabel(event.target.value),
                }),
              ),
              FormRow(
                { rowId: 'ms-note', label: '为什么记这一笔（可选）' },
                h('input', {
                  style: S.inputWide,
                  type: 'text',
                  placeholder: '可不填。例如：树结构定稿，之后只改细节。几个月后你自己会忘',
                  value: milestoneNote,
                  onChange: (event) => setMilestoneNote(event.target.value),
                }),
              ),
            ),
            h(
              'div',
              { style: Object.assign({}, S.actions, { marginTop: 12 }) },
              h('button', { type: 'button', style: S.button, disabled: busy, onClick: archiveMilestone }, '归档里程碑'),
            ),
            // The archive's own history. Before this list existed a milestone was
            // write-only: the record and the tree it captured sat on disk with no
            // way to read them back.
            h(
              'div',
              { style: Object.assign({}, S.kvK, { marginTop: 16 }) },
              '已归档 ' + milestones.length + ' 个里程碑',
            ),
            milestones.length === 0
              ? h('div', { style: Object.assign({}, S.muted, { marginTop: 6 }) }, '还没有归档过里程碑')
              : h(
                  'div',
                  { style: Object.assign({}, S.list, { marginTop: 6 }) },
                  milestones.map((entry) =>
                    h(
                      'div',
                      {
                        key: entry.path,
                        style: Object.assign({}, S.listRow, { cursor: 'pointer' }),
                        onClick: () => showMilestone(entry.path),
                      },
                      h('span', { style: S.rowName }, entry.label),
                      h('span', { style: S.muted }, 'v' + entry.version),
                      h('span', { style: S.muted }, entry.note || '（没写原因）'),
                      h('span', { style: S.rowTime }, when(entry.archivedAt)),
                    ),
                  ),
                ),
            openMilestone === null
              ? null
              : h(
                  'pre',
                  { style: S.pre },
                  JSON.stringify(
                    {
                      label: openMilestone.label,
                      note: openMilestone.note,
                      archivedAt: openMilestone.archivedAt,
                      version: openMilestone.version,
                      counts: openMilestone.counts,
                    },
                    null,
                    2,
                  ),
                ),
          ),

          h(
            Card,
            { key: 'danger', title: '危险操作' },
            feedbackFor('danger'),
            h(
              'div',
              { style: S.dangerLine },
              '下面两种都是真删除，不能撤销，也没有回收站。先选要删哪个项目，再选清到什么程度，最后输入 id 确认。',
            ),
            h(
              'div',
              { style: Object.assign({}, S.form, { marginTop: 12 }) },
              FormRow(
                { rowId: 'purge-target', label: '要删除的项目', hint: '不必切换工作区' },
                h(
                  'select',
                  {
                    style: S.select,
                    value: (purgeTargetProject && purgeTargetProject.projectId) || '',
                    onChange: (event) => {
                      setPurgeTarget(event.target.value)
                      setPurgeId('')
                    },
                  },
                  projects.map((project) =>
                    h(
                      'option',
                      { key: project.projectId, value: project.projectId },
                      (project.shell ? '[空壳] ' : '') +
                        (project.title || project.projectId) +
                        ' — ' +
                        project.projectId,
                    ),
                  ),
                ),
              ),
            ),
            h(
              'div',
              { style: Object.assign({}, S.form, { marginTop: 12 }) },
              FormRow(
                { rowId: 'purge-scope', label: '清空范围' },
                h(
                  'div',
                  { style: S.scopeChoices },
                  h(
                    'label',
                    { style: purgeScope === 'records' ? S.scopeOn : S.scopeOff },
                    h('input', {
                      type: 'radio',
                      name: 'purge-scope',
                      checked: purgeScope === 'records',
                      onChange: () => setPurgeScope('records'),
                    }),
                    h('span', null, h('b', null, '只清记录')),
                    h('small', { style: S.scopeHint }, '活动、信号、判定、报告、快照；目标树保留'),
                  ),
                  h(
                    'label',
                    { style: purgeScope === 'everything' ? S.scopeOn : S.scopeOff },
                    h('input', {
                      type: 'radio',
                      name: 'purge-scope',
                      checked: purgeScope === 'everything',
                      onChange: () => setPurgeScope('everything'),
                    }),
                    h('span', null, h('b', null, '全部清空')),
                    h('small', { style: S.scopeHint }, '外加目标树和会话绑定，等于从没监控过'),
                  ),
                ),
              ),
              h(
                'div',
                { style: S.copyLine },
                h('span', { style: S.kvK }, '要删除的项目 id'),
                h(
                  'button',
                  {
                    type: 'button',
                    style: S.copyId,
                    title: '点击复制',
                    onClick: () => {
                      // Clipboard may be denied; the id is also selectable, so a failure
                      // just means the user selects it by hand.
                      if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(purgeTargetId || '').catch(() => {})
                      }
                      setPurgeId(purgeTargetId || '')
                    },
                  },
                  purgeTargetId || '(未知)',
                ),
                h('span', { style: S.muted }, '点一下自动填入'),
              ),
              FormRow(
                { rowId: 'purge-id', label: '再输入一遍以确认', hint: '必须与上面完全一致' },
                h('input', {
                  style: S.inputWide,
                  type: 'text',
                  placeholder: '粘贴或输入上面的 id',
                  autocomplete: 'off',
                  spellCheck: false,
                  value: purgeId,
                  onChange: (event) => setPurgeId(event.target.value),
                }),
              ),
              // Required, and marked as required in the placeholder as well as the label:
              // the previous layout squeezed this field to a few pixels, so the one thing
              // blocking the button was the one thing not visible.
              FormRow(
                { rowId: 'purge-reason', label: '为什么清空（可选）', hint: '写进审计；不填也可以删' },
                h('input', {
                  style: S.inputWide,
                  type: 'text',
                  placeholder: '可不填。例如：测试数据污染了统计',
                  value: purgeReason,
                  onChange: (event) => setPurgeReason(event.target.value),
                }),
              ),
            ),
            // Diagnostics, on screen. The desktop client has no console, so a silent
            // state is indistinguishable from a dead button; printing the three values
            // the guard uses makes the next report answerable.
            h(
              'div',
              { style: Object.assign({}, S.muted, { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11 }) },
              '状态：目标=' + (purgeTargetId || '(空)') +
                ' · 输入=' + (purgeId.trim() || '(空)') +
                ' · 忙碌=' + String(busy),
            ),
            h(
              'div',
              { style: Object.assign({}, S.actions, { marginTop: 12 }) },
              h(
                'button',
                {
                  type: 'button',
                  style:
                    purgeId.trim() === purgeTargetId
                      ? S.danger
                      : Object.assign({}, S.danger, { opacity: 0.45 }),
                  disabled: busy || purgeId.trim() !== purgeTargetId,
                  onClick: purge,
                },
                feedbackFor('tree'),
                purgeScope === 'everything' ? '永久删除全部' : '永久删除记录',
              ),
              h(
                'span',
                { style: S.muted },
                purgeId.trim() !== purgeTargetId
                  ? '把上面的项目 id 原样输入后，按钮才会启用'
                  : '条件齐了，可以点',
              ),
            ),
          ),


          h(
            Card,
            { key: 'glossary', title: '术语表' },
            h(
              'table',
              { style: S.gloss },
              h(
                'thead',
                null,
                h('tr', null, h('th', { style: S.glossTh }, '词'), h('th', { style: S.glossTh }, '含义')),
              ),
              h(
                'tbody',
                null,
                GLOSSARY.map((row) =>
                  h(
                    'tr',
                    { key: row[0] },
                    h('td', { style: S.glossTdFirst }, row[0]),
                    h('td', { style: S.glossTd }, row[1]),
                  ),
                ),
              ),
            ),
          ),
        ]
      }

      // ---------------------------------------------------------------- shell

      const shellNodes = (active && active.nodes) || []
      const missingPaths = shellNodes.filter((node) => !Array.isArray(node.paths) || node.paths.length === 0).length
      const missingDeadline = shellNodes.filter((node) => !node.deadline).length
      const missingCriteria = Number(active && active.criteriaGap && active.criteriaGap.missing) || 0
      const realtimeEnabled =
        valueOf(
          'realtime.enabled',
          active && active.config && active.config.realtime ? active.config.realtime.enabled : false,
        ) === true

      return h(
        'div',
        { style: S.root },
        // No global feedback bar. Every action reports into the panel that owns its
        // buttons, so a message always appears next to the control that produced it
        // — a bar at the top was reported as easy to miss twice.
        h(
          'div',
          { style: S.head },
          h('h1', { style: S.title }, '元认知监控'),
          active
            ? h('span', { style: S.badge }, h('i', { style: S.dot }), active.confirmed ? '监控中' : '未确认')
            : null,
        ),
        h(
          'p',
          { style: S.sub },
          projects.length + ' 个工作区已建树 · 最近更新 ' + when(active && active.updatedAt),
          ' · 卡片 v2',
        ),

        active
          ? h(
              'div',
              { style: S.statusStrip },
              h(
                'span',
                { style: active.confirmed ? S.badge : S.badgeGray },
                active.confirmed ? '树已确认' : '树未确认',
              ),
              h(
                'button',
                { type: 'button', style: S.todoAct, onClick: () => setTab('tree') },
                missingCriteria + ' 个目标缺判据',
              ),
              h(
                'button',
                { type: 'button', style: S.todoAct, onClick: () => setTab('tree') },
                missingPaths + ' 个目标缺 paths',
              ),
              h(
                'button',
                { type: 'button', style: S.todoAct, onClick: () => setTab('tree') },
                missingDeadline + ' 个目标缺 deadline',
              ),
              h(
                'button',
                { type: 'button', style: S.todoAct, onClick: () => setTab('config') },
                realtimeEnabled ? '实时监控已开启' : '实时监控未开启',
              ),
            )
          : null,

        introOpen
          ? h(
              'div',
              { style: S.intro },
              h(
                'button',
                {
                  type: 'button',
                  style: S.introClose,
                  onClick: () => setIntroOpen(false),
                  title: '关闭',
                },
                '×',
              ),
              h('h3', { style: S.introTitle }, '第一次用？三句话'),
              h(
                'ol',
                { style: S.introList },
                h('li', null, '它盯着「你在做的事」和「你声明的目标」对不对得上，对不上就记一条。'),
                h(
                  'li',
                  null,
                  '目标树是你写的判据，矛盾树是你承认的张力。判据写得越具体，判断越准。',
                ),
                active && active.criteriaGap && active.criteriaGap.missing > 0
                  ? h(
                      'li',
                      null,
                      '现在 ',
                      h(
                        'b',
                        null,
                        active.criteriaGap.total + ' 个目标里有 ' + active.criteriaGap.missing + ' 个没写判据',
                      ),
                      '，所以「对齐」永远是 0——这是当前最该修的事。',
                    )
                  : h('li', null, '当前每个目标都有可匹配判据，「对齐」可以正常计算了。'),
              ),
            )
          : null,

        projects.length > 1
          ? h(
              'div',
              { style: S.picker },
              h('span', { style: S.muted }, '项目'),
              h(
                'select',
                { style: S.select, value: activeId || '', onChange: (event) => setActiveId(event.target.value) },
                projects.map((project) =>
                  h(
                    'option',
                    { key: project.projectId, value: project.projectId },
                    project.shell
                      ? project.projectId + '（空壳：没有目标树）'
                      : project.title + ' — ' + project.projectId,
                  ),
                ),
              ),
              h(
                'span',
                { style: S.meta },
                active ? 'v' + active.version + (active.confirmed ? ' 已确认' : ' 未确认') : '',
                active ? ' · ' + active.goals.total + ' 目标 · ' + active.contradictions.total + ' 矛盾' : '',
                active ? h('br', null) : null,
                active ? '更新于 ' + when(active.updatedAt) : '',
              ),
            )
          : null,

        h(
          'div',
          { style: S.tabs },
          [
            ['status', '状态'],
            ['tree', '目标树与矛盾树'],
            ['config', '设置'],
          ].map(([key, label]) =>
            h(
              'button',
              { key, type: 'button', style: key === tab ? S.tabOn : S.tab, onClick: () => setTab(key) },
              label,
            ),
          ),
        ),

        tab === 'status' ? statusTab() : null,
        tab === 'tree' ? treeTab() : null,
        tab === 'config' ? configTab() : null,
      )
    }

    return {
      inject: ['slots'],
      // Pure shape helpers, exported so the test can exercise the forest build
      // without a browser or a fetch. The host reads only `inject` and `apply`;
      // these two never touch React or the network.
      __tree: { buildForest, flattenForest, pickCycleBreak },
      // Pure display helpers, exported so the settings-card tests can check the
      // model options and the neutral wording without a browser.
      __ui: { modelChoices, verdictMatchLabel, verdictFulfilledLabel, statusSummary, realtimeSettingsPayload },
      apply(ctx) {
        // Two surfaces, one card:
        //
        // - `plugins.bundle.config`, keyed by the package name, is the bundle's
        //   own page. It is the canonical home, but nothing in the app points a
        //   user there, so it alone reads as "the card does not exist".
        // - `settings.section` gives it a nav row in 设置, beside 撤销与快照 and
        //   定时任务. That is where a settings card is looked for.
        ctx.slots.inject(CARD_KEY_SLOT, () =>
          ctx.slots.register({ name: CARD_KEY_SLOT, key: CARD_KEY }, MetacogCard),
        )
        ctx.slots.inject(SETTINGS_SLOT, () =>
          ctx.slots.register(
            {
              name: SETTINGS_SLOT,
              id: 'metacog',
              order: 36,
              label: () => '元认知监控',
            },
            MetacogCard,
          ),
        )
      },
    }
  },
})
