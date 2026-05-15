# Pre-Launch Data Scrub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Purge development/test data from the production Neon database while preserving real client, staff, Thumbtack-lead, and automation-config data, verified by a rehearsal on a Neon branch before an atomic production apply.

**Architecture:** A single committed transactional SQL script (`server/scripts/prelaunch-data-scrub.sql`) deletes non-kept rows in FK-safe order, gated by a fixed `created_at` cutoff so live post-analysis traffic is auto-preserved, with in-transaction post-condition asserts that `RAISE` → roll back on any mismatch. It is rehearsed on an instant Neon copy-on-write branch, verified, then run identically on production. The rehearsal branch is retained as the restore point.

**Tech Stack:** Neon PostgreSQL 17, Neon MCP tools (`create_branch`, `run_sql`, `run_sql_transaction`, `get_connection_string`, `delete_branch`), raw SQL.

**Source spec:** `docs/superpowers/specs/2026-05-15-prelaunch-data-scrub-design.md`

**Project/branch IDs:** project `round-tooth-34649976`; production branch `br-noisy-frog-ad99sa6l`.

**Cutoff constant:** `TIMESTAMPTZ '2026-05-16 00:00:00+00'` — deletes only touch rows created strictly before this. The keep-set was derived from data through 2026-05-15; anything created 2026-05-16+ is preserved untouched regardless of execution date. This value is FIXED — do not advance it even if execution slips.

**Keep-sets (single source of truth):**
- users: `1, 2, 12, 15, 16, 19`
- proposals: `21, 25, 30, 51, 52`
- clients: any row with a `thumbtack_leads` link **OR** id ∈ `21, 26, 31, 80, 83`
- email_leads: `44, 46`

---

### Task 1: Author the scrub SQL script

**Files:**
- Create: `server/scripts/prelaunch-data-scrub.sql`

- [ ] **Step 1: Write the script file**

Create `server/scripts/prelaunch-data-scrub.sql` with EXACTLY this content:

