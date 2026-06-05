# Thumbtack Auto-Draft Proposal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Thumbtack lead arrives, auto-create a reviewable draft proposal (The Core Reaction, prefilled from the lead) so the admin can open it, add an email, and Send, instead of rebuilding it by hand.

**Architecture:** A best-effort post-commit step in the Thumbtack webhook calls a new draft-builder util. The builder reuses a newly extracted shared `insertProposalRecord` helper (also adopted by the manual create route, so the two never drift) and prices through the real pricing engine. The draft is inert (`status='draft'`, no invoice, no send). Proposals gain a `source` column for a server-side filter + badge, and the Send action gains a no-email confirm.

**Tech Stack:** Node/Express, raw SQL via `pg`, React 18 CRA, `node:test`.

**Spec:** `docs/superpowers/specs/2026-06-05-thumbtack-auto-draft-proposal-design.md`

**Worktree:** Implement in a `thumbtack-autodraft` worktree (created at execution time via `npm run worktree:new -- thumbtack-autodraft`). All paths below are relative to the repo root.

---

## File Structure

- **Create** `server/utils/proposalInsert.js`: `insertProposalRecord(dbClient, fields)` composes the venue location, inserts the `proposals` row (full column set incl `source`/`admin_notes`), bulk-inserts `proposal_addons` from the snapshot. One responsibility: build a proposal row. Shared by the manual route and the Thumbtack util.
- **Create** `server/utils/thumbtackProposalDraft.js`: pure mappers (`mapEventType`, `toEtDateAndTime`, `buildAdminNotes`) plus `createDraftProposalFromLead(...)` (owns its transaction, calls `insertProposalRecord`).
- **Create** `server/utils/thumbtackProposalDraft.test.js`: unit tests for the pure mappers plus a DB test for `createDraftProposalFromLead`.
- **Create** `client/src/components/admin/SourceBadge.js`: tiny "Thumbtack" badge, null-safe.
- **Modify** `server/db/schema.sql`: two idempotent ALTERs plus the `source` CHECK.
- **Modify** `server/routes/proposals/crud.js`: adopt `insertProposalRecord` in `POST /`; add `source` to `GET /` SELECT and filter.
- **Modify** `server/routes/proposals/metadata.js`: source-scoped branch in `GET /dashboard-stats`.
- **Modify** `server/routes/thumbtack.js`: best-effort draft step in `POST /leads`; pass `proposalUrl`.
- **Modify** `server/utils/emailTemplates.js`: `newThumbtackLeadAdmin` gains `proposalUrl`.
- **Modify** `client/src/pages/admin/ProposalsDashboard.js`: source filter and badge.
- **Modify** `client/src/pages/admin/ProposalDetail.js`: no-email Send confirm.
- **Modify** `ARCHITECTURE.md`, `README.md`: docs.

Task order respects dependencies: schema (1) → shared builder (2) → pure mappers (3) → draft builder (4) → notification template (5) → webhook wiring (6) → server filter (7) → client filter/badge (8) → Send guard (9) → docs (10).

---

## Task 1: Schema migrations

**Files:**
- Modify: `server/db/schema.sql` (proposals ALTER near the proposals signature-column block ~line 875; thumbtack_leads ALTER right after the `thumbtack_leads` trigger ~line 1633)

- [ ] **Step 1: Add the `proposals.source` column + CHECK**

In `server/db/schema.sql`, immediately AFTER the proposal client-signature ALTER block (the line `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS client_signature_document_version VARCHAR(50);`) and BEFORE the `-- ─── Stripe Payment Sessions ───` comment, insert:

```sql
-- ─── Proposal origin (intake source) ───────────────────────────────
-- NULL means manual / direct (the contract, permanently — never "unknown").
-- Thumbtack auto-drafts set 'thumbtack'. Widen the CHECK as new sources land.
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS source VARCHAR(30);
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proposals_source_check'
  ) THEN
    ALTER TABLE proposals ADD CONSTRAINT proposals_source_check
      CHECK (source IS NULL OR source IN ('thumbtack'));
  END IF;
END $$;
```

- [ ] **Step 2: Add `thumbtack_leads.proposal_id`**

In `server/db/schema.sql`, immediately AFTER the `update_thumbtack_leads_updated_at` trigger block (the line `FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();` that follows `CREATE TRIGGER update_thumbtack_leads_updated_at`) and BEFORE `CREATE TABLE IF NOT EXISTS thumbtack_messages (`, insert:

```sql
-- Link a lead to the draft proposal auto-created from it (idempotency + tracing).
ALTER TABLE thumbtack_leads
  ADD COLUMN IF NOT EXISTS proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL;
```

- [ ] **Step 3: Apply the schema to the dev DB**

