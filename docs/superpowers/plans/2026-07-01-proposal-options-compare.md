# Proposal Options / Compare — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Each **lane** is built in its own worktree (`npm run worktree:new`), reviewed per-lane, squash-merged to `main`. Steps use checkbox (`- [ ]`).

**Spec:** `docs/superpowers/specs/2026-07-01-proposal-options-compare-design.md`

**Goal:** Let admin present a client two or three proposal "options" side by side from one link, and let the client compare and choose one, while each option stays a full independent proposal so the money path is unchanged.

**Architecture:** Each option is a real `proposals` row; a `proposal_groups` row bundles siblings and owns the public `/compare/:token` link. The client picks on a read-only compare page, then signs/pays that option's existing page. On the winning option's first settled payment, `commitGroupChoice` runs **inside that payment's existing settle transaction** (before COMMIT): it first-writer-wins-sets `chosen_proposal_id` and archives the losing rows (+voids their unpaid invoices). The winner's invoice is created (idempotently) **after** `payment_type` is stamped and **before** the existing link step, so it picks Deposit vs Full correctly and the link finds it. The losers' best-effort marketing/change-request reaps run **post-commit** (matching today's `→archived` semantics), so a loser's reap failure can never roll back a paid winner.

**Tech Stack:** Node/Express, raw SQL via `pg`, React 18 (CRA), Stripe, Resend, `node:test`.

## Global Constraints (apply to every task)

- Money as integer **cents** in invoices; proposal `total_price`/`amount_paid` are dollars (existing convention). Do not change either.
- Parameterized SQL only. Client-visible errors throw `AppError` subclasses via `asyncHandler`.
- Stripe only via `server/utils/stripeClient.js`. Public token routes UUID-guarded via `requireUuidToken`.
- API JSON keys `snake_case`; JS `camelCase`. No em dashes in any copy.
- Public token pages call the API with raw `axios` + `BASE_URL` (the established `ProposalView` exception), NOT `api.js`. Admin pages use `client/src/utils/api.js`.
- `proposal_activity_log` columns are `(proposal_id, action, actor_type, actor_id, details)` — `details` is JSONB, there is no `detail` column. Match existing usage (`lifecycle.js:94`, `actions.js:204`).
- Multi-table writes in `BEGIN/COMMIT/ROLLBACK`. Schema idempotent.
- File-size ratchet: 700 soft / 1000 hard. `invoiceHelpers.js` (975), `emailTemplates.js` (962), `stripeWebhook.js` (844) are near/over caps — prefer new files over growing them.
- `pricingEngine.js` is NOT touched (hosted 1:100 bartender rule stays intact).
- Server tests: `node --test <file>` (with `-r dotenv/config` where needed), one suite at a time (shared dev DB). Client has no unit runner — verify with `CI=true npx react-scripts build` + manual smoke. `schema.sql` must be applied to the dev DB by hand.

---

## Lane map (front-matter)