```sql
-- One-time pre-launch production data scrub.
-- Spec: docs/superpowers/specs/2026-05-15-prelaunch-data-scrub-design.md
-- Plan: docs/superpowers/plans/2026-05-15-prelaunch-data-scrub.md
--
-- Run as ONE transaction. Rehearse on a Neon branch before production.
-- The final DO block RAISEs on any post-condition failure → full ROLLBACK.
--
-- Cutoff: only rows created before 2026-05-16Z are eligible for deletion;
-- anything newer (live traffic after analysis) is preserved automatically.
--
-- Keep-sets: users {1,2,12,15,16,19}  proposals {21,25,30,51,52}
--   clients {has thumbtack_leads link} ∪ {21,26,31,80,83}  email_leads {44,46}

BEGIN;

-- Baseline snapshot of tables that MUST NOT change, so asserts can prove
-- zero collateral damage (auto-adapts to any live growth in tt_* tables).
CREATE TEMP TABLE _baseline ON COMMIT DROP AS
SELECT 'service_packages'      t, COUNT(*) n FROM service_packages
UNION ALL SELECT 'service_addons',       COUNT(*) FROM service_addons
UNION ALL SELECT 'cocktails',            COUNT(*) FROM cocktails
UNION ALL SELECT 'cocktail_categories',  COUNT(*) FROM cocktail_categories
UNION ALL SELECT 'mocktails',            COUNT(*) FROM mocktails
UNION ALL SELECT 'mocktail_categories',  COUNT(*) FROM mocktail_categories
UNION ALL SELECT 'app_settings',         COUNT(*) FROM app_settings
UNION ALL SELECT 'blog_posts',           COUNT(*) FROM blog_posts
UNION ALL SELECT 'thumbtack_leads',      COUNT(*) FROM thumbtack_leads
UNION ALL SELECT 'thumbtack_messages',   COUNT(*) FROM thumbtack_messages
UNION ALL SELECT 'thumbtack_reviews',    COUNT(*) FROM thumbtack_reviews
UNION ALL SELECT 'email_campaigns',      COUNT(*) FROM email_campaigns
UNION ALL SELECT 'email_sequence_steps', COUNT(*) FROM email_sequence_steps;

-- 1. Invoices for non-kept proposals (FK is RESTRICT → must precede proposals).
--    Cascades invoice_line_items, invoice_payments.
DELETE FROM invoices
 WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
   AND (proposal_id IS NULL OR proposal_id NOT IN (21,25,30,51,52));

-- 2. Shifts for non-kept proposals. Cascades shift_requests.
DELETE FROM shifts
 WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
   AND (proposal_id IS NULL OR proposal_id NOT IN (21,25,30,51,52));

-- 3. Non-kept proposals. Cascades proposal_addons, proposal_activity_log,
--    proposal_payments, stripe_sessions, drink_plans.
DELETE FROM proposals
 WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
   AND id NOT IN (21,25,30,51,52);

-- 4. Sequence enrollments for non-kept leads.
DELETE FROM email_sequence_enrollments
 WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
   AND (lead_id IS NULL OR lead_id NOT IN (44,46));

-- 5. Quote drafts for non-kept leads.
DELETE FROM quote_drafts
 WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
   AND (lead_id IS NULL OR lead_id NOT IN (44,46));

-- 6. Non-kept email leads.
DELETE FROM email_leads
 WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
   AND id NOT IN (44,46);

-- 7. Test SMS (the lone 2026-03-21 row; sender/recipient are kept users).
DELETE FROM sms_messages
 WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00';

-- 8. Non-kept clients. After proposals: every kept proposal points only to a
--    kept client, so no surviving FK is severed. tt-linked clients are always
--    kept, so no thumbtack_leads link is broken.
DELETE FROM clients c
 WHERE c.created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
   AND NOT (
     EXISTS (SELECT 1 FROM thumbtack_leads tl WHERE tl.client_id = c.id)
     OR c.id IN (21,26,31,80,83)
   );

-- 9. Non-kept users. Cascades agreements, applications, contractor_profiles,
--    onboarding_progress, interview_notes, interview_scores, payment_profiles,
--    shift_requests, application_activity, password_reset_tokens.
DELETE FROM users
 WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
   AND id NOT IN (1,2,12,15,16,19);

-- ── Post-condition asserts. Any failure RAISEs → whole transaction ROLLBACK ──
DO $$
DECLARE drift TEXT;
BEGIN
  -- 9a. Deletes fully applied (no pre-cutoff non-kept survivors).
  IF EXISTS (SELECT 1 FROM users
             WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
               AND id NOT IN (1,2,12,15,16,19))
  THEN RAISE EXCEPTION 'users: pre-cutoff non-kept rows survived'; END IF;

  IF EXISTS (SELECT 1 FROM proposals
             WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
               AND id NOT IN (21,25,30,51,52))
  THEN RAISE EXCEPTION 'proposals: pre-cutoff non-kept rows survived'; END IF;

  IF EXISTS (SELECT 1 FROM clients c
             WHERE c.created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
               AND NOT (EXISTS (SELECT 1 FROM thumbtack_leads tl WHERE tl.client_id=c.id)
                        OR c.id IN (21,26,31,80,83)))
  THEN RAISE EXCEPTION 'clients: pre-cutoff non-kept rows survived'; END IF;

  IF EXISTS (SELECT 1 FROM email_leads
             WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
               AND id NOT IN (44,46))
  THEN RAISE EXCEPTION 'email_leads: pre-cutoff non-kept rows survived'; END IF;

  -- 9b. No kept-set row was destroyed.
  IF (SELECT COUNT(*) FROM users WHERE id IN (1,2,12,15,16,19)) <> 6
  THEN RAISE EXCEPTION 'users: a kept account is missing'; END IF;
  IF (SELECT COUNT(*) FROM proposals WHERE id IN (21,25,30,51,52)) <> 5
  THEN RAISE EXCEPTION 'proposals: a kept proposal is missing'; END IF;
  IF (SELECT COUNT(*) FROM clients WHERE id IN (21,26,31,80,83)) <> 5
  THEN RAISE EXCEPTION 'clients: a kept proposal-client is missing'; END IF;
  IF (SELECT COUNT(*) FROM email_leads WHERE id IN (44,46)) <> 2
  THEN RAISE EXCEPTION 'email_leads: a kept lead is missing'; END IF;

  -- 9c. Referential integrity.
  IF EXISTS (SELECT 1 FROM proposals p
             WHERE p.id IN (21,25,30,51,52)
               AND (p.client_id IS NULL
                    OR NOT EXISTS (SELECT 1 FROM clients c WHERE c.id=p.client_id)))
  THEN RAISE EXCEPTION 'a kept proposal lost its client'; END IF;

  IF EXISTS (SELECT 1 FROM thumbtack_leads tl
             WHERE tl.client_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id=tl.client_id))
  THEN RAISE EXCEPTION 'a thumbtack_lead was orphaned by a client delete'; END IF;

  -- 9d. Untouched tables unchanged vs. baseline.
  SELECT string_agg(b.t, ', ') INTO drift
  FROM _baseline b
  JOIN (
    SELECT 'service_packages' t, COUNT(*) n FROM service_packages
    UNION ALL SELECT 'service_addons',       COUNT(*) FROM service_addons
    UNION ALL SELECT 'cocktails',            COUNT(*) FROM cocktails
    UNION ALL SELECT 'cocktail_categories',  COUNT(*) FROM cocktail_categories
    UNION ALL SELECT 'mocktails',            COUNT(*) FROM mocktails
    UNION ALL SELECT 'mocktail_categories',  COUNT(*) FROM mocktail_categories
    UNION ALL SELECT 'app_settings',         COUNT(*) FROM app_settings
    UNION ALL SELECT 'blog_posts',           COUNT(*) FROM blog_posts
    UNION ALL SELECT 'thumbtack_leads',      COUNT(*) FROM thumbtack_leads
    UNION ALL SELECT 'thumbtack_messages',   COUNT(*) FROM thumbtack_messages
    UNION ALL SELECT 'thumbtack_reviews',    COUNT(*) FROM thumbtack_reviews
    UNION ALL SELECT 'email_campaigns',      COUNT(*) FROM email_campaigns
    UNION ALL SELECT 'email_sequence_steps', COUNT(*) FROM email_sequence_steps
  ) a ON a.t=b.t AND a.n<>b.n;
  IF drift IS NOT NULL
  THEN RAISE EXCEPTION 'untouched tables changed: %', drift; END IF;

  RAISE NOTICE 'prelaunch-data-scrub: all asserts passed';
END $$;

COMMIT;
```