Run: `node server/db/migrate.js` (or the project's schema-apply script; if unsure, run `npm run db:migrate` — check `package.json` scripts first).
Expected: completes with no error; re-running is a no-op (idempotent).

- [ ] **Step 4: Verify the columns exist**

Run:
```bash
node -e "require('dotenv').config(); const {pool}=require('./server/db'); (async()=>{const r=await pool.query(\"select column_name from information_schema.columns where table_name='proposals' and column_name='source'\"); const r2=await pool.query(\"select column_name from information_schema.columns where table_name='thumbtack_leads' and column_name='proposal_id'\"); console.log('source:', r.rows.length, 'proposal_id:', r2.rows.length); process.exit(0);})()"
```
Expected: `source: 1 proposal_id: 1`

- [ ] **Step 5: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(thumbtack): add proposals.source and thumbtack_leads.proposal_id"
```

---

## Task 2: Shared `insertProposalRecord` helper

Extract the proposals-row + addons INSERT out of `crud.js POST /` into a shared, reusable helper, then make `crud.js` call it. This is a money-path refactor: behavior must be identical. `crud.test.js` is the regression gate.

**Files:**
- Create: `server/utils/proposalInsert.js`
- Modify: `server/routes/proposals/crud.js:135-285` (remove the inline `composedLocation`, INSERT, and addon-insert; call the helper)
- Test: `server/routes/proposals/crud.test.js` (existing — must stay green)

- [ ] **Step 1: Write the helper**

Create `server/utils/proposalInsert.js`:

```js
// Shared proposal-row builder. ONE source of the proposals INSERT shape +
// venue composition + addon insert, so the manual create route and the
// Thumbtack auto-draft util can never drift. Pricing, status transitions,
// invoices, and emails are the CALLER's job — this only writes the row(s).
const { composeVenueLocation } = require('./venueAddress');

/**
 * @param {object} dbClient  a connected pg client INSIDE an open transaction
 * @param {object} f         proposal fields (see below)
 * @returns {Promise<object>} the inserted proposals row (RETURNING *)
 */
async function insertProposalRecord(dbClient, f) {
  const v = f.venue || {};
  const composedLocation = composeVenueLocation(v) || f.eventLocationFallback || null;
  const snapshotJson = f.pricingSnapshot ? JSON.stringify(f.pricingSnapshot) : '{}';

  const result = await dbClient.query(`
    INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
      event_location, guest_count, package_id, num_bars, num_bartenders, pricing_snapshot, total_price, created_by,
      status, sent_at, class_options, client_provides_glassware,
      event_type, event_type_category, event_type_custom,
      venue_name, venue_street, venue_city, venue_state, venue_zip,
      source, admin_notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
    RETURNING *
  `, [
    f.clientId, f.eventDate || null, f.eventStartTime || null, f.durationHours,
    composedLocation, f.guestCount, f.packageId, f.numBars,
    f.numBartenders, snapshotJson, f.totalPrice, f.createdBy ?? null,
    f.status, f.sentAt || null, f.classOptions ? JSON.stringify(f.classOptions) : null,
    !!f.clientProvidesGlassware,
    f.eventType || null, f.eventTypeCategory || null, f.eventTypeCustom || null,
    v.name || null, v.street || null, v.city || null, v.state || null, v.zip || null,
    f.source || null, f.adminNotes || null,
  ]);
  const proposal = result.rows[0];

  const addons = (f.pricingSnapshot && f.pricingSnapshot.addons) || [];
  if (addons.length) {
    const placeholders = addons.map((_, i) => {
      const b = i * 8;
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`;
    }).join(',');
    const values = addons.flatMap(a =>
      [proposal.id, a.id, a.name, a.billing_type, a.rate, a.quantity, a.line_total, a.variant || null]
    );
    await dbClient.query(
      `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total, variant) VALUES ${placeholders}`,
      values
    );
  }
  return proposal;
}

module.exports = { insertProposalRecord };
```

- [ ] **Step 2: Require the helper in crud.js**

In `server/routes/proposals/crud.js`, after the existing `const { findOrCreateClient } = require('../../utils/clientDedup');` line (line 21), add:

```js
const { insertProposalRecord } = require('../../utils/proposalInsert');
```

- [ ] **Step 3: Replace the inline INSERT + addon block in `POST /`**

In `server/routes/proposals/crud.js`, find the block that currently starts with `// Insert proposal` and the `const proposalResult = await dbClient.query(\`` INSERT (around line 250) through the end of the `if (snapshot && snapshot.addons.length) { ... }` addon-insert block (around line 285). Replace that whole block with:

```js
    // Insert proposal + addons via the shared builder (single source of the
    // proposals INSERT shape — see proposalInsert.js).
    const proposal = await insertProposalRecord(dbClient, {
      clientId: finalClientId,
      eventDate: event_date,
      eventStartTime: event_start_time,
      durationHours: dh,
      venue: { name: venue_name, street: venue_street, city: venue_city, state: venue_state, zip: venue_zip },
      eventLocationFallback: event_location,
      guestCount: gc,
      packageId: package_id,
      numBars: nb,
      numBartenders,
      pricingSnapshot: snapshot,
      totalPrice,
      createdBy: req.user.id,
      status: proposalStatus,
      sentAt,
      classOptions: cleanClassOptions,
      clientProvidesGlassware: client_provides_glassware,
      eventType: event_type,
      eventTypeCategory: event_type_category,
      eventTypeCustom: event_type_custom,
      source: null,
      adminNotes: null,
    });
```

Then DELETE the now-redundant `composedLocation` computation (the `const composedLocation = composeVenueLocation({ ... }) || event_location || null;` block around lines 135-137) since `insertProposalRecord` composes it. Leave the `validateVenue(...)` call (lines 128-132) intact. Verify nothing else in the handler references `composedLocation` (grep: `grep -n composedLocation server/routes/proposals/crud.js` should return nothing after this edit).

Note: `snapshotJson` and the old `proposalResult` variable are removed; downstream code already uses `proposal` (e.g. `proposal.id`), which the helper still returns.

- [ ] **Step 4: Run the existing route tests (regression gate)**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: PASS (all cases). This proves the manual create + send + addon paths are byte-identical after the extraction. If any case fails, the refactor changed behavior; fix before continuing.

- [ ] **Step 5: Commit**

```bash
git add server/utils/proposalInsert.js server/routes/proposals/crud.js
git commit -m "refactor(proposals): extract shared insertProposalRecord helper"
```

---

## Task 3: Pure lead-mapping helpers

**Files:**
- Create: `server/utils/thumbtackProposalDraft.js` (pure helpers only this task)
- Test: `server/utils/thumbtackProposalDraft.test.js`

- [ ] **Step 1: Write failing tests for the pure mappers**

Create `server/utils/thumbtackProposalDraft.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapEventType, toEtDateAndTime, buildAdminNotes } = require('./thumbtackProposalDraft');

test('mapEventType: maps wedding category to wedding-reception + category', () => {
  const r = mapEventType({ category: 'Wedding Bartending', details: [] });
  assert.equal(r.eventType, 'wedding-reception');
  assert.equal(r.eventTypeCategory, 'wedding_related');
});

test('mapEventType: specific beats generic (milestone before birthday)', () => {
  const r = mapEventType({ category: 'Bartending', details: [{ question: 'Occasion?', answer: 'Milestone birthday' }] });
  assert.equal(r.eventType, 'milestone-birthday');
});

test('mapEventType: happy hour beats corporate', () => {
  const r = mapEventType({ category: 'Corporate happy hour', details: [] });
  assert.equal(r.eventType, 'corporate-happy-hour');
});

test('mapEventType: no match returns nulls', () => {
  const r = mapEventType({ category: 'Bartending', details: [{ question: 'x', answer: 'just drinks' }] });
  assert.equal(r.eventType, null);
  assert.equal(r.eventTypeCategory, null);
});

test('toEtDateAndTime: late-evening UTC stays on the ET calendar day', () => {
  // 2026-06-21T01:00:00Z is 2026-06-20 21:00 EDT
  const r = toEtDateAndTime('2026-06-21T01:00:00Z');
  assert.equal(r.eventDate, '2026-06-20');
  assert.match(r.eventStartTime, /9:00\s?PM/i);
});

test('toEtDateAndTime: null input yields nulls', () => {
  assert.deepEqual(toEtDateAndTime(null), { eventDate: null, eventStartTime: null });
});

test('buildAdminNotes: includes negotiation, category, description, Q&A', () => {
  const notes = buildAdminNotes({
    negotiationId: 'neg123', category: 'Wedding', leadPrice: '$15', chargeState: 'charged',
    eventDate: '2026-06-21T01:00:00Z', description: 'Need a bartender',
    details: [{ question: 'Guests?', answer: '80' }],
  });
  assert.match(notes, /neg123/);
  assert.match(notes, /Wedding/);
  assert.match(notes, /Need a bartender/);
  assert.match(notes, /Guests\?: 80/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test server/utils/thumbtackProposalDraft.test.js`
Expected: FAIL ("Cannot find module './thumbtackProposalDraft'" or undefined functions).

- [ ] **Step 3: Implement the pure helpers**

Create `server/utils/thumbtackProposalDraft.js` (pure helpers + exports; the DB function is added in Task 4):

```js
const { EVENT_TYPES } = require('./eventTypes');

const ET_TZ = 'America/New_York';

// Ordered, specific-before-generic; first substring hit wins. Every id MUST
// exist in EVENT_TYPES (validated by mapEventType's lookup).
const EVENT_TYPE_KEYWORDS = [
  ['rehearsal', 'rehearsal-dinner'],
  ['engagement', 'engagement-party'],
  ['bridal shower', 'bridal-shower'],
  ['bachelorette', 'bachelor-bachelorette'],
  ['bachelor', 'bachelor-bachelorette'],
  ['wedding', 'wedding-reception'],
  ['milestone', 'milestone-birthday'],
  ['birthday', 'birthday-party'],
  ['anniversary', 'anniversary'],
  ['graduation', 'graduation-party'],
  ['retirement', 'retirement-party'],
  ['baby shower', 'baby-shower'],
  ['happy hour', 'corporate-happy-hour'],
  ['corporate', 'corporate-event'],
  ['company', 'corporate-event'],
  ['office', 'corporate-event'],
  ['holiday', 'holiday-party'],
  ['fundraiser', 'fundraiser-gala'],
  ['gala', 'fundraiser-gala'],
  ['cocktail party', 'cocktail-party'],
  ['housewarming', 'housewarming'],
  ['block party', 'block-party'],
  ['dinner party', 'dinner-party'],
  ['celebration of life', 'celebration-of-life'],
  ['memorial', 'celebration-of-life'],
  ['funeral', 'celebration-of-life'],
  ['mixology', 'cocktail-class'],
  ['class', 'cocktail-class'],
  ['festival', 'festival-outdoor'],
  ['outdoor', 'festival-outdoor'],
];

/** Best-effort event type from the Thumbtack category + Q&A answers. */
function mapEventType(lead) {
  const haystack = [
    lead.category || '',
    ...(Array.isArray(lead.details) ? lead.details.map(d => d.answer || '') : []),
  ].join(' ').toLowerCase();
  for (const [needle, id] of EVENT_TYPE_KEYWORDS) {
    if (haystack.includes(needle)) {
      const entry = EVENT_TYPES.find(t => t.id === id);
      return { eventType: id, eventTypeCategory: entry ? entry.category : null };
    }
  }
  return { eventType: null, eventTypeCategory: null };
}

/** UTC timestamp -> { eventDate: 'YYYY-MM-DD', eventStartTime: '6:00 PM' } in ET. */
function toEtDateAndTime(ts) {
  if (!ts) return { eventDate: null, eventStartTime: null };
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return { eventDate: null, eventStartTime: null };
  const eventDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d); // en-CA => YYYY-MM-DD
  const eventStartTime = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
  return { eventDate, eventStartTime };
}

/** Admin-facing context block (no em dashes). */
function buildAdminNotes(lead) {
  const lines = [];
  lines.push(`Auto-created from Thumbtack lead (negotiation ${lead.negotiationId || 'unknown'}).`);
  lines.push(`Category: ${lead.category || 'N/A'}`);
  lines.push(`Lead price / charge state: ${lead.leadPrice || 'N/A'} / ${lead.chargeState || 'N/A'}`);
  lines.push(`Event date as received: ${lead.eventDate || 'not specified'}`);
  lines.push('');
  lines.push('Customer description:');
  lines.push(lead.description ? String(lead.description).slice(0, 2000) : '(none)');
  if (Array.isArray(lead.details) && lead.details.length) {
    lines.push('');
    lines.push('Q&A:');
    for (const d of lead.details) {
      lines.push(`- ${String(d.question || '').slice(0, 200)}: ${String(d.answer || '').slice(0, 500)}`);
    }
  }
  lines.push('');
  lines.push('Reminder: add the client email before sending if you want them emailed, verify package and details, then Send and paste the link into the Thumbtack message.');
  return lines.join('\n');
}

module.exports = { mapEventType, toEtDateAndTime, buildAdminNotes };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test server/utils/thumbtackProposalDraft.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/utils/thumbtackProposalDraft.js server/utils/thumbtackProposalDraft.test.js
git commit -m "feat(thumbtack): pure lead-to-proposal field mappers"
```

---

## Task 4: `createDraftProposalFromLead` (DB builder)

**Files:**
- Modify: `server/utils/thumbtackProposalDraft.js` (add the DB function + exports)
- Modify: `server/utils/thumbtackProposalDraft.test.js` (add a DB test)

- [ ] **Step 1: Write the failing DB test**

Append to `server/utils/thumbtackProposalDraft.test.js`:

```js
require('dotenv').config();
const { after } = require('node:test');
const { pool } = require('../db');
const { createDraftProposalFromLead } = require('./thumbtackProposalDraft');

const _cleanup = { proposalIds: [], clientIds: [], negotiationIds: [] };

test('createDraftProposalFromLead: creates a $350 Core Reaction draft and links the lead', async () => {
  const negotiationId = `test-neg-${Date.now()}`;
  _cleanup.negotiationIds.push(negotiationId);

  // a client to attach to
  const c = await pool.query(
    "INSERT INTO clients (name, phone, source) VALUES ('TT Draft Test', '+15550001111', 'thumbtack') RETURNING id"
  );
  const clientId = c.rows[0].id;
  _cleanup.clientIds.push(clientId);

  // a lead row (the webhook path inserts this before calling us)
  await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, customer_name, category, guest_count, raw_payload)
     VALUES ($1, $2, 'TT Draft Test', 'Wedding Bartending', 80, '{}'::jsonb)`,
    [negotiationId, clientId]
  );

  const lead = {
    negotiationId, category: 'Wedding Bartending', guestCount: 80,
    eventDate: null, description: 'Need a bartender for a wedding',
    locationCity: 'Tampa', locationState: 'FL', locationZip: '33602', locationAddress: '1 Bay St',
    details: [{ question: 'Guests?', answer: '80' }],
  };

  const { proposalId } = await createDraftProposalFromLead({ lead, clientId, negotiationId });
  _cleanup.proposalIds.push(proposalId);

  const p = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
  const row = p.rows[0];
  assert.equal(row.status, 'draft');
  assert.equal(row.source, 'thumbtack');
  assert.equal(Number(row.total_price), 350);   // service_only, num_bars 0 => no bar fee
  assert.equal(row.event_type, 'wedding-reception');
  assert.equal(row.event_type_category, 'wedding_related');
  assert.ok(row.event_location && row.event_location.includes('Tampa') && row.event_location.includes('FL'), 'event_location should be composed from the venue fields');
  assert.match(row.admin_notes || '', /Auto-created from Thumbtack/);

  const lead2 = await pool.query('SELECT proposal_id FROM thumbtack_leads WHERE negotiation_id = $1', [negotiationId]);
  assert.equal(lead2.rows[0].proposal_id, proposalId);

  // idempotency: a second call returns the same id, no new proposal
  const again = await createDraftProposalFromLead({ lead, clientId, negotiationId });
  assert.equal(again.proposalId, proposalId);
});

after(async () => {
  for (const id of _cleanup.proposalIds) {
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [id]);
  }
  for (const neg of _cleanup.negotiationIds) await pool.query('DELETE FROM thumbtack_leads WHERE negotiation_id = $1', [neg]);
  for (const id of _cleanup.proposalIds) await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  for (const id of _cleanup.clientIds) await pool.query('DELETE FROM clients WHERE id = $1', [id]);
  await pool.end();
});
```

Note: the `event_location` assert documents the expectation; if `composeVenueLocation` formats differently (e.g. includes the street), update the expected string to match its real output (run the test once and read the actual value) rather than changing the code.

- [ ] **Step 2: Run to verify failure**

Run: `node --test server/utils/thumbtackProposalDraft.test.js`
Expected: FAIL ("createDraftProposalFromLead is not a function").

- [ ] **Step 3: Implement `createDraftProposalFromLead`**

In `server/utils/thumbtackProposalDraft.js`, add the requires at the top (below the existing `EVENT_TYPES` require):

```js
const { pool } = require('../db');
const { calculateProposal } = require('./pricingEngine');
const { insertProposalRecord } = require('./proposalInsert');