```yaml
lanes:
  - id: schema
    footprint: [server/db/schema.sql]
    deps: []
    fleet: [database-review]
  - id: group-core
    footprint:
      - server/utils/proposalGroups.js         # new
      - server/routes/proposals/groups.js       # new (admin)
      - server/routes/proposals/index.js        # mount admin group router
      - server/routes/proposals/crud.js         # add group_id to list SELECT allowlist
      - server/routes/clients.js                # add group_id to the proposals SELECTs
      - ARCHITECTURE.md
      - README.md
    deps: [schema]
    fleet: [code-review, security-review, consistency-check]
  - id: grouped-send
    footprint:
      - server/routes/proposals/groups.js       # add send-group route (group-core merged first)
      - server/utils/groupSend.js               # new
      - server/utils/emailTemplates.js
      - server/utils/sendProposalSentEmail.js
      - server/routes/proposals/lifecycle.js    # USE_GROUP_SEND guard on PATCH->sent
    deps: [group-core]
    fleet: [code-review, security-review, consistency-check]
  - id: compare-api
    footprint:
      - server/routes/proposals/publicToken.js  # non-mutating /resolve + export allowlist const
      - server/routes/proposals/compareGroup.js # new public GET (renamed from group.js)
      - server/routes/proposals/index.js        # mount public compareGroup router
    deps: [group-core]
    fleet: [code-review, security-review]
  - id: money-commit
    footprint:
      - server/utils/invoiceVoid.js             # new (NOT invoiceHelpers.js — 975 lines, near cap)
      - server/utils/proposalGroupCommit.js     # new
      - server/routes/stripeWebhook.js          # commit inside both settle txns
      - server/routes/proposals/actions.js      # commit inside record-payment txn
    deps: [group-core]
    fleet: [code-review, security-review, database-review, consistency-check]
  - id: client-compare
    footprint:
      - client/src/App.js
      - client/src/pages/proposal/compare/**    # new
      - client/src/pages/proposal/proposalView/ProposalView.js
    deps: [compare-api]
    fleet: [code-review, ui-ux-review]
  - id: client-admin
    footprint:
      - client/src/pages/admin/ProposalDetail.js
      - client/src/pages/admin/ProposalsDashboard.js
      - client/src/pages/admin/ClientDetail.js
    deps: [group-core, grouped-send]
    fleet: [code-review, ui-ux-review]
```

**Run-order (waves):**

```
Wave 0:  schema
Wave 1:  group-core
Wave 2:  grouped-send | compare-api | money-commit      (parallel; verified no shared files)
Wave 3:  client-compare | client-admin                  (parallel)
```

Wave-2 non-overlap (verified against real footprints): grouped-send=`groups.js`(created W1)+`groupSend.js`+`emailTemplates.js`+`sendProposalSentEmail.js`+`lifecycle.js`; compare-api=`publicToken.js`+`compareGroup.js`+`index.js`; money-commit=`invoiceVoid.js`+`proposalGroupCommit.js`+`stripeWebhook.js`+`actions.js`. `index.js` is edited only by compare-api in Wave 2 (group-core already merged its mount). money-commit imports the reaps (`marketingHandlers.js`, `changeRequests.js`) and `createInvoiceOnSend` (`invoiceHelpers.js`) without editing them, so it never touches `lifecycle.js`.

---

## Lane: schema

### Task 1: `proposal_groups` + `group_id` + archive_reason value

**Files:** Modify `server/db/schema.sql` (append after the proposals `archive_reason` CHECK block, ~line 2349).

**Produces:** table `proposal_groups(id, token uuid unique, client_id, chosen_proposal_id, created_by, created_at, updated_at)`; `proposals.group_id INTEGER` (NULL=solo); `archive_reason` allows `'option_not_chosen'`.

- [ ] **Step 1:** Append (idempotent):

```sql
-- ── Proposal option groups ("compare your options") ──────────────────────────
CREATE TABLE IF NOT EXISTS proposal_groups (
  id                 SERIAL PRIMARY KEY,
  token              UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  client_id          INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  chosen_proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
  created_by         INTEGER REFERENCES users(id),
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES proposal_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_proposals_group_id ON proposals(group_id);
ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_archive_reason_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_archive_reason_check
  CHECK (archive_reason IS NULL OR archive_reason IN
    ('no_hire','client_cancelled','we_cancelled','event_completed','other','option_not_chosen'));
```

- [ ] **Step 2:** Apply to dev: `psql "$DATABASE_URL" -f server/db/schema.sql`. Verify: `psql "$DATABASE_URL" -c "\d proposal_groups"` shows the table; `\d proposals` shows `group_id`. (`initDb` applies `schema.sql` on prod boot; no separate migration.)
- [ ] **Step 3:** Commit `server/db/schema.sql` — `feat(schema): proposal_groups + proposals.group_id + option_not_chosen`.

---

## Lane: group-core

### Task 2: `proposalGroups.js` — `addAlternative` (with explicit clone `group_id` write)

**Files:** Create `server/utils/proposalGroups.js` + `server/utils/proposalGroups.test.js`.

