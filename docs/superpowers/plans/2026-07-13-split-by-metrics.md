---
spec: docs/superpowers/specs/2026-07-13-split-by-metrics-design.md
lanes:
  - id: splitby-a
    footprint:
      - server/routes/proposals/metricsSplit.js
      - server/routes/proposals/metricsSplit.test.js
      - server/routes/proposals/index.js          # mount metricsSplit (before getOne, which stays LAST)
      - server/routes/proposals/list.js           # event_type filter normalization + __untyped sentinel (additive)
      - server/routes/proposals/crud.filters.test.js
      - client/src/pages/admin/overview/FunnelCard.js
      - client/src/pages/admin/overview/OverviewPage.js
      - client/src/index.css
      - README.md
      - ARCHITECTURE.md
      - docs/fix-list-remaining-2026-07-02.md
    blockedBy: []
    review: standard + consistency-check at the gate   # the per-segment predicates are a reconciliation contract with metricsQueries (same as lane mb-a); nothing sensitive-listed, read-path only
---

# Split-by Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. One lane, built via the think-on-main/build-in-lanes model.

**Goal:** Close rate and revenue split by lead source and by event type on the Funnel card, reconciling exactly with the board's funnel numbers.

**Architecture:** One additive sibling endpoint over the existing metrics predicates (GROUP BY with query-time vocabulary normalization); LAW endpoints untouched; lazy client fetch behind a URL-backed Split control.

**Tech Stack:** Existing: raw SQL via pool.query, node:test route tests, React + vanilla CSS tokens.

## Global Constraints

- LAW endpoints byte-frozen; `metadata.shapes.test.js` must stay green untouched.
- Money display: proposal dollars, `fmt$` whole-dollar aggregates.
- No em dashes in copy. Both skins, 390px, no page-level horizontal scroll.
- Server tests share the dev DB: one file at a time, `DOTENV_CONFIG_PATH=<os>/.env node -r dotenv/config --test <file>` from a worktree.
- Single-shot `pool.query` only (no `pool.connect`), per the 2026-07-13 connection-lifecycle rule.
- Vercel gate before merge: `cd client && CI=true npx react-scripts build`.

---

### Task A1: metrics-split endpoint (TDD)

**Files:**
- Create: `server/routes/proposals/metricsSplit.js`, `server/routes/proposals/metricsSplit.test.js`
- Modify: `server/routes/proposals/index.js` (mount before `getOne`)

**Interfaces:**
- Consumes: `dateClause` from `server/utils/metricsQueries.js` (exported), `qAccepted` (test-side reconciliation), `ValidationError` from `server/utils/errors.js`.
- Produces: `GET /api/proposals/metrics-split?by=source|event_type&from&to` returning `{ by, filters: {from, to}, segments: [{key, label: null, sent: {count, value}, won: {count, value}, closeRatePct, pending}], truncated }` (label resolution is client-side; server sends `key` only, `label` omitted).

- [ ] **A1.1 Failing tests first.** Seed per the spec DoD: rows with event_type `wedding-reception`, `Wedding Reception` (accepted), NULL (sent only), a thumbtack-source accepted row, direct rows; ranges chosen so date filtering is exercised. Tests: twin vocabularies merge into one `wedding-reception` segment; NULL lands in `__untyped`; `by=source` returns `thumbtack` + `direct` keys with correct counts/values; `won` uses the accepted_at axis and no status filter (an accepted-then-archived row still counts, mirroring `qAccepted`); `closeRatePct`/`pending` mirror the `qWinRate` cohort per segment; cap: seed 14 distinct types, assert 12 segments + `__other` rollup + `truncated` populated; `by=bogus` is a 400 ValidationError; malformed `from` ignored (no 500); reconciliation: sum of `won.count` across segments equals `qAccepted` native-leg count on the same range (execute the imported query on the seed). Run: FAIL first.
- [ ] **A1.2 Implement.** Fixed SQL fragments only:

