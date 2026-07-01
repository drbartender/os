# Proposal Options / Compare — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. In this repo, each **lane** below is built in its own worktree (`npm run worktree:new`), reviewed per-lane, and squash-merged to `main`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let admin present a client two or three proposal "options" side by side from one link, and let the client compare and choose one, while each option stays a full independent proposal so the money path is unchanged.

**Architecture:** Each option is a real `proposals` row; a new `proposal_groups` row bundles siblings and owns the public `/compare/:token` link. Client picks on a read-only compare page, then signs/pays that option's existing page. On the winning option's first payment, a single transaction commits the choice (first-writer-wins), archives the losers through the real archive reaps, and voids their unpaid invoices. The winner's invoice is created before settle so the webhook can link the payment.

**Tech Stack:** Node/Express, raw SQL via `pg`, React 18 (CRA), Stripe, Resend, `node:test`.

## Global Constraints (apply to every task)

- Money as integer **cents**, never floats. Proposal `total_price`/`amount_paid` are dollars in the DB (existing convention); invoices are cents. Do not change either.
- All SQL parameterized (`$1`,`$2`); never concatenate input.
- Client-visible errors throw `AppError` subclasses (`ValidationError`, `NotFoundError`, `ConflictError`, `PermissionError`) via `asyncHandler`; never `res.status().json({error})`.
- Stripe only via `server/utils/stripeClient.js`.
- Public token routes are UUID-guarded via `requireUuidToken` (`server/utils/tokens.js`).
- API JSON keys `snake_case`; JS vars `camelCase`.
- No em dashes in any client-facing or admin copy (commas, periods, colons, parentheticals).
- Frontend calls go through `client/src/utils/api.js`. New client routes added to `App.js` with correct guards.
- Multi-table writes wrapped in `BEGIN/COMMIT/ROLLBACK`. Schema idempotent (`IF NOT EXISTS`).
- File-size ratchet: keep new files < 300 lines where reasonable; split by responsibility.
- `pricingEngine.js` is NOT touched by this feature; each option prices as an ordinary proposal (hosted 1:100 bartender rule stays intact).
- Server tests: run `node --test <file>` (with `-r dotenv/config` where the suite needs env); the dev DB is shared, so run suites one at a time.

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
      - server/utils/proposalGroups.js
      - server/utils/proposalArchive.js
      - server/routes/proposals/groups.js
      - server/routes/proposals/index.js
      - server/routes/proposals/lifecycle.js   # reap-extraction only
      - ARCHITECTURE.md
      - README.md
    deps: [schema]
    fleet: [code-review, security-review, consistency-check]
  - id: grouped-send
    footprint:
      - server/routes/proposals/groups.js       # add send-group route (after group-core merged)
      - server/utils/groupSend.js
      - server/utils/emailTemplates.js
      - server/utils/sendProposalSentEmail.js
      - server/routes/proposals/lifecycle.js    # grouped-send guard on PATCH->sent
    deps: [group-core]
    fleet: [code-review, security-review, consistency-check]
  - id: compare-api
    footprint:
      - server/routes/proposals/publicToken.js  # add non-mutating /resolve
      - server/routes/proposals/group.js        # new public GET
      - server/routes/proposals/index.js        # mount public group router
    deps: [group-core]
    fleet: [code-review, security-review]
  - id: money-commit
    footprint:
      - server/utils/proposalGroupCommit.js
      - server/utils/invoiceHelpers.js          # voidUnpaidProposalInvoice
      - server/routes/stripeCreateIntent.js     # winner-invoice-before-settle
      - server/routes/stripeWebhook.js          # commit at both conversion sites
      - server/routes/proposals/actions.js      # commit at record-payment
    deps: [group-core]
    fleet: [code-review, security-review, database-review, consistency-check]
  - id: client-compare
    footprint:
      - client/src/App.js
      - client/src/pages/proposal/compare/**
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
Wave 2:  grouped-send | compare-api | money-commit      (parallel; no shared files*)
Wave 3:  client-compare | client-admin                  (parallel)
```

\* Verified no Wave-2 file overlap: `grouped-send` edits `groups.js`/`lifecycle.js`, `compare-api` edits `publicToken.js`/`group.js`/`index.js`, `money-commit` edits webhook/actions/invoiceHelpers/stripeCreateIntent. `index.js` is touched only by `compare-api` in Wave 2 (group-core already mounted the admin router in Wave 1). The archive reaps live in `proposalArchive.js` (created in group-core) so `money-commit` never edits `lifecycle.js`.

---

## Lane: schema

### Task 1: `proposal_groups` table + `group_id` + archive_reason value

**Files:**
- Modify: `server/db/schema.sql` (append near the other late ALTERs, after the proposals archive_reason block ~line 2349)

**Interfaces — Produces:**
- Table `proposal_groups(id, token uuid unique, client_id, chosen_proposal_id, created_by, created_at, updated_at)`
- Column `proposals.group_id INTEGER` (NULL = solo)
- `archive_reason` CHECK now allows `'option_not_chosen'`

- [ ] **Step 1: Append the DDL** (idempotent)

```sql
-- ── Proposal option groups (side-by-side "compare your options") ──────────────
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

-- archive_reason gains 'option_not_chosen' (drop + re-add the CHECK)
ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_archive_reason_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_archive_reason_check
  CHECK (archive_reason IS NULL OR archive_reason IN
    ('no_hire','client_cancelled','we_cancelled','event_completed','other','option_not_chosen'));
```

- [ ] **Step 2: Apply to the dev DB by hand** (schema.sql is not auto-applied to dev)

Run: `psql "$DATABASE_URL" -f server/db/schema.sql` (idempotent; safe to re-run). Confirm: `psql "$DATABASE_URL" -c "\d proposal_groups"` shows the table and `\d proposals` shows `group_id`.

- [ ] **Step 3: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(schema): proposal_groups table + proposals.group_id + option_not_chosen archive reason"
```

Note for the mer\ger: `initDb` applies `schema.sql` on boot in prod, so no separate prod migration step; the DDL is idempotent.

---

## Lane: group-core

### Task 2: Extract the archive reaps into `proposalArchive.js`

Rationale: the money-commit lane must archive losing options and run the same side effects `lifecycle.js` runs on `→archived` (`cancelMarketingForProposal`, `cancelPendingChangeRequestsForProposal`). Extract them so both callers share one path.

**Files:**
- Create: `server/utils/proposalArchive.js`
- Modify: `server/routes/proposals/lifecycle.js` (the `→archived` case calls the new helper)

**Interfaces — Produces:**
- `async archiveProposal(proposalId, { reason, dbClient })` → sets `status='archived'`, `archive_reason=reason`, runs the marketing + change-request cancels, writes a `proposal_activity_log` `archived` row. Assumes it runs inside a caller-provided transaction (`dbClient`).

- [ ] **Step 1: Read the current `→archived` block** in `server/routes/proposals/lifecycle.js` (the section that sets status archived and calls `cancelMarketingForProposal` / `cancelPendingChangeRequestsForProposal`) so the extracted helper is behavior-identical.

- [ ] **Step 2: Write the failing test** `server/utils/proposalArchive.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { archiveProposal } = require('./proposalArchive');

test('archiveProposal sets status, reason, and logs', async () => {
  const calls = [];
  const dbClient = { query: async (sql, params) => { calls.push([sql, params]); return { rows: [{ id: 1 }] }; } };
  await archiveProposal(1, { reason: 'option_not_chosen', dbClient });
  const joined = calls.map(c => c[0]).join('\n');
  assert.match(joined, /UPDATE proposals[\s\S]*status\s*=\s*'archived'/i);
  assert.ok(calls.some(c => (c[1] || []).includes('option_not_chosen')));
  assert.match(joined, /proposal_activity_log/i);
});
```

- [ ] **Step 3: Run it, expect FAIL** — `node --test server/utils/proposalArchive.test.js` → "Cannot find module './proposalArchive'".

- [ ] **Step 4: Implement `proposalArchive.js`** (move the reap logic here; keep the exact cancel calls)

```js
const { cancelMarketingForProposal, cancelPendingChangeRequestsForProposal } = require('./proposalReaps');
// If those live in lifecycle.js today, move them to proposalReaps.js in this task and
// re-import them in lifecycle.js. Keep signatures identical.

async function archiveProposal(proposalId, { reason, dbClient }) {
  await dbClient.query(
    `UPDATE proposals SET status = 'archived', archive_reason = $2, updated_at = NOW() WHERE id = $1`,
    [proposalId, reason]
  );
  await cancelMarketingForProposal(proposalId, dbClient);
  await cancelPendingChangeRequestsForProposal(proposalId, dbClient);
  await dbClient.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, detail) VALUES ($1, 'archived', $2)`,
    [proposalId, JSON.stringify({ reason })]
  );
}

module.exports = { archiveProposal };
```

- [ ] **Step 5: Refactor `lifecycle.js`** so its `→archived` case calls `archiveProposal(id, { reason, dbClient })` instead of the inline logic. Verify no behavior change: `node --test server/routes/proposals/lifecycle.test.js` (or the crud/status suite) still passes.

- [ ] **Step 6: Run the new test, expect PASS.** Commit.

```bash
git add server/utils/proposalArchive.js server/utils/proposalArchive.test.js server/routes/proposals/lifecycle.js server/utils/proposalReaps.js
git commit -m "refactor(proposals): extract archiveProposal + reaps for reuse by option groups"
```

### Task 3: `proposalGroups.js` — model + `addAlternative`

**Files:**
- Create: `server/utils/proposalGroups.js`
- Create (test): `server/utils/proposalGroups.test.js`

**Interfaces — Consumes:** `insertProposalRecord` (`server/utils/proposalInsert.js`). **Produces:**
- `GROUPABLE_STATUSES = ['draft','sent','viewed','modified']`
- `MAX_OPTIONS = 3`
- `async addAlternative(sourceProposalId, actorUserId, db)` → `{ groupId, groupToken, newProposalId }`. Throws `ConflictError` if source status not groupable, source already paid (`amount_paid > 0`), or group already at `MAX_OPTIONS`. Runs inside its own `BEGIN/COMMIT` (opens a client from the pool) OR accepts an external `db`; default: manage its own transaction.
- `async getGroupMembers(groupId, db)` → ordered-by-created_at array of `{ id, token, status, package_name, total_price, package_slug, pricing_type }`.

- [ ] **Step 1: Write failing tests** covering: (a) cloning a groupable solo creates a group + 2 members; (b) a `deposit_paid` source throws `ConflictError`; (c) the 4th option throws `ConflictError`. Use a transaction-rolled-back fixture against the dev DB (see `crud.test.js` for the harness pattern; wrap each test in `BEGIN`/`ROLLBACK`).

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { addAlternative, getGroupMembers } = require('./proposalGroups');

test('addAlternative clones a groupable proposal into a new group', async () => {
  // seed a groupable source proposal, capture its id (see seedTestData helpers)
  const src = await seedProposal({ status: 'sent', amount_paid: 0 });
  const { groupId, newProposalId } = await addAlternative(src.id, /*actor*/ 1, pool);
  const members = await getGroupMembers(groupId, pool);
  assert.strictEqual(members.length, 2);
  assert.ok(members.find(m => m.id === newProposalId));
  await cleanupGroup(groupId);
});