**Consumes:** `insertProposalRecord` (`proposalInsert.js`; **note: it does NOT write `group_id`, so the clone must be UPDATEd after insert**). **Produces:**
- `GROUPABLE_STATUSES = ['draft','sent','viewed','modified']`, `MAX_OPTIONS = 3`
- `async addAlternative(sourceProposalId, actorUserId, pool)` → `{ groupId, groupToken, newProposalId }`; manages its own `BEGIN/COMMIT`. Throws `ConflictError` on non-groupable status, `amount_paid>0`, or cap reached.
- `async getGroupMembers(groupId, db=pool)` → `[{ id, token, status, package_name, package_slug, total_price, pricing_type }]` ordered by `created_at`.

- [ ] **Step 1: Failing tests** (inline INSERT + manual cleanup, mirroring `crud.test.js:170` — no fictional `seedProposal`/BEGIN-ROLLBACK helpers):

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { addAlternative, getGroupMembers } = require('./proposalGroups');

async function insertProposal(fields = {}) {
  const r = await pool.query(
    `INSERT INTO proposals (client_id, status, amount_paid, guest_count, event_duration_hours,
       package_id, pricing_snapshot, total_price)
     VALUES ($1,$2,$3,50,4,$4,'{}'::jsonb,1000) RETURNING *`,
    [fields.client_id || null, fields.status || 'sent', fields.amount_paid || 0, fields.package_id || null]);
  return r.rows[0];
}

test('addAlternative clones a groupable proposal into a new group', async () => {
  const src = await insertProposal({ status: 'sent', amount_paid: 0 });
  const { groupId, newProposalId } = await addAlternative(src.id, 1, pool);
  const members = await getGroupMembers(groupId);
  assert.strictEqual(members.length, 2, 'both source and clone are in the group');
  assert.ok(members.find(m => m.id === newProposalId));
  assert.ok(members.find(m => m.id === src.id));
  // cleanup
  await pool.query('DELETE FROM proposals WHERE group_id = $1', [groupId]);
  await pool.query('DELETE FROM proposal_groups WHERE id = $1', [groupId]);
});

test('addAlternative rejects a paid source', async () => {
  const src = await insertProposal({ status: 'deposit_paid', amount_paid: 100 });
  await assert.rejects(() => addAlternative(src.id, 1, pool), /can no longer take alternatives/i);
  await pool.query('DELETE FROM proposals WHERE id = $1', [src.id]);
});
```

- [ ] **Step 2:** Run, expect FAIL (`node --test server/utils/proposalGroups.test.js`).
- [ ] **Step 3: Implement.** Critical: after `insertProposalRecord`, **explicitly write the clone's `group_id`** (insertProposalRecord can't):

```js
const { insertProposalRecord } = require('./proposalInsert');
const { ConflictError } = require('./errors');
const GROUPABLE_STATUSES = ['draft','sent','viewed','modified'];
const MAX_OPTIONS = 3;

async function addAlternative(sourceProposalId, actorUserId, pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows: [src] } = await db.query('SELECT * FROM proposals WHERE id=$1 FOR UPDATE', [sourceProposalId]);
    if (!src) throw new ConflictError('Source proposal not found');
    if (!GROUPABLE_STATUSES.includes(src.status) || Number(src.amount_paid || 0) > 0)
      throw new ConflictError('This proposal can no longer take alternatives');

    let groupId = src.group_id, groupToken;
    if (!groupId) {
      const g = await db.query(
        'INSERT INTO proposal_groups (client_id, created_by) VALUES ($1,$2) RETURNING id, token',
        [src.client_id, actorUserId]);
      groupId = g.rows[0].id; groupToken = g.rows[0].token;
      await db.query('UPDATE proposals SET group_id=$1 WHERE id=$2', [groupId, sourceProposalId]);
    } else {
      const g = await db.query('SELECT token FROM proposal_groups WHERE id=$1 FOR UPDATE', [groupId]);
      groupToken = g.rows[0].token;
    }
    const { rows: [{ n }] } = await db.query('SELECT COUNT(*)::int n FROM proposals WHERE group_id=$1', [groupId]);
    if (n >= MAX_OPTIONS) throw new ConflictError(`A comparison holds at most ${MAX_OPTIONS} options`);

    const clone = await insertProposalRecord(db, buildCloneFieldBag(src, actorUserId));  // status 'draft'
    await db.query('UPDATE proposals SET group_id=$1 WHERE id=$2', [groupId, clone.id]);  // insertProposalRecord can't set group_id

    await db.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1,'alternative_added','admin',$2,$3)`,
      [sourceProposalId, actorUserId, JSON.stringify({ new_proposal_id: clone.id, group_id: groupId })]);
    await db.query('COMMIT');
    return { groupId, groupToken, newProposalId: clone.id };
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  finally { db.release(); }
}
```