- [ ] **Step 2: Sanity-check the file locally (no DB)**

Run: `Get-Content server/scripts/prelaunch-data-scrub.sql | Measure-Object -Line`
Expected: ~150 lines, file present. (No execution — DB steps come later.)

- [ ] **Step 3: Commit the script**

```bash
git add server/scripts/prelaunch-data-scrub.sql
git commit -m "chore(scripts): one-time pre-launch data scrub SQL (rehearse-then-apply)"
```

---

### Task 2: Create the Neon rehearsal branch

**Tools:** load via `ToolSearch` query `select:mcp__Neon__create_branch,mcp__Neon__run_sql,mcp__Neon__run_sql_transaction,mcp__Neon__get_connection_string,mcp__Neon__delete_branch`

- [ ] **Step 1: Create the branch from production**

Call `mcp__Neon__create_branch` with `projectId: round-tooth-34649976`, name `prelaunch-scrub-rehearsal`. (Default parent = production `br-noisy-frog-ad99sa6l`.)
Record the returned new branch id as `<REHEARSAL_BRANCH>`.

- [ ] **Step 2: Confirm the branch mirrors production**

Call `mcp__Neon__run_sql` on `<REHEARSAL_BRANCH>`:
```sql
SELECT (SELECT COUNT(*) FROM proposals) p, (SELECT COUNT(*) FROM clients) c,
       (SELECT COUNT(*) FROM users) u;
```
Expected: `p=51, c=98, u=19` (matches production at analysis time; small upward drift is fine if live traffic arrived).