const CORE_REACTION_SLUG = 'the-core-reaction';
```

Then add the function and update the exports:

```js
/**
 * Create an inert DRAFT proposal (The Core Reaction) from a parsed Thumbtack
 * lead. Owns its own transaction. NEVER creates an invoice, sends mail/SMS, or
 * sets 'sent'. Idempotent on the lead's existing proposal_id.
 */
async function createDraftProposalFromLead({ lead, clientId, negotiationId }) {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const guard = await dbClient.query(
      'SELECT proposal_id FROM thumbtack_leads WHERE negotiation_id = $1 FOR UPDATE',
      [negotiationId]
    );
    if (guard.rows[0] && guard.rows[0].proposal_id) {
      await dbClient.query('COMMIT');
      return { proposalId: guard.rows[0].proposal_id };
    }

    const pkgRes = await dbClient.query('SELECT * FROM service_packages WHERE slug = $1', [CORE_REACTION_SLUG]);
    const pkg = pkgRes.rows[0];
    if (!pkg) throw new Error(`Package ${CORE_REACTION_SLUG} not found`);

    // service_only packages rent no physical bar; num_bars MUST be 0 or the
    // engine adds first_bar_fee (Number(pkg.first_bar_fee || 50) => $50 even
    // when the column is 0). See pricingEngine.calculateBarRental.
    const numBars = pkg.bar_type === 'service_only' ? 0 : 1;
    const guestCount = lead.guestCount || 50;
    const durationHours = 4;

    const snapshot = calculateProposal({
      pkg, guestCount, durationHours, numBars,
      numBartenders: undefined, addons: [], syrupSelections: [],
    });

    const { eventType, eventTypeCategory } = mapEventType(lead);
    const { eventDate, eventStartTime } = toEtDateAndTime(lead.eventDate);

    const proposal = await insertProposalRecord(dbClient, {
      clientId,
      eventDate, eventStartTime, durationHours,
      venue: {
        name: null,
        street: lead.locationAddress || null,
        city: lead.locationCity || null,
        state: lead.locationState || null,
        zip: lead.locationZip || null,
      },
      eventLocationFallback: null,
      guestCount,
      packageId: pkg.id,
      numBars,
      numBartenders: snapshot.staffing.actual,
      pricingSnapshot: snapshot,
      totalPrice: snapshot.total,
      createdBy: null,
      status: 'draft',
      sentAt: null,
      classOptions: null,
      clientProvidesGlassware: false,
      eventType, eventTypeCategory, eventTypeCustom: null,
      source: 'thumbtack',
      adminNotes: buildAdminNotes({ ...lead, negotiationId }),
    });

    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, 'created', 'system', $2)`,
      [proposal.id, JSON.stringify({ source: 'thumbtack', negotiation_id: negotiationId })]
    );
    await dbClient.query(
      'UPDATE thumbtack_leads SET proposal_id = $1 WHERE negotiation_id = $2',
      [proposal.id, negotiationId]
    );

    await dbClient.query('COMMIT');
    console.log(`[thumbtack-draft] created proposal ${proposal.id} for negotiation ${negotiationId}`);
    return { proposalId: proposal.id };
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (e) { console.error('[thumbtack-draft] ROLLBACK failed:', e.message); }
    throw err;
  } finally {
    dbClient.release();
  }
}

module.exports = { mapEventType, toEtDateAndTime, buildAdminNotes, createDraftProposalFromLead };
```