`buildCloneFieldBag(src, actorUserId)` returns the exact field names `insertProposalRecord` expects (read `proposalInsert.js:24-42`), copying client_id, event_type/category/custom, event_date, event_start_time, event_duration_hours, guest_count, venue_* , num_bars, package_id, pricing_snapshot, total_price, **`payment_type`, `deposit_amount`** (preserve these so the winner mints the correct Deposit-vs-Full invoice later — see Task 11 money-seam note); `status:'draft'`, `created_by:actorUserId`. (No `group_id` key — the column isn't in the INSERT; the clone's `group_id` is set by the explicit UPDATE above.)

- [ ] **Step 4:** Run, expect PASS. Commit.

### Task 3: `removeAlternative` + dissolution

**Files:** Modify `server/utils/proposalGroups.js` (+ tests).

**Produces:** `async removeAlternative(proposalId, pool)` → detaches (`group_id=NULL`); if group now has one member, dissolve (clear survivor `group_id`, `DELETE FROM proposal_groups`). Throws `ConflictError` if the group is decided (`chosen_proposal_id IS NOT NULL`).

- [ ] **Step 1:** Failing tests — remove one of two members dissolves the group + survivor goes solo; remove from a decided group throws.
- [ ] **Step 2:** Implement (lock group `FOR UPDATE`; refuse if decided; detach; if `COUNT=1` clear survivor + delete group). Log `alternative_removed` with the correct 5-column shape.
- [ ] **Step 3:** PASS. Commit.

### Task 4: admin routes + mount + surface `group_id` in list payloads

**Files:** Create `server/routes/proposals/groups.js`; modify `server/routes/proposals/index.js`, `server/routes/proposals/crud.js` (list SELECT), `server/routes/clients.js` (proposals SELECTs), `ARCHITECTURE.md`, `README.md`.

**Produces (admin, `auth` + explicit `req.user.role==='admin'`):** `POST /:id/alternative`, `DELETE /:id/group-membership`, `GET /:id/group` → `{ group_token, decided, members }`. **Also:** add `p.group_id` (and `p.group_id` via a join for `group_token`) to the `GET /api/proposals` list SELECT (`crud.js:96-106`) and to the two `FROM proposals p` SELECTs in `clients.js`, so the rollup consumers (client-admin lane) actually receive it. This is the cross-cutting-consistency duty for the new column.

- [ ] **Step 1:** Failing route test (`groups.test.js`) — POST returns `new_proposal_id`; non-admin 403; paid source 409. Plus a test asserting `GET /api/proposals` rows now include `group_id`.
- [ ] **Step 2:** Implement router with `asyncHandler` + `if (req.user.role!=='admin') throw new PermissionError()`; mount `router.use('/', require('./groups'))`; add `group_id` to the two payload sources.
- [ ] **Step 3:** PASS. Update `ARCHITECTURE.md` route table + `README.md` tree. Commit.

---

## Lane: grouped-send

### Task 5: `proposalOptionsSent` email

**Files:** Modify `server/utils/emailTemplates.js` (+ test). (962 lines; keep the addition tight, no verbose JSDoc, to stay under 1000.)

**Produces:** `proposalOptionsSent({ clientName, eventTypeLabel='event', compareUrl })` → `{subject, html, text}`. Subject `Compare your options for your ${eventTypeLabel} — Dr. Bartender`. One CTA "Compare Your Options" → compareUrl. No em dashes.