---

### Task 3: Rehearse the scrub on the branch

- [ ] **Step 1: Capture the pre-scrub recon on the branch**

Call `mcp__Neon__run_sql` on `<REHEARSAL_BRANCH>`:
```sql
SELECT 'proposals' t,COUNT(*) n FROM proposals
UNION ALL SELECT 'clients',COUNT(*) FROM clients
UNION ALL SELECT 'users',COUNT(*) FROM users
UNION ALL SELECT 'shifts',COUNT(*) FROM shifts
UNION ALL SELECT 'invoices',COUNT(*) FROM invoices
UNION ALL SELECT 'email_leads',COUNT(*) FROM email_leads
UNION ALL SELECT 'thumbtack_leads',COUNT(*) FROM thumbtack_leads ORDER BY t;
```
Record the output for the Task 4 diff.

- [ ] **Step 2: Run the scrub transactionally on the branch**

Call `mcp__Neon__run_sql_transaction` with `projectId: round-tooth-34649976`, `branchId: <REHEARSAL_BRANCH>`, and `sql` = the ordered statement array from `server/scripts/prelaunch-data-scrub.sql` (every statement between `BEGIN;` and `COMMIT;` inclusive of the `CREATE TEMP`, the 9 `DELETE`s, and the `DO $$ … $$;` block — exclude the literal `BEGIN;`/`COMMIT;` lines; the tool manages the transaction).

Expected: success, with notice `prelaunch-data-scrub: all asserts passed`. If it errors with any `RAISE EXCEPTION` message, the transaction rolled back — STOP, diagnose the message against the keep-sets, fix the script (Task 1), recommit, recreate branch, retry.

---

### Task 4: Verify the branch result

- [ ] **Step 1: Post-scrub counts on the branch**

Call `mcp__Neon__run_sql` on `<REHEARSAL_BRANCH>`:
```sql
SELECT 'proposals' t,COUNT(*) n FROM proposals
UNION ALL SELECT 'clients',COUNT(*) FROM clients
UNION ALL SELECT 'users',COUNT(*) FROM users
UNION ALL SELECT 'shifts',COUNT(*) FROM shifts
UNION ALL SELECT 'invoices',COUNT(*) FROM invoices
UNION ALL SELECT 'email_leads',COUNT(*) FROM email_leads
UNION ALL SELECT 'quote_drafts',COUNT(*) FROM quote_drafts
UNION ALL SELECT 'email_sequence_enrollments',COUNT(*) FROM email_sequence_enrollments
UNION ALL SELECT 'sms_messages',COUNT(*) FROM sms_messages
UNION ALL SELECT 'thumbtack_leads',COUNT(*) FROM thumbtack_leads
UNION ALL SELECT 'email_campaigns',COUNT(*) FROM email_campaigns ORDER BY t;
```
Expected (assuming no live drift on prod copy): proposals 5, clients 70, users 6, shifts 1, invoices 0, email_leads 2, quote_drafts 2, email_sequence_enrollments 2, sms_messages 0, thumbtack_leads 66, email_campaigns 1.

- [ ] **Step 2: Spot-check identities on the branch**