(Replace the previous `module.exports` line from Task 3 with this expanded one.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test server/utils/thumbtackProposalDraft.test.js`
Expected: PASS (the DB test plus the 7 pure-mapper tests).

- [ ] **Step 5: Commit**

```bash
git add server/utils/thumbtackProposalDraft.js server/utils/thumbtackProposalDraft.test.js
git commit -m "feat(thumbtack): createDraftProposalFromLead draft builder"
```

---

## Task 5: Notification template gains `proposalUrl`

**Files:**
- Modify: `server/utils/emailTemplates.js:607-637` (`newThumbtackLeadAdmin`)

- [ ] **Step 1: Add the `proposalUrl` param and CTA**

In `server/utils/emailTemplates.js`, change the `newThumbtackLeadAdmin` signature (line 607) to accept `proposalUrl`:

```js
function newThumbtackLeadAdmin({ customerName, customerPhone, category, description, location, eventDate, details, adminUrl, proposalUrl }) {
```

Replace the yellow "Action needed" banner (the `<p style="background:#fff3cd;...">...</p>` block) with copy that reflects the draft, and replace the single CTA line `${adminUrl ? ctaButton(adminUrl, 'View Client') : ''}` with a draft-first CTA:

```js
      ${proposalUrl
        ? ctaButton(proposalUrl, 'Review & Send Proposal')
        : (adminUrl ? ctaButton(adminUrl, 'View Client') : '')}
```

For the banner, use:

```js
      <p style="background:#fff3cd;border:1px solid #ffc107;padding:12px;border-radius:6px;font-weight:bold;">
        ${proposalUrl
          ? "A Core Reaction draft proposal was created. Add the customer's email from Thumbtack (lead, three dots, create estimate/invoice), then review and Send."
          : "Action needed: Grab the customer's email from Thumbtack (lead, three dots, create estimate/invoice)."}
      </p>
```

Update the `text:` variant similarly, appending the proposal link when present:

```js
    text: `New Thumbtack lead: ${customerName || 'Unknown'} — ${customerPhone || 'no phone'}. Category: ${category || 'N/A'}. Location: ${location || 'N/A'}. Date: ${dateStr}. ${proposalUrl ? `Draft created — review & send: ${proposalUrl}` : 'ACTION: Grab email from Thumbtack.'}${!proposalUrl && adminUrl ? ` View: ${adminUrl}` : ''}`,
```

(The em dashes here are inside the existing template literal copy; match the file's existing style — leave the surrounding template as-is, only add the `proposalUrl` branch.)

- [ ] **Step 2: Smoke-test the template renders with and without proposalUrl**

Run:
```bash
node -e "const t=require('./server/utils/emailTemplates'); const a=t.newThumbtackLeadAdmin({customerName:'A',proposalUrl:'http://x/proposals/1'}); const b=t.newThumbtackLeadAdmin({customerName:'A',adminUrl:'http://x/clients/1'}); console.log(a.html.includes('Review & Send Proposal'), a.text.includes('review & send'), b.html.includes('View Client'));"
```
Expected: `true true true`

- [ ] **Step 3: Commit**

```bash
git add server/utils/emailTemplates.js
git commit -m "feat(thumbtack): proposal deep-link CTA in lead notification"
```

---

## Task 6: Wire the draft step into the webhook

**Files:**
- Modify: `server/routes/thumbtack.js` (require the builder; call it best-effort after COMMIT; pass `proposalUrl`)

- [ ] **Step 1: Require the draft builder**

In `server/routes/thumbtack.js`, after `const { findOrCreateClient } = require('../utils/clientDedup');` (line 10), add:

```js
const { createDraftProposalFromLead } = require('../utils/thumbtackProposalDraft');
```

- [ ] **Step 2: Create the draft best-effort, before the notification**

In `server/routes/thumbtack.js`, inside `POST /leads`, the code currently does `await dbClient.query('COMMIT');` then logs, then builds + sends the admin notification. Between the COMMIT/log and the `// Admin notification (non-blocking)` block, insert a best-effort draft step that captures `proposalId`:

```js
    // Auto-create a Core Reaction draft proposal (best-effort, post-commit).
    // A failure here must NOT roll back lead capture or 500 the webhook.
    let proposalId = null;
    if (clientId) {
      try {
        const draft = await createDraftProposalFromLead({ lead, clientId, negotiationId: lead.negotiationId });
        proposalId = draft ? draft.proposalId : null;
      } catch (draftErr) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(draftErr, { tags: { webhook: 'thumbtack', step: 'draft' } });
        }
        console.error('Thumbtack auto-draft failed (non-blocking):', draftErr);
      }
    }
```

- [ ] **Step 3: Pass `proposalUrl` into the notification**

In the same handler, in the `// Admin notification (non-blocking)` block, change the `adminUrl` line and the `newThumbtackLeadAdmin({...})` call to also compute and pass `proposalUrl`:

```js
      const adminUrl = clientId ? `${ADMIN_URL}/clients/${clientId}` : null;
      const proposalUrl = proposalId ? `${ADMIN_URL}/proposals/${proposalId}` : null;
      const tpl = newThumbtackLeadAdmin({
        customerName: lead.customerName,
        customerPhone: lead.customerPhone,
        category: lead.category,
        description: lead.description,
        location: [lead.locationCity, lead.locationState].filter(Boolean).join(', '),
        eventDate: lead.eventDate,
        details: lead.details,
        adminUrl,
        proposalUrl,
      });
```

- [ ] **Step 4: Restart the dev server and exercise the webhook**

The dev server is a Claude-managed background process (no auto-reload). Restart it (kill the PID on :5000, relaunch) per the project convention, then POST a fake lead:

```bash
curl -s -X POST http://localhost:5000/api/thumbtack/leads -H "Content-Type: application/json" -H "x-thumbtack-secret: $THUMBTACK_WEBHOOK_SECRET" -d '{"leadID":"manual-smoke-1","customer":{"name":"Smoke Test","phone":"+15550002222"},"request":{"category":"Wedding Bartending","description":"need bartender","location":{"city":"Tampa","state":"FL","zipCode":"33602"},"details":[{"question":"Guests?","answer":"80"}]}}'
```
Expected: `{"status":"ok"}`. Then confirm a draft exists:
```bash
node -e "require('dotenv').config(); const {pool}=require('./server/db'); (async()=>{const r=await pool.query(\"select p.id,p.status,p.source,p.total_price from proposals p join thumbtack_leads t on t.proposal_id=p.id where t.negotiation_id='manual-smoke-1'\"); console.log(r.rows); process.exit(0);})()"
```
Expected: one row, `status='draft'`, `source='thumbtack'`, `total_price=350`.

- [ ] **Step 5: Clean up the smoke row**

```bash
node -e "require('dotenv').config(); const {pool}=require('./server/db'); (async()=>{const t=await pool.query(\"select proposal_id,client_id from thumbtack_leads where negotiation_id='manual-smoke-1'\"); const {proposal_id,client_id}=t.rows[0]||{}; if(proposal_id){await pool.query('delete from proposal_activity_log where proposal_id=$1',[proposal_id]); await pool.query('delete from proposal_addons where proposal_id=$1',[proposal_id]);} await pool.query(\"delete from thumbtack_leads where negotiation_id='manual-smoke-1'\"); if(proposal_id) await pool.query('delete from proposals where id=$1',[proposal_id]); if(client_id) await pool.query('delete from clients where id=$1',[client_id]); console.log('cleaned'); process.exit(0);})()"
```

- [ ] **Step 6: Commit**

```bash
git add server/routes/thumbtack.js
git commit -m "feat(thumbtack): auto-create draft proposal on lead webhook"
```

---

## Task 7: Server-side `source` filter (list + counts)

**Files:**
- Modify: `server/routes/proposals/crud.js:52-101` (`GET /`)
- Modify: `server/routes/proposals/metadata.js:193` (`GET /dashboard-stats`)

- [ ] **Step 1: Add `source` to the list SELECT + filter**

In `server/routes/proposals/crud.js` `GET /`, add `source` to the destructure (line 53):

```js
  const { status, view = 'active', search, source, page = 1, limit = 50 } = req.query;
```

Add `p.source,` to the SELECT column list (e.g. right after `p.status,` on line 58). Then, immediately after the `if (search) { ... }` block (after line 92) and before `query += ' ORDER BY p.created_at DESC';`, add:

```js
  // Origin filter. Fixed literals only (no user value into SQL) — safe.
  if (source === 'thumbtack') {
    query += " AND p.source = 'thumbtack'";
  } else if (source === 'manual') {
    query += ' AND p.source IS NULL';
  }
```

- [ ] **Step 2: Add a source-scoped branch to dashboard-stats**

In `server/routes/proposals/metadata.js` `GET /dashboard-stats`, at the very top of the handler (right after the `async (req, res) => {` and before `const f = metrics.resolveFilters(req.query);`), add:

```js
  // Source-scoped counts for the Proposals list filter. Returns ONLY the tab
  // count fields the dashboard reads (pipeline / paidCount / archivedCount);
  // KPI cards never pass `source`, so they keep the full metrics path below.
  const srcParam = req.query.source === 'thumbtack' ? 'thumbtack'
    : req.query.source === 'manual' ? 'manual' : null;
  if (srcParam) {
    const clause = srcParam === 'thumbtack' ? "source = 'thumbtack'" : 'source IS NULL';
    const [pipeR, paidR, archR] = await Promise.all([
      pool.query(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total_price),0)::float8 AS value
                  FROM proposals WHERE status IN ('draft','sent','viewed','modified','accepted') AND ${clause} GROUP BY status`),
      pool.query(`SELECT COUNT(*)::int AS count FROM proposals WHERE status IN ('deposit_paid','balance_paid','confirmed','completed') AND ${clause}`),
      pool.query(`SELECT COUNT(*)::int AS count FROM proposals WHERE status = 'archived' AND ${clause}`),
    ]);
    const byStatus = Object.fromEntries(pipeR.rows.map(r => [r.status, { count: r.count, value: r.value }]));
    const pipeline = [
      { key: 'draft', label: 'Draft' }, { key: 'sent', label: 'Sent' },
      { key: 'viewed', label: 'Viewed' }, { key: 'modified', label: 'Modified' },
      { key: 'accepted', label: 'Accepted' },
    ].map(b => ({ key: b.key, label: b.label, count: byStatus[b.key]?.count || 0, value: byStatus[b.key]?.value || 0 }));
    return res.json({ pipeline, paidCount: paidR.rows[0].count, archivedCount: archR.rows[0].count });
  }