test('addAlternative rejects a paid source', async () => {
  const src = await seedProposal({ status: 'deposit_paid', amount_paid: 100 });
  await assert.rejects(() => addAlternative(src.id, 1, pool), /ConflictError|not.*group/i);
  await cleanupProposal(src.id);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `proposalGroups.js`.** Core logic (transaction, lock, gates, clone):

```js
const { insertProposalRecord } = require('./proposalInsert');
const { ConflictError } = require('./errors');

const GROUPABLE_STATUSES = ['draft', 'sent', 'viewed', 'modified'];
const MAX_OPTIONS = 3;

async function addAlternative(sourceProposalId, actorUserId, pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Lock the source; a concurrent double-click serializes here.
    const srcRes = await db.query(
      `SELECT * FROM proposals WHERE id = $1 FOR UPDATE`, [sourceProposalId]);
    const src = srcRes.rows[0];
    if (!src) throw new ConflictError('Source proposal not found');
    if (!GROUPABLE_STATUSES.includes(src.status) || Number(src.amount_paid || 0) > 0) {
      throw new ConflictError('This proposal can no longer take alternatives');
    }

    // Ensure a group.
    let groupId = src.group_id;
    let groupToken;
    if (!groupId) {
      const g = await db.query(
        `INSERT INTO proposal_groups (client_id, created_by) VALUES ($1, $2) RETURNING id, token`,
        [src.client_id, actorUserId]);
      groupId = g.rows[0].id; groupToken = g.rows[0].token;
      await db.query(`UPDATE proposals SET group_id = $1 WHERE id = $2`, [groupId, sourceProposalId]);
    } else {
      const g = await db.query(`SELECT token FROM proposal_groups WHERE id = $1 FOR UPDATE`, [groupId]);
      groupToken = g.rows[0].token;
    }

    // Cap.
    const countRes = await db.query(`SELECT COUNT(*)::int AS n FROM proposals WHERE group_id = $1`, [groupId]);
    if (countRes.rows[0].n >= MAX_OPTIONS) throw new ConflictError(`A comparison holds at most ${MAX_OPTIONS} options`);

    // Clone shared logistics via the canonical INSERT shape; default package to the source's.
    const clone = await insertProposalRecord(db, buildCloneFieldBag(src, { groupId, actorUserId }));

    await db.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, detail) VALUES ($1, 'alternative_added', $2)`,
      [sourceProposalId, JSON.stringify({ new_proposal_id: clone.id, group_id: groupId })]);

    await db.query('COMMIT');
    return { groupId, groupToken, newProposalId: clone.id };
  } catch (e) {
    await db.query('ROLLBACK'); throw e;
  } finally {
    db.release();
  }
}
```

`buildCloneFieldBag(src, {...})` copies client_id, event_type/category/custom, event_date, event_start_time, event_duration_hours, guest_count, venue_* fields, num_bars, package_id, and the source `pricing_snapshot`/`total_price` (so the clone is immediately valid), sets `status='draft'`, `group_id`, `created_by`. Match the exact field names `insertProposalRecord` expects (read `proposalInsert.js`).

- [ ] **Step 4: Run tests, expect PASS. Commit.**

```bash
git add server/utils/proposalGroups.js server/utils/proposalGroups.test.js
git commit -m "feat(proposals): proposalGroups.addAlternative (clone + gate + cap + lock)"
```

### Task 4: `removeAlternative` + dissolution

**Files:** Modify `server/utils/proposalGroups.js` (+ test).

**Interfaces — Produces:** `async removeAlternative(proposalId, pool)` → detaches the member (`group_id=NULL`); if the group is now a single member, dissolve it (clear survivor `group_id`, delete the group row). Throws `ConflictError` if the group is decided or the target is paid.

- [ ] **Step 1: Failing tests** — removing one of two members dissolves the group and the survivor goes solo; removing from a decided group throws.
- [ ] **Step 2: Implement** (lock the group `FOR UPDATE`; refuse when `chosen_proposal_id IS NOT NULL`; after detach, if `COUNT(*)=1` set the survivor `group_id=NULL` and `DELETE FROM proposal_groups WHERE id=$g`). Log `alternative_removed`.
- [ ] **Step 3: PASS. Commit.**

### Task 5: Admin routes `groups.js` + mount

**Files:**
- Create: `server/routes/proposals/groups.js`
- Modify: `server/routes/proposals/index.js` (mount)
- Modify: `ARCHITECTURE.md` (route table), `README.md` (folder tree)

**Interfaces — Produces (admin, `auth` + `role==='admin'`):**
- `POST /api/proposals/:id/alternative` → `addAlternative`, returns `{ group_token, new_proposal_id }`
- `DELETE /api/proposals/:id/group-membership` → `removeAlternative`
- `GET /api/proposals/:id/group` → `{ group_token, decided, members: [...] }` for the Alternatives panel

- [ ] **Step 1: Failing route test** `server/routes/proposals/groups.test.js` — POST alternative returns 200 + `new_proposal_id`; non-admin gets 403; paid source gets 409.
- [ ] **Step 2: Implement the router** with `asyncHandler`, explicit `if (req.user.role !== 'admin') throw new PermissionError()`, delegating to `proposalGroups`. Mount in `index.js`: `router.use('/', require('./groups'))`.
- [ ] **Step 3: PASS.** Update `ARCHITECTURE.md` route table + `README.md` tree. Commit.

```bash
git add server/routes/proposals/groups.js server/routes/proposals/groups.test.js server/routes/proposals/index.js ARCHITECTURE.md README.md
git commit -m "feat(api): admin option-group endpoints (add/remove alternative, list group)"
```

---

## Lane: grouped-send

### Task 6: `proposalOptionsSent` email template

**Files:** Modify `server/utils/emailTemplates.js` (+ its test).

**Interfaces — Produces:** `proposalOptionsSent({ clientName, eventTypeLabel = 'event', compareUrl })` → `{ subject, html, text }`. Subject: `Compare your options for your ${eventTypeLabel} — Dr. Bartender`. One CTA button "Compare Your Options" → `compareUrl`. No em dashes in body copy.

- [ ] **Step 1:** Failing test asserting subject + `compareUrl` present in html/text (mirror the existing `proposalSent` test).
- [ ] **Step 2:** Implement using `wrapEmail` + `ctaButton` exactly like `proposalSent`. Export it.
- [ ] **Step 3:** PASS. Commit.

### Task 7: `groupSend.js` + send-group route + solo-send guard + defer invoicing

**Files:**
- Create: `server/utils/groupSend.js`
- Modify: `server/routes/proposals/groups.js` (add `POST /api/proposals/:id/send-group`)
- Modify: `server/utils/sendProposalSentEmail.js` (only if needed to expose a no-op path; prefer NOT calling it for grouped members)
- Modify: `server/routes/proposals/lifecycle.js` (guard: `PATCH /:id/status → sent` on a grouped member returns 409 `USE_GROUP_SEND`)

**Interfaces — Consumes:** `getGroupMembers`, `emailTemplates.proposalOptionsSent`, `sendEmail`, `checkSuppression`, `PUBLIC_SITE_URL`. **Produces:** `async sendGroup(groupId, actorType, pool)` → transitions every `draft` member to `sent` in one transaction (all-or-nothing), does **not** call `createInvoiceOnSend` and does **not** send per-option `proposalSent`/`initialProposalSms`, then sends exactly one `proposalOptionsSent` (dedup-guarded), logs `group_sent`.

- [ ] **Step 1: Failing test** — `sendGroup` sets all members to `sent`, creates **zero** invoices (assert `SELECT COUNT(*) FROM invoices WHERE proposal_id IN (members)` is 0), and calls `sendEmail` exactly once with a compare URL. Stub `sendEmail`.
- [ ] **Step 2: Implement `sendGroup`**: `BEGIN`; `UPDATE proposals SET status='sent', sent_at=COALESCE(sent_at,NOW()) WHERE group_id=$1 AND status='draft'`; build `compareUrl = ${PUBLIC_SITE_URL}/compare/${groupToken}`; `checkSuppression` on the client; INSERT a `proposal_activity_log` `group_sent` row that doubles as the dedupe guard (skip send if one exists for this group in the last N minutes); `COMMIT`; then `sendEmail(proposalOptionsSent(...))` after commit.
- [ ] **Step 3: Implement the lifecycle guard** — in `PATCH /:id/status`, if target is `sent` and `proposal.group_id` is set, `throw new ConflictError('Grouped proposals send together')` with `code: 'USE_GROUP_SEND'`. Add a test.
- [ ] **Step 4: Add the route** `POST /api/proposals/:id/send-group` (admin) → resolve group from `:id`, call `sendGroup`. Test: 200 + one email; second immediate call is a no-op (dedupe).
- [ ] **Step 5: PASS. Commit.**

```bash
git add server/utils/groupSend.js server/utils/groupSend.test.js server/routes/proposals/groups.js server/routes/proposals/lifecycle.js server/utils/emailTemplates.js
git commit -m "feat(proposals): grouped send (one compare email, defer invoicing, suppress per-option comms)"
```

---

## Lane: compare-api

### Task 8: Non-mutating resolver on the token GET

**Files:** Modify `server/routes/proposals/publicToken.js` (+ test).

**Interfaces — Produces:** `GET /api/proposals/t/:token/resolve` (public, UUID-guarded, **no writes**) → `{ grouped, group_token, decided, chosen_token }`. Does not bump `view_count`, does not flip `sent→viewed`.

- [ ] **Step 1: Failing test** — hitting `/resolve` on a grouped, undecided member returns `{ grouped: true, group_token, decided: false }` AND leaves `view_count` unchanged (assert before/after). On a decided group returns `decided: true, chosen_token`.
- [ ] **Step 2: Implement** a lean SELECT joining `proposal_groups`; no UPDATE. Register the route above the existing mutating GET.
- [ ] **Step 3: PASS. Commit.**

### Task 9: Public compare GET + admin preview

**Files:**
- Create: `server/routes/proposals/group.js`
- Modify: `server/routes/proposals/index.js` (mount)

**Interfaces — Consumes:** `getGroupMembers`, the **exact public-safe column allowlist** used by `publicToken.js` (extract it to a shared const if not already, and reuse it per option). **Produces:**
- `GET /api/proposals/group/:token` (public, UUID-guarded) → `{ group_token, event_header, options: [ publicSafeOption... ], decided, chosen_token }`. 404 while every member is `draft` (visibility gate). If decided → include `chosen_token` so the client can redirect.
- `GET /api/proposals/group/:token/preview` (auth admin) → same shape, ignores the visibility gate.

- [ ] **Step 1: Failing tests** — public GET 404s when all members draft; returns 2 options once one is `sent`; **never** includes `admin_notes`/`stripe_customer_id`/signature fields (assert absent); preview requires auth.
- [ ] **Step 2: Implement**, reusing the allowlist. Mount: `router.use('/', require('./group'))`.
- [ ] **Step 3: PASS. Commit.**

```bash
git add server/routes/proposals/publicToken.js server/routes/proposals/group.js server/routes/proposals/index.js
git commit -m "feat(api): public compare group GET + non-mutating token resolver"
```

---

## Lane: money-commit

### Task 10: `voidUnpaidProposalInvoice`

**Files:** Modify `server/utils/invoiceHelpers.js` (+ test).

**Interfaces — Produces:** `async voidUnpaidProposalInvoice(proposalId, dbClient)` → voids the open Deposit/Full invoice for the proposal **only when `amount_paid = 0`**; no-op otherwise. Idempotent. Runs inside a caller transaction.

- [ ] **Step 1: Failing test** — an unpaid proposal's open invoice becomes `void`; a proposal with `amount_paid > 0` is left untouched; calling twice is a no-op.
- [ ] **Step 2: Implement** (guard `amount_paid=0`; `UPDATE invoices SET status='void' WHERE proposal_id=$1 AND status IN ('sent','partially_paid')`). Export it.
- [ ] **Step 3: PASS. Commit.**

### Task 11: `proposalGroupCommit.commitGroupChoice`

**Files:** Create `server/utils/proposalGroupCommit.js` (+ test).

**Interfaces — Consumes:** `archiveProposal` (`proposalArchive.js`), `voidUnpaidProposalInvoice`. **Produces:**
- `async commitGroupChoice(winnerProposalId, dbClient)` → `{ committed: boolean, conflict: boolean }`. If the winner has no `group_id`: `{ committed: false, conflict: false }` (solo, caller proceeds normally). Else: lock the group `FOR UPDATE`; first-writer-wins `UPDATE proposal_groups SET chosen_proposal_id=$winner, updated_at=NOW() WHERE id=$g AND chosen_proposal_id IS NULL`; if 0 rows updated and the existing `chosen_proposal_id != winner` → `{ committed:false, conflict:true }` (caller must NOT convert, flags refund + Sentry). Else archive every sibling via `archiveProposal(sibling, { reason:'option_not_chosen', dbClient })` and `voidUnpaidProposalInvoice(sibling, dbClient)`, log `option_chosen`, return `{ committed:true, conflict:false }`.

- [ ] **Step 1: Failing tests** — (a) winner in a 2-option group: chosen set, sibling archived (`status='archived'`, `archive_reason='option_not_chosen'`) and its unpaid invoice voided; (b) second different winner on an already-decided group returns `{conflict:true}` and does NOT re-archive; (c) solo proposal returns `{committed:false, conflict:false}`.
- [ ] **Step 2: Implement** exactly as the interface describes; everything on the passed `dbClient` (no own transaction).
- [ ] **Step 3: PASS. Commit.**

```bash
git add server/utils/proposalGroupCommit.js server/utils/proposalGroupCommit.test.js server/utils/invoiceHelpers.js
git commit -m "feat(proposals): commitGroupChoice (first-writer-wins, archive losers via reaps, void unpaid)"
```

### Task 12: Winner-invoice-before-settle at intent creation

**Files:** Modify `server/routes/stripeCreateIntent.js` (+ test).

- [ ] **Step 1: Failing test** — creating an intent for a grouped, invoice-less proposal first creates its Deposit invoice (so an open invoice exists); calling again does not duplicate (idempotent via `createInvoiceOnSend`).
- [ ] **Step 2: Implement** — inside the existing locked transaction, before creating the PaymentIntent, if `proposal.group_id` is set: `await createInvoiceOnSend(proposalId, dbClient)` (idempotent on proposal_id). This runs on the `?choose=1` pay path.
- [ ] **Step 3: PASS. Commit.**

### Task 13: Wire `commitGroupChoice` into all three conversion paths

**Files:** Modify `server/routes/stripeWebhook.js` (2 sites), `server/routes/proposals/actions.js` (record-payment).

**Interfaces — Consumes:** `commitGroupChoice`.

- [ ] **Step 1: Failing tests** — for each path (payment_intent.succeeded, checkout.session.completed, admin record-payment): paying the winner archives the sibling; a payment landing on an already-decided-by-other option does NOT convert (no shift created) and is flagged.
- [ ] **Step 2: Implement** — at each site, immediately before `createEventShifts(proposalId)`, call `const { committed, conflict } = await commitGroupChoice(proposalId, dbClient);` If `conflict`, skip `createEventShifts`, capture Sentry (`option_paid_after_decided`), and mark for refund (record the payment but do not convert). Otherwise proceed. All within the existing webhook/handler transaction.
- [ ] **Step 3: PASS** — run each suite separately (`node --test server/routes/stripeWebhook.test.js`, then the actions suite). Commit.

```bash
git add server/routes/stripeCreateIntent.js server/routes/stripeWebhook.js server/routes/proposals/actions.js
git commit -m "feat(payments): commit option-group choice on every conversion path + winner invoice before settle"
```

---

## Lane: client-compare

### Task 14: `/compare/:token` route + `ProposalCompare` page

**Files:**
- Modify: `client/src/App.js` (lazy route `/compare/:token`, public)
- Create: `client/src/pages/proposal/compare/ProposalCompare.js` (+ a `OptionColumn.js` if it grows past ~300 lines)

**Interfaces — Consumes:** `GET /api/proposals/group/:token`; `getPackageBySlug` + the section renderer from `ProposalPricingBreakdown` (extract the section list into a shared presentational component if reuse is cleaner). **Produces:** the compare UI.

- [ ] **Step 1:** Add the lazy import + `<Route path="/compare/:token" element={<ProposalCompare/>} />` alongside the existing `/proposal/:token` route (all domain variants).
- [ ] **Step 2:** Build `ProposalCompare`: fetch via `api.get('/proposals/group/'+token)`; render the shared header once, then an `OptionColumn` per option (name + tagline, derived BYOB/Hosted badge from `pricing_type`, headline total + deposit, package `sections[]`, a "Choose this one" button → `navigate('/proposal/'+option.token+'?choose=1')`). Include **loading**, **error+retry**, and **decided** (redirect to `chosen_token`) and **single-option** (render/redirect to the one proposal) states.
- [ ] **Step 3:** Verify with `CI=true npx react-scripts build` from `client/` (this is the gate Vercel enforces). Manual smoke on `/compare/<token>` against a seeded group.
- [ ] **Step 4: Commit.**

### Task 15: `ProposalView` redirect + `?choose` bypass

**Files:** Modify `client/src/pages/proposal/proposalView/ProposalView.js`.

- [ ] **Step 1:** On mount, before the existing mutating fetch, call `api.get('/proposals/t/'+token+'/resolve')`. Apply precedence: **decided** → `navigate('/proposal/'+chosen_token+'?choose=1', {replace:true})` (or the booked view); **grouped + undecided + no `?choose`** → `navigate('/compare/'+group_token, {replace:true})`; otherwise fall through to the normal (mutating) load. Read `?choose` from search params.
- [ ] **Step 2:** Guard the loop: when `?choose=1` is present, never redirect to compare.
- [ ] **Step 3:** `CI=true npx react-scripts build`; smoke: a grouped member link bounces to compare; `?choose=1` loads sign/pay; a decided group's old link lands on the booked option.
- [ ] **Step 4: Commit.**

```bash
git add client/src/App.js client/src/pages/proposal/compare/ client/src/pages/proposal/proposalView/ProposalView.js
git commit -m "feat(client): compare page + grouped-link redirect with choose bypass"
```

---

## Lane: client-admin

### Task 16: Alternatives panel on `ProposalDetail`

**Files:** Modify `client/src/pages/admin/ProposalDetail.js` (extract `AlternativesPanel.js` if it pushes the file toward the size cap).

- [ ] **Step 1:** Fetch `GET /proposals/:id/group`; render siblings (package, total, status). Buttons: **Add an alternative** → `POST /proposals/:id/alternative` then `navigate('/proposals/'+new_proposal_id+'?edit=1')`; **Remove** → `DELETE /proposals/:id/group-membership` (confirm dialog); **Send options** (shown when grouped + all-draft) → `POST /proposals/:id/send-group`. Include loading/empty/error/disabled-during-mutation states. Surface the 409 (`USE_GROUP_SEND`, cap, paid-source) errors as inline copy.
- [ ] **Step 2:** `CI=true npx react-scripts build`; smoke the add/remove/send loop.
- [ ] **Step 3: Commit.**

### Task 17: NULL-safe group rollup in dashboards

**Files:** Modify `client/src/pages/admin/ProposalsDashboard.js`, `client/src/pages/admin/ClientDetail.js`.

- [ ] **Step 1:** Collapse rows sharing a non-null `group_id` into one "N options" row (expand to see members); **rows with `group_id === null` remain individual** (never collapse all nulls into one pseudo-group). One "N options" row links to the primary/first member.
- [ ] **Step 2:** `CI=true npx react-scripts build`; smoke a client with a group + solo proposals.
- [ ] **Step 3: Commit.**

```bash
git add client/src/pages/admin/ProposalDetail.js client/src/pages/admin/ProposalsDashboard.js client/src/pages/admin/ClientDetail.js
git commit -m "feat(admin): alternatives panel + null-safe option-group rollup"
```

---

## Self-review (plan vs spec)

- **Spec coverage:** §4.1 compare page → T9/T14; §4.2 choose → T14/T15; §4.3 resolver+precedence → T8/T15; §5.1 add-alternative (gate/cap/lock) → T3/T5; §5.2 remove/dissolution → T4/T5/T16; §5.3 grouped send + suppression + defer → T6/T7; §5.4 rollup null-safety → T17; §6 choice-commit all 3 paths + first-writer-wins + reaps → T2/T11/T13; §7.1 winner-invoice-before-settle → T12; §7.2 void helper → T10; §8 schema → T1; §9 observability (activity log rows) → T2/T3/T4/T7/T11 (+ Sentry in T13); §13 tests/docs → per-lane tests + T5 docs. All covered.
- **Type consistency:** `archiveProposal({reason,dbClient})`, `commitGroupChoice(winnerId,dbClient)→{committed,conflict}`, `addAlternative(sourceId,actor,pool)→{groupId,groupToken,newProposalId}`, `voidUnpaidProposalInvoice(id,dbClient)` are used consistently across T11/T13/T16.
- **Open (deferred to build, per spec §14):** exact SQL of the reaps (read from lifecycle.js in T2); admin preview route shape (T9).

## Execution

Per this repo's model, execution is lane-by-lane: cut a worktree off `main` (`npm run worktree:new`), build the lane's tasks, run its declared review fleet, squash-merge to `main`, delete the lane. Run order = the wave graph above. Nothing ships until a separate, explicit push.