Call `mcp__Neon__run_sql` on `<REHEARSAL_BRANCH>`:
```sql
SELECT array_agg(id ORDER BY id) FROM users;
-- expect {1,2,12,15,16,19}
SELECT array_agg(id ORDER BY id) FROM proposals;
-- expect {21,25,30,51,52}
SELECT array_agg(id ORDER BY id) FROM email_leads;
-- expect {44,46}
SELECT COUNT(*) FROM clients
 WHERE NOT (EXISTS (SELECT 1 FROM thumbtack_leads tl WHERE tl.client_id=clients.id)
            OR id IN (21,26,31,80,83));
-- expect 0
```
Expected: arrays exactly as annotated; final count `0`. Any deviation → STOP, fix Task 1, recommit, recreate branch, re-rehearse.

---

### Task 5: Re-confirm the keep-set against live production (drift gate)

This runs immediately before the prod apply to ensure live traffic since analysis hasn't invalidated the hardcoded ids.

- [ ] **Step 1: Confirm kept ids still exist and are still real on production**

Call `mcp__Neon__run_sql` on `br-noisy-frog-ad99sa6l`:
```sql
SELECT 'users' t, array_agg(id ORDER BY id) ids FROM users WHERE id IN (1,2,12,15,16,19)
UNION ALL SELECT 'proposals', array_agg(id ORDER BY id) FROM proposals WHERE id IN (21,25,30,51,52)
UNION ALL SELECT 'clients', array_agg(id ORDER BY id) FROM clients WHERE id IN (21,26,31,80,83)
UNION ALL SELECT 'email_leads', array_agg(id ORDER BY id) FROM email_leads WHERE id IN (44,46);
```
Expected: users {1,2,12,15,16,19}, proposals {21,25,30,51,52}, clients {21,26,31,80,83}, email_leads {44,46} all fully present. If any kept id is missing → STOP and re-brainstorm the keep-set with the user.

- [ ] **Step 2: Quantify what the cutoff will delete vs. preserve on production**

Call `mcp__Neon__run_sql` on `br-noisy-frog-ad99sa6l`:
```sql
SELECT 'proposals post-cutoff (preserved)' k, COUNT(*) v FROM proposals
  WHERE created_at >= TIMESTAMPTZ '2026-05-16 00:00:00+00'
UNION ALL SELECT 'proposals pre-cutoff non-kept (will delete)', COUNT(*) FROM proposals
  WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00' AND id NOT IN (21,25,30,51,52)
UNION ALL SELECT 'clients post-cutoff non-tt (preserved)', COUNT(*) FROM clients c
  WHERE c.created_at >= TIMESTAMPTZ '2026-05-16 00:00:00+00'
    AND NOT EXISTS (SELECT 1 FROM thumbtack_leads tl WHERE tl.client_id=c.id);
```
Expected: ~46 proposals to delete; "preserved" buckets are any genuine post-analysis traffic. Eyeball the preserved post-cutoff rows are not in the delete scope. Present this summary to the user for a final go/no-go before Task 6.

---

### Task 6: Capture audit dump + apply to production

- [ ] **Step 1: Dump to-be-deleted rows for the audit trail**

Call `mcp__Neon__run_sql` on `br-noisy-frog-ad99sa6l` for each of these and save the combined JSON to `.tmp/prelaunch-scrub-deleted-2026-05-15.json` (the `.tmp/` dir is gitignored):
```sql
SELECT 'proposals' src, json_agg(p) j FROM (SELECT * FROM proposals
  WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00' AND id NOT IN (21,25,30,51,52)) p
UNION ALL SELECT 'clients', json_agg(c) FROM (SELECT * FROM clients c
  WHERE c.created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
    AND NOT (EXISTS (SELECT 1 FROM thumbtack_leads tl WHERE tl.client_id=c.id)
             OR c.id IN (21,26,31,80,83))) c
UNION ALL SELECT 'users', json_agg(u) FROM (SELECT id,email,role,onboarding_status,created_at
  FROM users WHERE created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
    AND id NOT IN (1,2,12,15,16,19)) u;
```
Expected: a file written with three row-sets. (Read-only; no mutation yet.)

- [ ] **Step 2: Apply the scrub transactionally to production**