```

(`pool` is already required in `metadata.js`; confirm with `grep -n "require('../../db')" server/routes/proposals/metadata.js`. If it is imported as `{ pool }` use that; if the file uses a different db handle, match it.)

- [ ] **Step 3: Write a quick integration check**

Restart the dev server, then:

```bash
curl -s "http://localhost:5000/api/proposals?source=thumbtack" -H "Authorization: Bearer $ADMIN_JWT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const rows=JSON.parse(s);console.log('all thumbtack:', rows.every(r=>r.source==='thumbtack'), 'count:', rows.length);})"
```
Expected: `all thumbtack: true count: <n>` (n may be 0 on a clean DB — that still proves the filter runs). `$ADMIN_JWT` is a valid admin token (mint one the same way the test harness does, or copy from a logged-in browser session).

- [ ] **Step 4: Commit**

```bash
git add server/routes/proposals/crud.js server/routes/proposals/metadata.js
git commit -m "feat(proposals): server-side source filter for list and tab counts"
```

---

## Task 8: ProposalsDashboard badge + source filter

**Files:**
- Create: `client/src/components/admin/SourceBadge.js`
- Modify: `client/src/pages/admin/ProposalsDashboard.js`

- [ ] **Step 1: Create the badge component**

Create `client/src/components/admin/SourceBadge.js`:

```js
import React from 'react';

