# Split-by metrics (design spec)

Date: 2026-07-13. The committed follow-up from the Money Board
(`docs/superpowers/specs/2026-07-09-money-board-design.md` §11): close rate and
revenue split by event type and by lead source, so the board answers "where is
it coming from" and not just "how am I doing". Scoped as ONE lane, minimal-first.

## Grounding (prod, read-only, 2026-07-13)

- Source split has immediate signal: Thumbtack 104 sent / 17 won (16%) / $8,650
  won value; Direct 71 sent / 25 won (35%) / $19,356.
- Event type carries TWO vocabularies: native slugs (`wedding-reception`) and
  Thumbtack-draft human strings ("Wedding Reception"), plus 20 untyped rows.
  A naive GROUP BY splits twins into separate segments.

## Decisions

1. **Sibling endpoint, LAW untouched.** New `GET /api/proposals/metrics-split`
   (auth + requireAdminOrManager) in a new file. The two LAW endpoints and
   their frozen-shape tests stay byte-identical.
2. **Params:** `by=source|event_type` (required, whitelisted enum; anything
   else is a ValidationError), `from`/`to` (optional, `YYYY-MM-DD` validated,
   applied via the shared half-open `dateClause`). `basis` and `include_cc`
   are NOT accepted: the split is sent/accepted math and native-era only (the
   frozen ledger keeps no type or source detail).
3. **Response:**
   `{ by, filters: {from, to}, segments: [...], truncated: null | {segments, sent} }`
   where each segment is
   `{ key, sent: {count, value}, won: {count, value}, closeRatePct, pending }`.
   The server sends keys only; labels resolve client-side (decision 5).
   Semantics mirror the board exactly so numbers reconcile:
   - `sent` mirrors `qSent`'s native leg: `sent_at IS NOT NULL`, date on `sent_at`.
   - `won` mirrors `qAccepted`'s native leg: `accepted_at IS NOT NULL`, date on
     `accepted_at`, no status filter.
   - `closeRatePct` + `pending` mirror `qWinRate`'s native leg per segment:
     of the sent-in-range cohort, accepted (and not archived) vs still open.
   - Two GROUP BY queries (sent-cohort axis, accepted axis) merged by key
     server-side. Values are proposal DOLLARS, as everywhere in metrics.
4. **Vocabulary normalization (query-time only, no data mutation).**
   Segment key for event_type = `LOWER(REGEXP_REPLACE(TRIM(event_type), '\s+', '-', 'g'))`;
   NULL or empty maps to the sentinel key `__untyped`. This merges the twin
   vocabularies. Source key = `COALESCE(source, 'direct')`.
5. **Labels client-side:** event-type keys resolve through the EVENT_TYPES
   vocabulary (slug to label), fallback title-cased slug; `__untyped` renders
   "No type set". Source: `thumbtack` renders "Thumbtack", `direct` renders
   "Direct", unknown future sources title-case through.
6. **Segment cap, no silent truncation:** order by sent count desc, cap 12
   segments; any remainder rolls into one aggregate row
   `{ key: '__other', label: 'Everything else' }` and `truncated` reports what
   was rolled up. (Source will never hit the cap.)
7. **Drill-outs (interaction law: every row-backed number links out with exact
   semantics).**
   - Source rows: `/proposals?cohort=quoted&source=thumbtack&from&to` and
     `source=manual` for the direct row (the list's existing manual = NULL
     mapping).
   - Event-type rows: `/proposals?cohort=quoted&event_type=<key>&from&to`.
     To make this land on ALL of a segment's rows across both vocabularies,
     the proposals list route's `event_type` filter normalizes BOTH sides with
     the same expression (parameterized value, fixed SQL fragment). Old-style
     exact-slug calls still match (a slug normalizes to itself), so this is
     backward compatible. The list also accepts the sentinel
     `event_type=__untyped` mapping to `event_type IS NULL OR TRIM(event_type) = ''`.
   - The `__other` rollup row has no single honest filter and is styled
     non-affording (no dead clicks, no lying clicks).
8. **Surface: Funnel card only.** The card head gains a small seg
   `Split: None | Source | Type`. `None` renders the existing funnel body
   byte-identically. A split renders the segment table: label, Quoted count,
   Won count + value, Close% with a mini bar. Split choice lives in the URL
   (OverviewPage `useUrlListState`, new `split` key: `'' | 'source' | 'event_type'`),
   fetches lazily only when a split is active, own catch (card-level error
   line + retry, Band 1 untouched), refetches on range or split change.
9. **Era honesty, self-retiring:** when `eraOverlaps(from)`, the split body
   carries one footnote: "Splits cover DRB records only. The frozen ledger
   keeps no type or source detail." Fully native ranges show nothing.
10. **Chart split is DEFERRED (decided 2026-07-13 with Dallas).** Most
    event-type segments are below the signal floor for a monthly axis, and
    split multiplies the chart's modes (Compare, legend, rainbow hero).
    Named v2 shape if the table creates the appetite: source-only, exactly
    two lines, Compare disabled while split, rainbow suspended in that mode.

## Definition of done

- Route tests: mixed-vocabulary seed ("Wedding Reception" + `wedding-reception`
  + NULL + thumbtack/direct) asserting twin-merge, `__untyped` bucketing,
  cap/rollup, param validation (bad `by` is a 400, malformed dates ignored),
  and reconciliation: segment `won.count` sums equal `qAccepted`'s native leg
  on the same seed and range.
- List-route tests extended: normalized `event_type` matching (human-string
  row found via slug param) and the `__untyped` sentinel.
- LAW shape tests untouched and green.
- Split=None renders the funnel card exactly as today; both skins; 390px
  (table collapses like the board's other tables); CI build gate passes.
- No pool.connect anywhere (single-shot pool.query reads only, per the
  2026-07-13 connection-lifecycle rule).