- [ ] Failing test (subject + compareUrl in html/text) → implement via `wrapEmail`+`ctaButton` → PASS → commit.

### Task 6: `groupSend.js` + route + solo-send guard + defer invoicing

**Files:** Create `server/utils/groupSend.js`; modify `server/routes/proposals/groups.js` (add `POST /:id/send-group`), `server/routes/proposals/lifecycle.js` (guard).

**Produces:** `async sendGroup(groupId, actorType, pool)` → in one tx sets every `draft` member to `sent`; does **not** call `createInvoiceOnSend` and does **not** send per-option `proposalSent`/`initialProposalSms`; after commit sends exactly one `proposalOptionsSent` (dedup via a `group_sent` activity row) after a `checkSuppression` pass.

- [ ] **Step 1: Failing test** asserting: all members `sent`; `SELECT COUNT(*) FROM invoices WHERE proposal_id = ANY(members)` is **0**; `sendEmail` called once with a `/compare/` URL; **`sendSMS`/`initialProposalSms` NOT called** (stub both, assert the SMS stub has zero calls). 
- [ ] **Step 2:** Implement `sendGroup`. `UPDATE proposals SET status='sent', sent_at=COALESCE(sent_at,NOW()) WHERE group_id=$1 AND status='draft'`; build `compareUrl=${PUBLIC_SITE_URL}/compare/${token}`; write a `group_sent` activity row inside the tx that doubles as the dedupe guard; COMMIT; then `checkSuppression` + `sendEmail(proposalOptionsSent(...))`.
- [ ] **Step 3:** Implement the lifecycle guard: in `PATCH /:id/status`, if target `sent` and `proposal.group_id` set, `throw new ConflictError('Grouped proposals send together')` with `code:'USE_GROUP_SEND'`. Add a test.
- [ ] **Step 4:** Add `POST /:id/send-group` (admin). Test: 200 + one email; immediate second call is a no-op (dedupe).
- [ ] **Step 5:** PASS. Commit.

---

## Lane: compare-api

### Task 7: Non-mutating resolver

**Files:** Modify `server/routes/proposals/publicToken.js` (+ test).

**Produces:** `GET /api/proposals/t/:token/resolve` (public, UUID-guarded, **no writes** — does not bump `view_count` or flip `sent→viewed`) → `{ grouped, group_token, decided, chosen_token }`.

- [ ] Failing test: on a grouped undecided member, returns `{grouped:true, group_token, decided:false}` and `view_count` is unchanged before/after (assert). On a decided group returns `decided:true, chosen_token`. → implement lean SELECT (no UPDATE), registered above the mutating GET → PASS → commit.

### Task 8: Public compare GET + admin preview (+ export the allowlist)

**Files:** Create `server/routes/proposals/compareGroup.js`; modify `server/routes/proposals/index.js`; modify `publicToken.js` to **export its public-safe column allowlist as a const** (currently an inline SELECT at `publicToken.js:39-57`) for reuse.

**Produces:** `GET /api/proposals/group/:token` (public) → `{ group_token, event_header, options:[publicSafeOption...], decided, chosen_token }`; 404 while every member is `draft`; decided → include `chosen_token`. `GET /api/proposals/group/:token/preview` (auth admin) → same, ignores the visibility gate.

- [ ] Failing tests: 404 when all draft; 2 options once one `sent`; **asserts `admin_notes`/`stripe_customer_id`/signature fields are absent** from every option; preview requires auth. → implement reusing the exported allowlist per option; mount `router.use('/', require('./compareGroup'))` → PASS → commit.

---

## Lane: money-commit

### Task 9: `voidUnpaidProposalInvoice` (new file, avoids the invoiceHelpers cap)

**Files:** Create `server/utils/invoiceVoid.js` (+ test). (NOT `invoiceHelpers.js` — it is 975 lines; a growing edit would hit the 1000 hard cap.)

**Produces:** `async voidUnpaidProposalInvoice(proposalId, dbClient)` → when the proposal's `amount_paid=0`, `UPDATE invoices SET status='void' WHERE proposal_id=$1 AND status IN ('sent','partially_paid')`; else no-op. Idempotent. Runs on the caller's `dbClient` (in-tx).