// Small origin badge next to a proposal's client name. Renders only for
// Thumbtack-sourced proposals (source === 'thumbtack'); null source means
// manual/direct and shows nothing. Admin surfaces only.
export default function SourceBadge({ source }) {
  if (source !== 'thumbtack') return null;
  return (
    <span
      className="badge"
      style={{ background: '#e8f0fe', color: '#1a5fb4', marginLeft: 6 }}
      title="From Thumbtack"
    >
      Thumbtack
    </span>
  );
}
```

- [ ] **Step 2: Import the badge + add source state in ProposalsDashboard**

In `client/src/pages/admin/ProposalsDashboard.js`:

Add the import after the `CcImportBadge` import (line 12):
```js
import SourceBadge from '../../components/admin/SourceBadge';
```

Add source state after the `tab` state (line 41):
```js
  const [sourceFilter, setSourceFilter] = useState('');  // '' | 'thumbtack' | 'manual'
```

- [ ] **Step 3: Thread `source` into both fetches**

Change the stats effect (lines 61-74) so it re-runs on `sourceFilter` and passes the param:
```js
  useEffect(() => {
    const qs = sourceFilter ? `?source=${sourceFilter}` : '';
    api.get(`/proposals/dashboard-stats${qs}`)
      .then(r => {
        const pipeByKey = Object.fromEntries((r.data?.pipeline || []).map(p => [p.key, p.count]));
        setCounts({
          active:   (pipeByKey.sent || 0) + (pipeByKey.viewed || 0) + (pipeByKey.modified || 0),
          draft:    pipeByKey.draft || 0,
          accepted: pipeByKey.accepted || 0,
          paid:     r.data?.paidCount || 0,
          archived: r.data?.archivedCount || 0,
        });
      })
      .catch(() => { /* leave counts at zero — graceful degradation */ });
  }, [sourceFilter]);