```js
const KEY_EXPRS = {
  event_type: "COALESCE(NULLIF(LOWER(REGEXP_REPLACE(TRIM(p.event_type), '\\s+', '-', 'g')), ''), '__untyped')",
  source: "COALESCE(p.source, 'direct')",
};
```

  Two queries, merged by key in JS: (1) sent-cohort query, `WHERE p.sent_at IS NOT NULL` + `dateClause('p.sent_at', ...)`, selecting per key: `COUNT(*) sent_count`, `SUM(total_price) sent_value`, `COUNT(*) FILTER (WHERE accepted_at IS NOT NULL AND status <> 'archived') accepted_from_cohort`, `COUNT(*) FILTER (WHERE accepted_at IS NULL AND status <> 'archived') pending`; (2) won query, `WHERE p.accepted_at IS NOT NULL` + `dateClause('p.accepted_at', ...)`, per key: `COUNT(*) won_count`, `SUM(total_price) won_value`. `closeRatePct = sent_cohort > 0 ? Math.round(accepted_from_cohort / sent_cohort * 100) : null`. Sort by sent_count desc; slice 12; aggregate the remainder into `__other` (sum all numeric fields; closeRatePct recomputed from the rolled-up cohort); `truncated = remainder ? {segments: n, sent: m} : null`. `by` whitelisted via the KEY_EXPRS keys, else `throw new ValidationError('by must be source or event_type')`. Router mounted in `index.js` before `getOne`. Run tests to green; run `metadata.shapes.test.js` alone to confirm LAW untouched. Checkpoint commit.

### Task A2: list-route event_type normalization (TDD)

**Files:**
- Modify: `server/routes/proposals/list.js`, `server/routes/proposals/crud.filters.test.js`

**Interfaces:**
- Produces: `event_type=<value>` now matches normalized on both sides; `event_type=__untyped` matches NULL/empty. Existing exact-slug callers unaffected (slug normalizes to itself).

- [ ] **A2.1 Failing tests:** a `Wedding Reception` row is found via `event_type=wedding-reception`; `event_type=__untyped` finds the NULL row and only it; an existing exact-match case still passes.
- [ ] **A2.2 Implement in list.js:** replace the equality with, for the sentinel: `(p.event_type IS NULL OR TRIM(p.event_type) = '')` when the param is `__untyped`; else `LOWER(REGEXP_REPLACE(TRIM(p.event_type), '\\s+', '-', 'g')) = LOWER(REGEXP_REPLACE(TRIM($n), '\\s+', '-', 'g'))` (value parameterized; fragment fixed). Green + no regression in the rest of the file's suite. Checkpoint commit.

### Task A3: Funnel card Split control

**Files:**
- Modify: `client/src/pages/admin/overview/FunnelCard.js`, `client/src/pages/admin/overview/OverviewPage.js`, `client/src/index.css` (ONE bounded block: `/* overview: splitby */ ... /* end */`)

**Interfaces:**
- Consumes: `eraOverlaps` from OverviewPage, `fmt$` from adminos/format, `EVENT_TYPES` from utils/eventTypes (label map), the endpoint from A1.
- Produces: OverviewPage `listState` gains `split: ''` (values `''|'source'|'event_type'`); FunnelCard gains props `{split, onSplitChange, splitData, splitLoading, splitError, onRetrySplit, from, to, eraNote}` or fetches internally; PICK: OverviewPage owns the fetch (consistent with its other Band 2 fetches and isolation rules) and passes data down.

- [ ] **A3.1 OverviewPage:** add `split: ''` to `FIN_DEFAULTS`; when `split` is truthy fetch `/proposals/metrics-split?by=<split>&from&to` (lazy, own `.catch`, cancelled flag, refetch on split/from/to change); pass through to FunnelCard along with an `onSplitChange` writing `setListState({ split })`.
- [ ] **A3.2 FunnelCard:** card head gains the seg `Split: None | Source | Type` (existing `seg` classes, None active by default). `split === ''` renders the current body BYTE-IDENTICALLY. Split active renders: one row per segment: label (client-side resolution: EVENT_TYPES slug map, title-case fallback, `__untyped` renders "No type set", source keys render Thumbtack/Direct), Quoted count, Won count + `fmt$` value, Close% with a mini `.bar` (width = pct). Rows are EntityLinks per the spec drill-out table; the `__other` row is non-affording (default cursor, no link). Loading line, error line + Retry, honest empty ("No quotes in this range"). Era footnote via `eraOverlaps(from)` exactly per spec. 390px: the segment table collapses like the board's other mobile tables (reuse `.ov-tbl-collapse` patterns or stack rows).
- [ ] **A3.3 Docs (this lane owns its own):** ARCHITECTURE route table gains `GET /api/proposals/metrics-split`; README folder tree gains `metricsSplit.js`; fix-list: flip the split-by entry to build-underway/merged as it lands.
- [ ] **A3.4 Gate + commit:** `CI=true npx react-scripts build` green; both skins + 390px smoke deferred to the coordinator post-merge; final commit.

## Execution notes

- One lane, no dependencies; cut off current main. Per-lane review: standard code-review + consistency-check (segment predicates vs `qSent`/`qAccepted`/`qWinRate`, drill-out URLs vs the list route's actual params).
- Merge is not deploy; it rides the next push cue.