- [ ] Failing test (unpaid → open invoice becomes `void`; `amount_paid>0` untouched; double-call no-op) → implement → PASS → commit.

### Task 10: `commitGroupChoice` (in-tx: winner invoice + first-writer gate + loser archive/void)

**Files:** Create `server/utils/proposalGroupCommit.js` (+ test).

**Consumes:** `voidUnpaidProposalInvoice`. **Produces:**
- `async commitGroupChoice(winnerProposalId, dbClient)` → `{ committed, conflict, archivedLoserIds }`. Runs entirely on the passed `dbClient` (caller's open settle tx). Steps: if the winner has no `group_id` → `{committed:false, conflict:false, archivedLoserIds:[]}`. Else lock the group `FOR UPDATE`; **first-writer-wins** `UPDATE proposal_groups SET chosen_proposal_id=$w, updated_at=NOW() WHERE id=$g AND chosen_proposal_id IS NULL`; if 0 rows and existing chosen ≠ winner → `{committed:false, conflict:true, archivedLoserIds:[]}`. Else: for each sibling ≠ winner: `UPDATE proposals SET status='archived', archive_reason='option_not_chosen'`, `await voidUnpaidProposalInvoice(sibling, dbClient)`, write an `option_not_chosen` activity row (5-col shape); write an `option_chosen` activity row for the winner; return `{committed:true, conflict:false, archivedLoserIds}`.
- **Two things are deliberately NOT here:** (1) the winner's invoice — created in Task 11 *after* the `payment_type` UPDATE so `createInvoiceOnSend` picks Deposit vs Full correctly; (2) the best-effort marketing/change-request reaps — they run on their own pool connection, post-commit (see Task 11).

- [ ] Failing tests: (a) 2-option group, winner: `chosen_proposal_id` set, sibling `archived`+`option_not_chosen`, sibling unpaid invoice `void`, returns the sibling id in `archivedLoserIds`; (b) already-decided-by-other → `{conflict:true}`, no re-archive; (c) solo → `{committed:false}`. → implement → PASS → commit. (Winner-invoice creation is tested in Task 11, where `payment_type` is known.)

### Task 11: Wire into all three settle sites (inside the tx) + post-commit reaps

**Files:** Modify `server/routes/stripeWebhook.js` (two sites), `server/routes/proposals/actions.js` (record-payment).

**Placement (verified against the code — the three sites are NOT a uniform shape):**
- (a) `payment_intent.succeeded`: acquire `:69`, BEGIN `:75`, `proposal_payments` ON CONFLICT insert `:80-86` + `isFirstDelivery` `:87`, gate opens `:89`, `amount_paid`/`payment_type` UPDATE `:97-102`/`:164-169`, invoice-link `:222-352`, COMMIT `:361`. Insert `commitGroupChoice` right after `:89` (inside the first-delivery gate, before the credit).
- (b) `checkout.session.completed`: acquire `:608`, BEGIN `:611`, ON CONFLICT insert `:617-623` + `isFirstDelivery` `:624`, gate opens `:629`, `amount_paid`/`payment_type` UPDATE `:638-644`/`:650-656`, invoice-link `:664-676`, COMMIT `:682`. Insert right after `:629`.
- (c) `actions.js` record-payment: acquire `:179`, BEGIN `:181`, `amount_paid` UPDATE `:187-190`, `proposal_payments` **plain INSERT** `:194-198` (there is **no `isFirstDelivery` gate and no ON CONFLICT** here), invoice-link `:210-227`, COMMIT `:229`. Insert `commitGroupChoice` right after BEGIN `:181` — do NOT look for an isFirstDelivery block.

- [ ] **Step 1: Failing tests** per path: winner payment archives the sibling and the winner ends with a **linked invoice matching its `payment_type`** (Deposit for a deposit pay, Full for a full pay — no phantom balance); a payment on an already-decided-by-other option is recorded for audit but NOT converted and NOT credited.
- [ ] **Step 2: Implement per site.** Right after the insertion point above (before the credit), `const { conflict, archivedLoserIds } = await commitGroupChoice(proposalId, dbClient);`
  - **Winner invoice (order matters):** after the existing `amount_paid`/`payment_type` UPDATE and **before** the existing invoice-link SELECT, add `if (committed) await createInvoiceOnSend(proposalId, dbClient);` (idempotent). Placed here so `payment_type` is already stamped and `createInvoiceOnSend` mints Deposit vs Full correctly; the link SELECT (`status IN ('sent','partially_paid')`) then finds it.
  - **Conflict — webhook sites (a,b):** skip the credit + skip conversion, `Sentry.captureMessage('option_paid_after_decided', {proposalId})`, mark for manual refund, but **let the tx COMMIT** (the `proposal_payments` row inserted at `:80-86`/`:617-623` must persist as the audit trail). Do NOT bare-`return` before COMMIT.
  - **Conflict — record-payment (c):** since the payment row is inserted *after* the insertion point and this is a synchronous admin handler, `throw new ConflictError('This option was not the one the client booked')` **before** recording — no "refund" semantics (it is a manual cash/Venmo entry, nothing was captured).
  - **Post-commit reaps (all sites):** after COMMIT, alongside existing post-commit work: `for (const id of archivedLoserIds) { try { await cancelMarketingForProposal(id); await cancelPendingChangeRequestsForProposal(id); } catch (e) { Sentry.captureException(e); } }` — best-effort, matching today's `→archived` semantics so a reap failure never rolls back the paid winner.
  - Note: `actions.js` also has a second `createEventShifts` at `:46` (`POST /:id/create-shift`, requires already-paid) — deliberately excluded (not a first-settlement path). Keep the per-site wiring terse (`stripeWebhook.js` is 844 lines, over the 700 soft cap).
- [ ] **Step 3:** PASS (run each suite separately). Commit.

---

## Lane: client-compare

### Task 12: `/compare/:token` route + `ProposalCompare` (defensive render)

**Files:** Modify `client/src/App.js` (add `/compare/:token` at all four domain-variant route blocks, lines ~330/403/460/492); create `client/src/pages/proposal/compare/ProposalCompare.js` (+ `OptionColumn.js` if >300 lines).

**Consumes:** `GET /api/proposals/group/:token` via raw `axios.get(\`${BASE_URL}/proposals/group/${token}\`)` (public-page convention, like `ProposalView.js:92`); `getPackageBySlug` from `client/src/data/packages.js`.

- [ ] **Step 1:** Add the lazy import + route in all four blocks.
- [ ] **Step 2:** Build `ProposalCompare`: shared header once; an `OptionColumn` per option (name + `tagline`, derived BYOB/Hosted badge from `pricing_type`, total + deposit, package `sections[]`, "Choose this one" → `navigate('/proposal/'+option.token+'?choose=1')`). **Defensive render (spec §4.1):** when `getPackageBySlug(option.package_slug)` returns null (class/tasting/TBD-price package with no aligned sections), render a minimal card (name + tagline + total + "Full details on the next page") instead of broken/empty sections. Include loading, error+retry, decided (redirect to `chosen_token`), and single-option (render/redirect to the one proposal) states.
- [ ] **Step 3:** `CI=true npx react-scripts build` from `client/`; smoke `/compare/<token>` on a seeded group (including one with a non-catalog package to confirm the fallback).
- [ ] **Step 4:** Commit.

### Task 13: `ProposalView` redirect + `?choose` bypass

**Files:** Modify `client/src/pages/proposal/proposalView/ProposalView.js`.

- [ ] **Step 1:** On mount, before the existing mutating fetch, `axios.get(\`${BASE_URL}/proposals/t/${token}/resolve\`)`. Precedence: **decided** → `navigate('/proposal/'+chosen_token+'?choose=1',{replace:true})`; **grouped + undecided + no `?choose`** → `navigate('/compare/'+group_token,{replace:true})`; else fall through to the normal load. Read `?choose` from `useSearchParams`.
- [ ] **Step 2:** Loop guard: when `?choose=1` is present, never redirect to compare.
- [ ] **Step 3:** `CI=true npx react-scripts build`; smoke: grouped member link bounces to compare; `?choose=1` loads sign/pay; decided group's old link lands on the booked option.
- [ ] **Step 4:** Commit.

---

## Lane: client-admin

### Task 14: Alternatives panel on `ProposalDetail`

**Files:** Modify `client/src/pages/admin/ProposalDetail.js` (extract `AlternativesPanel.js` if near the 652-line file's cap).

- [ ] **Step 1:** Fetch `GET /proposals/:id/group` via `api.get`. Render siblings (package, total, status). Buttons: **Add an alternative** → `POST /proposals/:id/alternative` then `navigate('/proposals/'+new_proposal_id+'?edit=1')`; **Remove** → `DELETE /proposals/:id/group-membership` (confirm); **Send options** (shown when grouped + all-draft) → `POST /proposals/:id/send-group`. **Add-alternative package picker (spec §4.1): only offer packages that resolve via `getPackageBySlug`** (hide class/tasting/TBD from the option package list). Loading/empty/error/disabled-during-mutation states; surface 409 codes (`USE_GROUP_SEND`, cap, paid-source) as inline copy.
- [ ] **Step 2:** `CI=true npx react-scripts build`; smoke add/remove/send.
- [ ] **Step 3:** Commit.

### Task 15: NULL-safe group rollup

**Files:** Modify `client/src/pages/admin/ProposalsDashboard.js`, `client/src/pages/admin/ClientDetail.js`. (Consumes the `group_id` now present in the payloads per Task 4.)

- [ ] **Step 1:** Collapse rows sharing a **non-null** `group_id` into one "N options" row (expandable). **Rows with `group_id == null` stay individual** — never collapse all nulls into one pseudo-group.
- [ ] **Step 2:** `CI=true npx react-scripts build`; smoke a client with a group + solo proposals.
- [ ] **Step 3:** Commit.

---

## Self-review (plan vs spec)

- **Coverage:** §4.1 compare contents + **category fallback** → T12/T14; §4.3 resolver + precedence → T7/T13; §5.1 gate/cap/lock + **clone group_id write** → T2; §5.2 remove/dissolution → T3; §5.3 send + suppression (**email AND SMS**) + defer → T5/T6; §5.4 rollup + **group_id in payloads** → T4/T15; §6 choice-commit **in-tx, all 3 paths, first-writer** → T10/T11; §6 loser reaps **post-commit best-effort** → T11; §7.1 winner-invoice-before-settle **on every path (T11, after payment_type stamp, before link)** → T11; §7.2 void helper (**new file**) → T9; §8 schema → T1; §9 activity-log (correct `details` column) + Sentry (conflict + post-commit reap) → T2/T6/T10/T11. All covered.
- **Type consistency:** `addAlternative(srcId,actor,pool)→{groupId,groupToken,newProposalId}`; `commitGroupChoice(winnerId,dbClient)→{committed,conflict,archivedLoserIds}`; `voidUnpaidProposalInvoice(id,dbClient)`; activity-log INSERTs use `(proposal_id,action,actor_type,actor_id,details)` everywhere.
- **Review-fixes folded:** B1 (in-tx placement) → T11; B2 (loser-archive split, marketing reap post-commit) → T10/T11; B3 (clone group_id) → T2; B4 (group_id in payloads) → T4; B5 (`details` column) → global constraint + all INSERTs; B6 (category fallback) → T12/T14. W1 (invoiceVoid new file), W2 (Sentry), W3 (real test harness), W4 (axios+BASE_URL), W5 (winner invoice on all paths via commitGroupChoice). S1 (compareGroup.js), S2 (export allowlist), S3 (2nd createEventShifts note), S4 (SMS-suppression assertion).
- **Open (build-time pins):** exact `buildCloneFieldBag` keys (read `proposalInsert.js`); admin `/compare` preview route shape.

## Execution

Lane-by-lane per the wave graph: cut a worktree off `main` (`npm run worktree:new`), build the lane's tasks, run its declared fleet, squash-merge, delete. Nothing ships until a separate explicit push.