```

Change `fetchProposals` (lines 76-88) to append the source param, and add `sourceFilter` to its deps and the effect that calls it:
```js
  const fetchProposals = useCallback(async (currentTab) => {
    setLoading(true);
    try {
      const qs = tabToQuery[currentTab] || tabToQuery.active;
      const sourceQs = sourceFilter ? `&source=${sourceFilter}` : '';
      const list = await api.get(`/proposals${qs}${sourceQs}`);
      setProposals(list.data || []);
    } catch (err) {
      console.error('Failed to fetch proposals:', err);
      toast.error('Failed to load proposals. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }, [toast, tabToQuery, sourceFilter]);

  useEffect(() => { fetchProposals(tab); }, [fetchProposals, tab]);
```

(Note: `tabToQuery` values start with `?`, so the source param is appended with `&`.)

- [ ] **Step 4: Render the source filter control**

Immediately after the `<Toolbar ... />` line (line 140), add a source select:
```jsx
      <div className="hstack" style={{ gap: 8, marginBottom: 12 }}>
        <label className="tiny muted" htmlFor="source-filter">Source</label>
        <select
          id="source-filter"
          className="input"
          style={{ maxWidth: 200 }}
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
        >
          <option value="">All sources</option>
          <option value="thumbtack">Thumbtack</option>
          <option value="manual">Manual / Direct</option>
        </select>
      </div>
```

- [ ] **Step 5: Render the badge in the Client cell**

In the Client `<td>` (after the `<CcImportBadge ccId={p.proposal_cc_id} />` line ~170), add:
```jsx
                      <SourceBadge source={p.source} />
```

- [ ] **Step 6: Verify the client builds (Vercel CI parity)**

Run: `cd client && CI=true npx react-scripts build`
Expected: "Compiled successfully" (no ESLint-as-error failures). This is the gate Vercel enforces; the local pre-commit hook does not lint client code.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/admin/SourceBadge.js client/src/pages/admin/ProposalsDashboard.js
git commit -m "feat(proposals): Thumbtack badge + source filter on dashboard"
```

---

## Task 9: No-email Send confirm

**Files:**
- Modify: `client/src/pages/admin/ProposalDetail.js:181-189` (`updateStatus`)

- [ ] **Step 1: Guard the send in `updateStatus`**

In `client/src/pages/admin/ProposalDetail.js`, change `updateStatus` so a `sent` transition with no client email prompts first:

```js
  const updateStatus = async (status) => {
    if (status === 'sent' && !proposal.client_email) {
      const proceed = window.confirm('No email on file for this client. Send via SMS only?');
      if (!proceed) return;
    }
    try {
      const res = await api.patch(`/proposals/${id}/status`, { status });
      setProposal(prev => ({ ...prev, status: res.data.status }));
      if (status === 'sent') toast.success('Proposal sent to client.');
      else if (status === 'accepted') toast.success('Marked as accepted.');
      else toast.success(`Status updated to ${status}.`);
    } catch (err) {
      // ...existing catch unchanged...
```

(Keep the existing `catch` body exactly as-is; only the early-guard lines are new.)

- [ ] **Step 2: Verify the client builds**

Run: `cd client && CI=true npx react-scripts build`
Expected: "Compiled successfully".

- [ ] **Step 3: Manual smoke (optional but recommended)**

With the dev client running, open a draft proposal whose client has no email, click "Send to client", and confirm the browser prompt "No email on file for this client. Send via SMS only?" appears; Cancel aborts (status stays draft), OK proceeds.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/ProposalDetail.js
git commit -m "feat(proposals): confirm before sending a proposal with no client email"
```

---

## Task 10: Documentation

**Files:**
- Modify: `ARCHITECTURE.md` (Thumbtack integration section + the two new utils)
- Modify: `README.md` (folder-structure tree: new utils + SourceBadge)

- [ ] **Step 1: Update ARCHITECTURE.md**

In the Thumbtack integration section, add a sentence: a new Thumbtack lead now auto-creates a Core Reaction draft proposal (`server/utils/thumbtackProposalDraft.js`) via the shared `server/utils/proposalInsert.js` builder; the draft is inert (`status='draft'`, no invoice/send) and linked from `thumbtack_leads.proposal_id`. Note `proposals.source` (`'thumbtack'` vs null = manual) drives the dashboard filter/badge.

- [ ] **Step 2: Update README.md folder tree**

Add `proposalInsert.js` and `thumbtackProposalDraft.js` under `server/utils/`, and `SourceBadge.js` under `client/src/components/admin/`, in the folder-structure tree.

- [ ] **Step 3: Commit**

```bash
git add ARCHITECTURE.md README.md
git commit -m "docs(thumbtack): document auto-draft + source column"
```

---

## Final verification (before merge)

- [ ] Run the two server suites individually (shared dev DB, never in parallel):
  - `node --test server/utils/thumbtackProposalDraft.test.js` → PASS
  - `node --test server/routes/proposals/crud.test.js` → PASS (refactor regression)
- [ ] `cd client && CI=true npx react-scripts build` → Compiled successfully
- [ ] `npm run check:filesize` → no new RED (crud.js should shrink after the extraction)
- [ ] Manual end-to-end: POST a fake lead (Task 6 Step 4), confirm the draft appears in the Proposals dashboard with a Thumbtack badge, the source filter narrows to it, opening it shows the Q&A in admin notes, and the notification email (if `SEND_NOTIFICATIONS=true`) deep-links to it. Clean up the row.

---

## Spec coverage check

- Auto-draft on lead arrival → Tasks 4, 6
- The Core Reaction default, correct pricing (num_bars 0 for service_only) → Task 4
- Field mapping + ET timezone + event_type_category → Tasks 3, 4
- Admin notes context → Task 3
- Shared insert builder (no drift; composes location) → Task 2
- `thumbtack_leads.proposal_id` link + idempotency (FOR UPDATE) → Tasks 1, 4
- Best-effort post-commit, lead capture sacrosanct → Task 6
- Notification deep-link via notifyAdminCategory → Tasks 5, 6
- `proposals.source` + CHECK, server-side filter + consistent counts, badge → Tasks 1, 7, 8
- No-email Send confirm; SMS kept → Task 9
- PII (admin_notes excluded from public routes) → verified in spec; covered by existing allowlists (no code change needed)
- Docs → Task 10