Call `mcp__Neon__run_sql_transaction` with `projectId: round-tooth-34649976`, `branchId: br-noisy-frog-ad99sa6l`, `sql` = the SAME statement array used in Task 3 Step 2.

Expected: success with notice `prelaunch-data-scrub: all asserts passed`. If any `RAISE EXCEPTION` fires, production rolled back unchanged — STOP, report the message, do NOT retry blindly; re-enter Task 5 to diagnose drift.

---

### Task 7: Verify production

- [ ] **Step 1: Post-scrub counts on production**

Call `mcp__Neon__run_sql` on `br-noisy-frog-ad99sa6l` with the same query as Task 4 Step 1.
Expected: proposals 5 (+ any post-cutoff real), clients ≥70, users 6, shifts 1, invoices 0, email_leads 2 (+ any post-cutoff), sms_messages 0, thumbtack_leads unchanged, email_campaigns 1.

- [ ] **Step 2: Identity spot-check on production**

Call `mcp__Neon__run_sql` on `br-noisy-frog-ad99sa6l` with the same array/identity checks as Task 4 Step 2.
Expected: kept arrays present; zero pre-cutoff keep-predicate violations.

- [ ] **Step 3: Live app smoke check**

Confirm with the user: log into admin, open the proposals list and the staff list, confirm the 5 kept proposals + 6 kept users render and nothing errors. Confirm Thumbtack leads still list.

---

### Task 8: Retain restore point, then document

- [ ] **Step 1: Keep the rehearsal branch as the restore point**

Do NOT delete `<REHEARSAL_BRANCH>` yet. It is the instant rollback (it holds pre-scrub production state). Tell the user it will be kept until they confirm production is healthy.

- [ ] **Step 2: Update spec status + record outcome**

Edit `docs/superpowers/specs/2026-05-15-prelaunch-data-scrub-design.md`: change `**Status:**` line to `Executed <date> — production scrubbed, rehearsal branch <REHEARSAL_BRANCH> retained as restore point`.

```bash
git add docs/superpowers/specs/2026-05-15-prelaunch-data-scrub-design.md
git commit -m "docs: mark pre-launch data scrub executed"
```

- [ ] **Step 3: Branch cleanup (deferred — only on explicit user OK)**

After the user confirms production is healthy (hours/days later), call `mcp__Neon__delete_branch` for `<REHEARSAL_BRANCH>`. Until then, leave it. This step is NOT auto-run.

---

## Self-Review

**1. Spec coverage:**
- Keep/delete sets (users/proposals/clients/shifts/invoices/leads/drafts/enrollments/sms) → Task 1 script ✓
- FK-safe order incl. invoices-before-proposals (RESTRICT) → Task 1 steps 1-9 ✓
- Approach: Neon branch rehearsal → verify → atomic prod apply → Tasks 2,3,4,6,7 ✓
- In-transaction asserts → Task 1 DO block ✓
- Audit dump → Task 6 Step 1 ✓
- Retain branch + PITR as restore path → Task 8 ✓
- Untouched catalog/Thumbtack/Lab Rat → Task 1 baseline assert (9d) ✓
- Added beyond spec: fixed `created_at` cutoff + drift gate (Task 5) — required because production is live; preserves post-analysis real traffic. Consistent with spec intent (preserve real data).

**2. Placeholder scan:** No TBD/TODO. `<REHEARSAL_BRANCH>` is a runtime-bound id (captured Task 2 Step 1), not a placeholder. All SQL is complete and literal.

**3. Type/identity consistency:** Keep-set literals identical across script, asserts, Tasks 4/5/6/7 (users {1,2,12,15,16,19}, proposals {21,25,30,51,52}, clients {21,26,31,80,83}, email_leads {44,46}). Cutoff literal `TIMESTAMPTZ '2026-05-16 00:00:00+00'` identical in every delete and assert. Project id `round-tooth-34649976` / prod branch `br-noisy-frog-ad99sa6l` consistent throughout.
