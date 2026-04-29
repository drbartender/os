# Hiring Pipeline Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `HiringDashboard.js` and `AdminApplicationDetail.js` with admin-os-vocab surfaces, add interview scheduling + scorecard + activity timeline, and align the data model to Dallas's actual hiring flow (4 stages, no manual activation, in-app interview scheduling).

**Spec:** `docs/superpowers/specs/2026-04-28-hiring-pipeline-redesign-design.md`

**Architecture:** Three-phase implementation. Phase 1 lands schema + server endpoints + the application form's referral question (one commit). Phase 2 builds the new `applicationDetail/` folder and replaces the legacy detail page (one commit). Phase 3 rewrites the Hiring Dashboard with kanban + KPI strip + search + scheduling modal, plus doc updates (one commit).

**Tech Stack:** Node.js / Express, raw SQL via `pg`, React 18 / CRA, axios via `utils/api.js`, JWT auth, Resend for email. No ORM. No automated test suite (vibe-coded — verification is manual + review agents).

**Verification model:** This codebase does not use TDD on the server side (no test framework configured). New endpoints are verified via curl / Postman against a running `npm run dev` instance. New UI is verified by manually walking through the flow in the browser. Pre-push, all 5 review agents auto-run per CLAUDE.md.

---

## File Structure

### Phase 1 — Schema + server + form (Commit 1)

| File | Action | Purpose |
|---|---|---|
| `server/db/schema.sql` | modify | Add 3 columns to `applications`, create `interview_scores` + `application_activity` tables |
| `server/routes/admin/applications.js` | modify | Extend list endpoint, add scorecard/interview/reject/restore/note/reminder endpoints |
| `server/routes/admin/hiring.js` | create | New file: `GET /hiring/summary` (KPI strip), `GET /hiring/search` (cross-state search) |
| `server/routes/admin/index.js` | modify | Mount the new `hiring` sub-router |
| `server/routes/application.js` | modify | Accept `referral_source` on submission |
| `server/utils/emailTemplates.js` | modify | Add interview-confirmation + paperwork-reminder templates |
| `client/src/pages/Application.js` | modify | Add "Who referred you?" optional field to the form |

### Phase 2 — Application Detail rewrite (Commit 2)

| File | Action | Purpose |
|---|---|---|
| `client/src/pages/admin/applicationDetail/AdminApplicationDetail.js` | create | Page shell — fetch, identity bar, pipeline strip, two-col layout, action handlers |
| `client/src/pages/admin/applicationDetail/helpers.js` | create | `AD_FLOW`, `initialsOf`, `relDay`, status-chip-kind helpers |
| `client/src/pages/admin/applicationDetail/components/PipelineStrip.js` | create | 4-segment strip + rejected banner |
| `client/src/pages/admin/applicationDetail/components/ScorecardCard.js` | create | 5-dim rubric, 1-5 dots, total /25, mobile-tappable |
| `client/src/pages/admin/applicationDetail/components/TimelineCard.js` | create | Unified activity feed + add-note textarea |
| `client/src/pages/admin/applicationDetail/components/OnboardingCard.js` | create | Paperwork checklist + Send-reminder CTA |
| `client/src/pages/admin/applicationDetail/components/ActionsCard.js` | create | Stage-aware primary CTA + secondary actions |
| `client/src/pages/admin/applicationDetail/components/StatsCard.js` | create | Applied / days in pipeline / source / interview / score |
| `client/src/pages/admin/applicationDetail/components/FilesBlock.js` | create | Resume / BASSET / Headshot tiles |
| `client/src/pages/admin/applicationDetail/components/FlagsCard.js` | create | Auto-derived chips (BASSET, Referral, warns) |
| `client/src/pages/admin/applicationDetail/components/ViabilityCard.js` | create | 8-cell quick-glance grid |
| `client/src/pages/admin/applicationDetail/components/RejectModal.js` | create | Asks for `rejection_reason`, fires reject endpoint |
| `client/src/pages/admin/applicationDetail/sections/SectionWords.js` | create | Why / Service / Additional |
| `client/src/pages/admin/applicationDetail/sections/SectionExperience.js` | create | Positions + Experience types + description prose |
| `client/src/pages/admin/applicationDetail/sections/SectionGear.js` | create | Tools + Equipment + Saturdays / commitments |
| `client/src/pages/admin/applicationDetail/sections/SectionContact.js` | create | Email / Phone / Address / DOB / Emergency contact |
| `client/src/pages/AdminApplicationDetail.js` | **delete** | Legacy file; replaced by the folder |
| `client/src/App.js` | modify | Update lazy-import path from `./pages/AdminApplicationDetail` to `./pages/admin/applicationDetail/AdminApplicationDetail` |

### Phase 3 — Hiring Dashboard rewrite + docs (Commit 3)

| File | Action | Purpose |
|---|---|---|
| `client/src/components/adminos/InterviewScheduleModal.js` | create | Date + time + notes + send-confirmation modal |
| `client/src/pages/admin/HiringDashboard.js` | rewrite | Kanban + KPI strip + search + scheduling modal |
| `CLAUDE.md` | modify | Folder-tree updates (per mandatory-doc-updates rule) |
| `README.md` | modify | Folder-tree updates |
| `ARCHITECTURE.md` | modify | New "Hiring pipeline" section |

---

## Phase 1 — Schema + Server + Form

### Task 1.1 — Schema migrations

**Files:**
- Modify: `server/db/schema.sql`

- [ ] **Step 1: Add the 3 application columns.** Append these idempotent migrations near the other `ALTER TABLE applications ADD COLUMN IF NOT EXISTS` blocks (search for an existing one to find the right spot):

```sql
-- ─── 2026-04-28 hiring redesign ──────────────────────────────────────
-- Referral source — captured on the application form ("Who referred you?")
ALTER TABLE applications ADD COLUMN IF NOT EXISTS referral_source TEXT;

-- Interview scheduling — single timestamp; future slot-picker grows into
-- a side table without touching this column.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS interview_at TIMESTAMPTZ;

-- Reason captured when admin rejects.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
```

- [ ] **Step 2: Add the `interview_scores` table.** Append after the `interview_notes` CREATE TABLE block:

```sql
CREATE TABLE IF NOT EXISTS interview_scores (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  personality       INTEGER CHECK (personality       BETWEEN 1 AND 5),
  customer_service  INTEGER CHECK (customer_service  BETWEEN 1 AND 5),
  problem_solving   INTEGER CHECK (problem_solving   BETWEEN 1 AND 5),
  speed_mindset     INTEGER CHECK (speed_mindset     BETWEEN 1 AND 5),
  hire_instinct     INTEGER CHECK (hire_instinct     BETWEEN 1 AND 5),
  scored_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
```

- [ ] **Step 3: Add the `application_activity` table.** Right after `interview_scores`:

```sql
CREATE TABLE IF NOT EXISTS application_activity (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type  VARCHAR(40) NOT NULL,
  -- Allowed: application_submitted, status_changed, interview_scheduled,
  --          interview_rescheduled, reminder_sent, note_added,
  --          onboarding_step_completed
  metadata    JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_application_activity_user_id_created_at
  ON application_activity (user_id, created_at DESC);
```

- [ ] **Step 4: Verify schema applies cleanly.** Restart the server (`npm run dev`) — `pool.query` initializes the schema on startup. Watch for SQL errors in the server log. Expected: no errors, server boots clean. If anything fails, the migration is non-idempotent — check for typos.

- [ ] **Step 5: Verify columns exist.** Connect to your dev DB and run:

```bash
psql "$DATABASE_URL" -c "\\d applications" | grep -E "referral_source|interview_at|rejection_reason"
psql "$DATABASE_URL" -c "\\dt interview_scores application_activity"
```

Expected: 3 column lines for `applications`, both tables listed.

---

### Task 1.2 — Extend `GET /admin/applications` list endpoint

**Files:**
- Modify: `server/routes/admin/applications.js:14-77` (the existing list handler)

- [ ] **Step 1: Add new fields to the SELECT.** In the main `appsResult` query (currently selecting from `users u INNER JOIN applications a`), add:

```sql
a.referral_source,
a.interview_at,
a.rejection_reason,
```

Just append these lines inside the existing SELECT clause; keep the existing fields.

- [ ] **Step 2: Add derived `onboarding_progress` and `onboarding_blocker`.** These come from the users table's onboarding-step booleans. Add the same `ONBOARDING_STEPS` constant that already lives in `client/src/pages/admin/HiringDashboard.js:6` to the route file (mirror it server-side). Then SELECT the booleans from `u`:

```js
const ONBOARDING_STEPS = [
  'account_created','welcome_viewed','field_guide_completed',
  'agreement_completed','contractor_profile_completed',
  'payday_protocols_completed','onboarding_completed',
];
```

In the SQL, add `u.welcome_viewed, u.field_guide_completed, u.agreement_completed, u.contractor_profile_completed, u.payday_protocols_completed, u.onboarding_completed` to the SELECT.

After the query, in the JSON response building, derive per-row:

```js
const enrichedApps = appsResult.rows.map(row => {
  const completedSteps = ONBOARDING_STEPS.filter(s => row[s]);
  const onboarding_progress = completedSteps.length / ONBOARDING_STEPS.length;
  const firstIncomplete = ONBOARDING_STEPS.find(s => !row[s]);
  const onboarding_blocker = firstIncomplete
    ? firstIncomplete.replace(/_/g, ' ')
    : null;

  // Derive flags from existing data.
  const flags = [];
  if (row.basset_file_url) flags.push('BASSET');
  if (row.referral_source) flags.push('Referral');
  if (!row.basset_file_url && row.has_bartending_experience) flags.push('No BASSET');

  return { ...row, onboarding_progress, onboarding_blocker, flags };
});
```

Replace `applications: appsResult.rows` in the `res.json(...)` call with `applications: enrichedApps`.

- [ ] **Step 3: Add `basset_file_url` to the SELECT** (needed for the flag derivation in Step 2). Add `a.basset_file_url` to the SQL.

- [ ] **Step 4: Verify with curl.** With the dev server running:

```bash
TOKEN="<paste-admin-jwt-from-localStorage>"
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:5000/api/admin/applications?page=1&limit=5" | jq '.applications[0] | {full_name, referral_source, interview_at, onboarding_progress, onboarding_blocker, flags}'
```

Expected: each applicant row includes the new keys (most will be `null` / `0` / `[]` since data isn't there yet).

---

### Task 1.3 — Extend `GET /admin/applications/:userId` detail endpoint

**Files:**
- Modify: `server/routes/admin/applications.js` (the existing single-app handler at `/applications/:userId`)

- [ ] **Step 1: Locate the handler.** Around line 80. It currently joins `applications` + reads `interview_notes`. Don't break that — add to it.

- [ ] **Step 2: Add new fields to the main SELECT** (referral_source, interview_at, rejection_reason, onboarding step booleans, basset_file_url, resume_file_url, headshot_file_url + corresponding `*_filename` fields if not already present).

- [ ] **Step 3: Fetch scorecard and activity in parallel.** Replace the sequential queries with `Promise.all`:

```js
const [appResult, notesResult, scoresResult, activityResult] = await Promise.all([
  pool.query(/* existing app+user join */, [userId]),
  pool.query(/* existing interview_notes query */, [userId]),
  pool.query('SELECT * FROM interview_scores WHERE user_id = $1', [userId]),
  pool.query(`
    SELECT a.id, a.event_type, a.metadata, a.created_at,
           u.email AS actor_email, cp.preferred_name AS actor_name
    FROM application_activity a
    LEFT JOIN users u ON u.id = a.actor_id
    LEFT JOIN contractor_profiles cp ON cp.user_id = a.actor_id
    WHERE a.user_id = $1
    ORDER BY a.created_at DESC
    LIMIT 200
  `, [userId]),
]);
```

- [ ] **Step 4: Build a unified timeline.** Merge `interview_notes` (legacy) and `application_activity` (new) into one timeline sorted by `created_at DESC`:

```js
const timeline = [
  ...activityResult.rows.map(r => ({
    kind: 'activity',
    event_type: r.event_type,
    metadata: r.metadata,
    actor_name: r.actor_name || r.actor_email,
    created_at: r.created_at,
  })),
  ...notesResult.rows.map(r => ({
    kind: 'activity',
    event_type: 'note_added',
    metadata: { note: r.note },
    actor_name: null, // legacy notes don't track admin
    created_at: r.created_at,
  })),
].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
```

- [ ] **Step 5: Include scorecard + timeline in the JSON response.**

```js
res.json({
  application: enrichedApp, // run the same enrichment as Task 1.2 step 2
  scorecard: scoresResult.rows[0] || null,
  timeline,
});
```

- [ ] **Step 6: Verify with curl.**

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:5000/api/admin/applications/<some-user-id>" | jq '{has_scorecard: (.scorecard != null), timeline_count: (.timeline | length), referral: .application.referral_source}'
```

Expected: scorecard `null`, timeline `[]` for an applicant with no activity, all keys present.

---

### Task 1.4 — Add interview / scorecard / reject / restore / note / reminder endpoints

**Files:**
- Modify: `server/routes/admin/applications.js`

These are siblings of the existing handlers in this router. Add them all in this task.

- [ ] **Step 1: Helper to write activity events.** At the top of the file, near the imports:

```js
async function writeActivity(client, { user_id, actor_id, event_type, metadata }) {
  await client.query(
    `INSERT INTO application_activity (user_id, actor_id, event_type, metadata)
     VALUES ($1, $2, $3, $4)`,
    [user_id, actor_id, event_type, JSON.stringify(metadata || {})]
  );
}
module.exports.writeActivity = writeActivity;
```

(Use `pool` instead of `client` for the non-transactional callers; pass through a transaction client when called inside one.)

- [ ] **Step 2: `PUT /applications/:userId/interview` — schedule.** Body: `{ interview_at, notes?, send_email? }`.

```js
router.put('/applications/:userId/interview', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId);
  const { interview_at, notes, send_email } = req.body;
  if (!interview_at) throw new ValidationError('interview_at required');
  const dt = new Date(interview_at);
  if (isNaN(dt.getTime())) throw new ValidationError('interview_at invalid');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const prev = await client.query(
      'SELECT interview_at FROM applications WHERE user_id = $1', [userId]
    );
    if (prev.rowCount === 0) throw new NotFoundError('application');
    const wasScheduled = prev.rows[0].interview_at != null;

    await client.query(
      'UPDATE applications SET interview_at = $1, updated_at = NOW() WHERE user_id = $2',
      [dt.toISOString(), userId]
    );

    await writeActivity(client, {
      user_id: userId,
      actor_id: req.user.id,
      event_type: wasScheduled ? 'interview_rescheduled' : 'interview_scheduled',
      metadata: { interview_at: dt.toISOString(), notes: notes || null },
    });

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  if (send_email) {
    // Fire-and-forget; do not block response on email failures.
    const { sendInterviewConfirmationEmail } = require('../../utils/emailTemplates');
    sendInterviewConfirmationEmail({ userId, interview_at: dt }).catch(err =>
      console.error('Interview email failed:', err)
    );
  }

  res.json({ ok: true, interview_at: dt.toISOString() });
}));
```

- [ ] **Step 3: `DELETE /applications/:userId/interview` — clear scheduled time.**

```js
router.delete('/applications/:userId/interview', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE applications SET interview_at = NULL, updated_at = NOW() WHERE user_id = $1',
      [userId]
    );
    await writeActivity(client, {
      user_id: userId, actor_id: req.user.id,
      event_type: 'interview_rescheduled',
      metadata: { cleared: true },
    });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  res.json({ ok: true });
}));
```

- [ ] **Step 4: `PUT /applications/:userId/scorecard` — upsert scorecard.** Body: any subset of the 5 dimensions.

```js
router.put('/applications/:userId/scorecard', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId);
  const DIMS = ['personality', 'customer_service', 'problem_solving', 'speed_mindset', 'hire_instinct'];
  const updates = {};
  for (const k of DIMS) {
    if (k in req.body) {
      const v = req.body[k];
      if (v !== null && (!Number.isInteger(v) || v < 1 || v > 5)) {
        throw new ValidationError(`${k} must be 1-5 or null`);
      }
      updates[k] = v;
    }
  }
  if (Object.keys(updates).length === 0) throw new ValidationError('no scorecard fields');

  // Upsert.
  const cols = Object.keys(updates);
  const setClause = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
  const insertCols = ['user_id', 'scored_by', ...cols].join(', ');
  const insertVals = ['$1', '$2', ...cols.map((_, i) => `$${i + 3}`)].join(', ');
  const params = [userId, req.user.id, ...cols.map(c => updates[c])];

  await pool.query(`
    INSERT INTO interview_scores (${insertCols}) VALUES (${insertVals})
    ON CONFLICT (user_id) DO UPDATE SET ${setClause}, updated_at = NOW()
  `, params);

  // (Activity event optional here — gets noisy if every dot click logs.
  // Skip for now; can revisit during Phase 2 if useful.)

  const fresh = await pool.query('SELECT * FROM interview_scores WHERE user_id = $1', [userId]);
  res.json({ scorecard: fresh.rows[0] });
}));
```

- [ ] **Step 5: `POST /applications/:userId/reject`.**

```js
router.post('/applications/:userId/reject', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId);
  const { rejection_reason } = req.body;
  if (!rejection_reason || rejection_reason.trim().length === 0) {
    throw new ValidationError('rejection_reason required');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prev = await client.query(
      'SELECT onboarding_status FROM users WHERE id = $1', [userId]
    );
    if (prev.rowCount === 0) throw new NotFoundError('user');
    const fromStatus = prev.rows[0].onboarding_status;

    await client.query(
      `UPDATE users SET onboarding_status = 'rejected', updated_at = NOW() WHERE id = $1`,
      [userId]
    );
    await client.query(
      'UPDATE applications SET rejection_reason = $1, updated_at = NOW() WHERE user_id = $2',
      [rejection_reason.trim(), userId]
    );
    await writeActivity(client, {
      user_id: userId, actor_id: req.user.id,
      event_type: 'status_changed',
      metadata: { from: fromStatus, to: 'rejected', reason: rejection_reason.trim() },
    });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  res.json({ ok: true });
}));
```

- [ ] **Step 6: `POST /applications/:userId/restore`.**

```js
router.post('/applications/:userId/restore', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prev = await client.query(
      'SELECT onboarding_status FROM users WHERE id = $1', [userId]
    );
    if (prev.rowCount === 0) throw new NotFoundError('user');
    if (prev.rows[0].onboarding_status !== 'rejected') {
      throw new ValidationError('only rejected users can be restored');
    }
    await client.query(
      `UPDATE users SET onboarding_status = 'applied', updated_at = NOW() WHERE id = $1`, [userId]
    );
    await writeActivity(client, {
      user_id: userId, actor_id: req.user.id,
      event_type: 'status_changed',
      metadata: { from: 'rejected', to: 'applied' },
    });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  res.json({ ok: true });
}));
```

- [ ] **Step 7: `POST /applications/:userId/notes` — admin note.**

```js
router.post('/applications/:userId/notes', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId);
  const { note } = req.body;
  if (!note || note.trim().length === 0) throw new ValidationError('note required');

  // Write to BOTH interview_notes (legacy reads still work) AND application_activity.
  await pool.query(
    'INSERT INTO interview_notes (user_id, admin_id, note) VALUES ($1, $2, $3)',
    [userId, req.user.id, note.trim()]
  );
  await writeActivity(pool, {
    user_id: userId, actor_id: req.user.id,
    event_type: 'note_added',
    metadata: { note: note.trim() },
  });

  res.json({ ok: true });
}));
```

- [ ] **Step 8: `POST /applications/:userId/reminder` — paperwork-reminder email.**

```js
router.post('/applications/:userId/reminder', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId);
  const { sendPaperworkReminderEmail } = require('../../utils/emailTemplates');
  await sendPaperworkReminderEmail({ userId });
  await writeActivity(pool, {
    user_id: userId, actor_id: req.user.id,
    event_type: 'reminder_sent',
    metadata: { kind: 'paperwork' },
  });
  res.json({ ok: true });
}));
```

- [ ] **Step 9: `POST /applications/:userId/move` — generic stage transition.** Used by "Invite to interview" and "Hire" actions.

```js
router.post('/applications/:userId/move', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId);
  const { to } = req.body;
  // Allowed transitions:
  // applied -> interviewing, interviewing -> in_progress (== onboarding)
  const allowed = { applied: ['interviewing'], interviewing: ['in_progress'] };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prev = await client.query(
      'SELECT onboarding_status FROM users WHERE id = $1', [userId]
    );
    if (prev.rowCount === 0) throw new NotFoundError('user');
    const from = prev.rows[0].onboarding_status;
    if (!allowed[from] || !allowed[from].includes(to)) {
      throw new ValidationError(`transition ${from} -> ${to} not allowed`);
    }
    await client.query(
      `UPDATE users SET onboarding_status = $1, updated_at = NOW() WHERE id = $2`,
      [to, userId]
    );
    await writeActivity(client, {
      user_id: userId, actor_id: req.user.id,
      event_type: 'status_changed',
      metadata: { from, to },
    });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  res.json({ ok: true });
}));
```

- [ ] **Step 10: Verify each endpoint with curl.** Pick a test user (rejected → restore, applied → schedule, etc.). Confirm `application_activity` rows appear after each call:

```bash
psql "$DATABASE_URL" -c "SELECT event_type, metadata, created_at FROM application_activity WHERE user_id=<id> ORDER BY created_at DESC LIMIT 5;"
```

Expected: events match the curl calls you made.

---

### Task 1.5 — Hiring summary + search

**Files:**
- Create: `server/routes/admin/hiring.js`
- Modify: `server/routes/admin/index.js`

- [ ] **Step 1: Create `server/routes/admin/hiring.js`.**

```js
const express = require('express');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');

const router = express.Router();

// KPI strip — three stats.
router.get('/hiring/summary', auth, adminOnly, asyncHandler(async (req, res) => {
  const [newApps, needSchedule, stalled, inPipeline] = await Promise.all([
    pool.query(`
      SELECT COUNT(*) FROM applications a
      INNER JOIN users u ON u.id = a.user_id
      WHERE a.created_at > NOW() - INTERVAL '7 days'
        AND u.onboarding_status != 'rejected'
    `),
    pool.query(`
      SELECT COUNT(*) FROM applications a
      INNER JOIN users u ON u.id = a.user_id
      WHERE u.onboarding_status = 'interviewing'
        AND a.interview_at IS NULL
    `),
    pool.query(`
      SELECT COUNT(*) FROM users u
      INNER JOIN applications a ON a.user_id = u.id
      WHERE
        (u.onboarding_status = 'applied' AND a.created_at < NOW() - INTERVAL '14 days')
        OR (u.onboarding_status = 'interviewing' AND a.interview_at IS NULL
            AND a.updated_at < NOW() - INTERVAL '3 days')
        OR (u.onboarding_status = 'in_progress' AND u.updated_at < NOW() - INTERVAL '14 days')
    `),
    pool.query(`
      SELECT COUNT(*) FROM users u
      INNER JOIN applications a ON a.user_id = u.id
      WHERE u.onboarding_status IN ('applied', 'interviewing', 'in_progress')
    `),
  ]);
  res.json({
    new_apps_7d:      parseInt(newApps.rows[0].count),
    need_to_schedule: parseInt(needSchedule.rows[0].count),
    stalled:          parseInt(stalled.rows[0].count),
    in_pipeline:      parseInt(inPipeline.rows[0].count),
  });
}));

// Cross-state applicant search. Hits Applied/Interview/Onboarding/Active/Rejected
// (all via users + applications join) AND Unfinished (users with no application).
router.get('/hiring/search', auth, adminOnly, asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const term = '%' + q.toLowerCase() + '%';

  const result = await pool.query(`
    SELECT
      u.id,
      u.email,
      u.onboarding_status,
      u.created_at AS user_created_at,
      a.full_name,
      a.created_at AS applied_at,
      CASE WHEN a.id IS NULL THEN 'unfinished' ELSE u.onboarding_status END AS state
    FROM users u
    LEFT JOIN applications a ON a.user_id = u.id
    WHERE u.role IN ('staff', 'manager')
      AND (
        LOWER(u.email)        LIKE $1 OR
        LOWER(a.full_name)    LIKE $1
      )
    ORDER BY (a.created_at IS NOT NULL) DESC, COALESCE(a.created_at, u.created_at) DESC
    LIMIT 20
  `, [term]);

  res.json({ results: result.rows });
}));

module.exports = router;
```

- [ ] **Step 2: Mount in `server/routes/admin/index.js`.** Add a single line:

```js
router.use('/', require('./hiring'));
```

(Order doesn't matter — paths don't overlap with existing routers.)

- [ ] **Step 3: Verify summary.**

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:5000/api/admin/hiring/summary" | jq
```

Expected: `{ "new_apps_7d": ..., "need_to_schedule": ..., "stalled": ..., "in_pipeline": ... }`.

- [ ] **Step 4: Verify search.**

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:5000/api/admin/hiring/search?q=sa" | jq '.results[] | {email, state}'
```

Expected: a list of matches with state chip values.

---

### Task 1.6 — Application form: referral question

**Files:**
- Modify: `server/routes/application.js`
- Modify: `client/src/pages/Application.js`

- [ ] **Step 1: Server side.** In `server/routes/application.js`, find the `INSERT INTO applications` statement. Add `referral_source` to the column list and `$N` placeholder, sourcing the value from `req.body.referral_source` (treat empty string as `null`).

Pattern:

```js
const referralSource = (req.body.referral_source || '').trim() || null;
// ...
await pool.query(
  `INSERT INTO applications (
     user_id, full_name, /* ... existing columns ... */, referral_source
   ) VALUES ($1, $2, /* ..., */ $N)`,
  [userId, full_name, /* ..., */ referralSource]
);
```

Adjust the `$N` index to whatever the next placeholder number is.

- [ ] **Step 2: Client side — add the field to the form.** In `client/src/pages/Application.js`, find the section where "How did you hear about us?" or referral-related fields live (search for `hear` or near `customer_service_approach`). If no such question exists yet, add it after the contact info step.

Add to the component state (around line 112-120):

```js
const [referralSource, setReferralSource] = useState('');
```

Add an input element near other freeform fields:

```jsx
<div className="form-group">
  <label className="form-label">Who referred you? <span className="form-optional">(optional)</span></label>
  <input
    className="form-input"
    type="text"
    value={referralSource}
    onChange={e => setReferralSource(e.target.value)}
    placeholder="Name of the person who told you about us"
    maxLength={200}
  />
</div>
```

Append to the FormData submission (around the existing `data.append('positions_interested', ...)` block):

```js
data.append('referral_source', referralSource);
```

- [ ] **Step 3: Verify in browser.** `npm run dev`, open `http://localhost:3000/apply`, fill out a fake application, submit. Then:

```bash
psql "$DATABASE_URL" -c "SELECT id, full_name, referral_source FROM applications ORDER BY id DESC LIMIT 1;"
```

Expected: the new row has `referral_source` populated with whatever you typed.

---

### Task 1.7 — Email templates

**Files:**
- Modify: `server/utils/emailTemplates.js`

- [ ] **Step 1: Add `sendInterviewConfirmationEmail`.** Mirror the shape of an existing template (search for `module.exports` to find existing exports). Pull the applicant's email + name from `users` + `applications`:

```js
async function sendInterviewConfirmationEmail({ userId, interview_at }) {
  const { pool } = require('../db');
  const r = await pool.query(`
    SELECT u.email, a.full_name
    FROM users u
    INNER JOIN applications a ON a.user_id = u.id
    WHERE u.id = $1
  `, [userId]);
  if (r.rowCount === 0) return;
  const { email, full_name } = r.rows[0];

  const dt = new Date(interview_at);
  const dateStr = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const timeStr = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  await sendEmail({
    to: email,
    subject: `Interview confirmed — ${dateStr}`,
    html: `
      <p>Hi ${full_name?.split(' ')[0] || 'there'},</p>
      <p>Your interview with Dr. Bartender is confirmed for <strong>${dateStr} at ${timeStr}</strong>.</p>
      <p>If anything changes on your end, just reply to this email.</p>
      <p>— Dr. Bartender Hiring</p>
    `,
  });
}
module.exports.sendInterviewConfirmationEmail = sendInterviewConfirmationEmail;
```

(`sendEmail` is the existing wrapper at the top of this file. Use the same pattern as other exports.)

- [ ] **Step 2: Add `sendPaperworkReminderEmail`.**

```js
async function sendPaperworkReminderEmail({ userId }) {
  const { pool } = require('../db');
  const r = await pool.query(`
    SELECT u.email, cp.preferred_name
    FROM users u
    LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
    WHERE u.id = $1
  `, [userId]);
  if (r.rowCount === 0) return;
  const { email, preferred_name } = r.rows[0];
  const { STAFF_URL } = require('./urls');

  await sendEmail({
    to: email,
    subject: 'Quick nudge — finish your onboarding',
    html: `
      <p>Hi ${preferred_name || 'there'},</p>
      <p>Just a friendly nudge to finish your Dr. Bartender onboarding paperwork. The portal saves your progress so you can pick up where you left off:</p>
      <p><a href="${STAFF_URL()}">${STAFF_URL()}</a></p>
      <p>Reply if you hit a snag — happy to help.</p>
      <p>— Dr. Bartender</p>
    `,
  });
}
module.exports.sendPaperworkReminderEmail = sendPaperworkReminderEmail;
```

- [ ] **Step 3: Verify by triggering the reminder endpoint.** Test against a dev applicant:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" "http://localhost:5000/api/admin/applications/<user-id>/reminder"
```

Expected: response `{ ok: true }`. Check Resend dashboard or server logs for the send confirmation. Verify an `application_activity` row of type `reminder_sent` was written.

---

### Task 1.8 — Phase 1 commit

- [ ] **Step 1: Pre-commit smoke test.** With `npm run dev` running, hit each new endpoint at least once via curl. Confirm activity events log correctly.

- [ ] **Step 2: Commit.**

```bash
git add server/db/schema.sql server/routes/admin/applications.js server/routes/admin/hiring.js server/routes/admin/index.js server/routes/application.js server/utils/emailTemplates.js client/src/pages/Application.js
git commit -m "feat(hiring): schema + endpoints + referral question for pipeline redesign"
```

---

## Phase 2 — Application Detail Rewrite

### Task 2.1 — Folder skeleton + helpers

**Files:**
- Create: `client/src/pages/admin/applicationDetail/AdminApplicationDetail.js`
- Create: `client/src/pages/admin/applicationDetail/helpers.js`

- [ ] **Step 1: Create `helpers.js`.**

```js
// Pipeline flow used across the detail page.
export const AD_FLOW = [
  { key: 'applied',        label: 'Applied',     verb: 'Application received' },
  { key: 'interviewing',   label: 'Interview',   verb: 'Interviewing' },
  { key: 'in_progress',    label: 'Onboarding',  verb: 'Paperwork in flight' },
  { key: 'active',         label: 'Active staff',verb: 'On the roster' },
];

// Status backed by users.onboarding_status. Treat 'hired' (legacy) as 'in_progress'
// for stage purposes; new code never writes 'hired'.
export const stageOf = (status) => status === 'hired' ? 'in_progress' : status;

export const initialsOf = (name) =>
  (name || '?').split(' ').filter(Boolean).map(n => n[0]).join('').toUpperCase().slice(0, 2);

export const relDay = (dateStr) => {
  if (!dateStr) return '—';
  const d = Math.round((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.round(d / 7)}w ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
};

export const dayDiff = (dateStr) => {
  if (!dateStr) return null;
  return Math.round((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
};

// 5-dim scorecard schema.
export const SCORECARD_DIMS = [
  { key: 'personality',      label: 'Personality / charisma' },
  { key: 'customer_service', label: 'Customer service instinct' },
  { key: 'problem_solving',  label: 'Problem-solving' },
  { key: 'speed_mindset',    label: 'Speed mindset' },
  { key: 'hire_instinct',    label: 'Hire instinct' },
];

// 5 onboarding paperwork items (mirrored on the OnboardingCard).
export const ONBOARDING_ITEMS = [
  { key: 'agreement_completed',           label: 'Contractor agreement' },
  { key: 'contractor_profile_completed',  label: 'Profile + W-9' },
  { key: 'payday_protocols_completed',    label: 'Payday protocols' },
  { key: 'onboarding_completed',          label: 'Final paperwork done' },
];

// Status-chip kind per stage.
export const chipKindFor = (status, onboardingProgress) => {
  if (status === 'rejected') return 'danger';
  if (status === 'in_progress' && onboardingProgress >= 1) return 'ok';
  if (status === 'applied') return 'info';
  if (status === 'interviewing') return 'info';
  if (status === 'in_progress') return 'warn';
  return 'neutral';
};
```

- [ ] **Step 2: Create the page shell `AdminApplicationDetail.js`.**

```jsx
import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import Icon from '../../../components/adminos/Icon';
import StatusChip from '../../../components/adminos/StatusChip';
import { initialsOf, relDay, AD_FLOW, stageOf, chipKindFor } from './helpers';
import PipelineStrip from './components/PipelineStrip';
import ScorecardCard from './components/ScorecardCard';
import TimelineCard from './components/TimelineCard';
import OnboardingCard from './components/OnboardingCard';
import ActionsCard from './components/ActionsCard';
import StatsCard from './components/StatsCard';
import FilesBlock from './components/FilesBlock';
import FlagsCard from './components/FlagsCard';
import ViabilityCard from './components/ViabilityCard';
import RejectModal from './components/RejectModal';
import SectionWords from './sections/SectionWords';
import SectionExperience from './sections/SectionExperience';
import SectionGear from './sections/SectionGear';
import SectionContact from './sections/SectionContact';

export default function AdminApplicationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing]   = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/admin/applications/${id}`);
      setData(r.data);
    } catch (e) {
      toast.error('Failed to load application.');
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="page" data-app="admin-os"><div className="loading"><div className="spinner"/>Loading…</div></div>;
  if (!data || !data.application) return <div className="page" data-app="admin-os"><div className="card-empty">Application not found.</div></div>;

  const a = data.application;
  const status = stageOf(a.onboarding_status);
  const isRejected = a.onboarding_status === 'rejected';
  const onboardingPct = a.onboarding_progress ?? 0;

  const handle = async (fn, successMsg) => {
    setActing(true);
    try {
      await fn();
      if (successMsg) toast.success(successMsg);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Action failed.');
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="page" data-app="admin-os" style={{ maxWidth: 1280 }}>
      <div className="hstack" style={{ marginBottom: 8 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/hiring')}>
          <Icon name="arrow_right" size={11} style={{ transform: 'rotate(180deg)' }} />
          Hiring pipeline
        </button>
      </div>

      {/* Identity bar */}
      <div className="card" style={{ padding: '1.5rem 1.75rem', marginBottom: 'var(--gap)' }}>
        <div className="hstack" style={{ gap: 18, alignItems: 'flex-start' }}>
          <div className="avatar" style={{ width: 64, height: 64, fontSize: 22, flexShrink: 0 }}>
            {initialsOf(a.full_name)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, marginBottom: 4 }}>
              Application · A{a.id}
            </div>
            <div className="hstack" style={{ gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 500, margin: 0, lineHeight: 1.1 }}>
                {a.full_name}
              </h1>
              <StatusChip kind={chipKindFor(a.onboarding_status, onboardingPct)}>
                {isRejected ? 'Rejected' : (AD_FLOW.find(s => s.key === status)?.label || status)}
              </StatusChip>
              {tryParseArray(a.positions_interested).map(p => <span key={p} className="tag">{p}</span>)}
              {a.referral_source && (
                <span className="tag" style={{ color: 'var(--accent)', borderColor: 'currentColor' }}>
                  Referral · {a.referral_source}
                </span>
              )}
              {a.has_bartending_experience && !a.basset_file_url && <StatusChip kind="warn">No BASSET</StatusChip>}
            </div>
            <div className="hstack" style={{ gap: 16, marginTop: 6, color: 'var(--ink-3)', fontSize: 13, flexWrap: 'wrap' }}>
              <span className="hstack"><Icon name="mail" size={12} />{a.email}</span>
              <span className="hstack"><Icon name="phone" size={12} /><span className="mono">{a.phone}</span></span>
              <span className="hstack"><Icon name="location" size={12} />{a.city}, {a.state}</span>
              <span className="hstack"><Icon name="calendar" size={12} />Applied {relDay(a.applied_at)}</span>
            </div>
          </div>
        </div>
        <PipelineStrip status={a.onboarding_status} rejectionReason={a.rejection_reason} />
      </div>

      {/* Two-column body */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 'var(--gap)' }}>
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          <ViabilityCard a={a} />
          {(status === 'interviewing' || status === 'in_progress' || isRejected) && (
            <ScorecardCard userId={a.id} initial={data.scorecard} onSaved={load} />
          )}
          <SectionWords a={a} />
          <SectionExperience a={a} />
          <SectionGear a={a} />
          <SectionContact a={a} />
          <TimelineCard
            userId={a.id}
            timeline={data.timeline}
            onPosted={load}
          />
        </div>
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          <ActionsCard
            a={a}
            acting={acting}
            onMove={(to) => handle(() => api.post(`/admin/applications/${a.id}/move`, { to }), 'Moved.')}
            onSchedule={() => navigate(`/admin/hiring?schedule=${a.id}`)}
            onReject={() => setRejectOpen(true)}
            onRestore={() => handle(() => api.post(`/admin/applications/${a.id}/restore`), 'Restored.')}
            onReminder={() => handle(() => api.post(`/admin/applications/${a.id}/reminder`), 'Reminder sent.')}
          />
          <StatsCard a={a} scorecard={data.scorecard} />
          {status === 'in_progress' && <OnboardingCard a={a} onReminder={() => handle(() => api.post(`/admin/applications/${a.id}/reminder`), 'Reminder sent.')} />}
          <FilesBlock a={a} />
          <FlagsCard a={a} />
        </div>
      </div>

      <RejectModal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        onConfirm={async (reason) => {
          await handle(() => api.post(`/admin/applications/${a.id}/reject`, { rejection_reason: reason }), 'Rejected.');
          setRejectOpen(false);
        }}
      />
    </div>
  );
}

function tryParseArray(maybeJson) {
  try { return JSON.parse(maybeJson || '[]'); } catch { return []; }
}
```

- [ ] **Step 3: Run `npm run build` from `client/` to surface any import-path mistakes early.**

```bash
cd client && npm run build
```

Expected: build fails with "Cannot find module './components/PipelineStrip'" — that's correct because we haven't created the imports yet. As long as the failure is about the missing files (not syntax / unresolved variables), proceed to Task 2.2.

---

### Task 2.2 — PipelineStrip + ScorecardCard

**Files:**
- Create: `client/src/pages/admin/applicationDetail/components/PipelineStrip.js`
- Create: `client/src/pages/admin/applicationDetail/components/ScorecardCard.js`

- [ ] **Step 1: Create `PipelineStrip.js`.**

```jsx
import React from 'react';
import Icon from '../../../../components/adminos/Icon';
import { AD_FLOW, stageOf } from '../helpers';

export default function PipelineStrip({ status, rejectionReason }) {
  const isRejected = status === 'rejected';
  const stage = stageOf(status);
  const stageIdx = AD_FLOW.findIndex(s => s.key === stage);

  return (
    <div style={{ marginTop: 22 }}>
      <div className="hstack" style={{ gap: 0, alignItems: 'stretch' }}>
        {AD_FLOW.map((s, i) => {
          const reached = !isRejected && i <= stageIdx;
          const current = !isRejected && i === stageIdx;
          const next = i === stageIdx + 1 && !isRejected;
          return (
            <div key={s.key} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{
                flex: 1, padding: '11px 12px', borderRadius: 4, fontSize: 11.5,
                background: current ? 'var(--ink-1)' : 'var(--bg-2)',
                color: current ? 'var(--bg-0)' : reached ? 'var(--ink-1)' : 'var(--ink-3)',
                border: '1px solid ' + (current ? 'var(--ink-1)' : 'var(--line-1)'),
                fontWeight: current ? 600 : 400,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    width: 16, height: 16, borderRadius: '50%', display: 'inline-grid', placeItems: 'center',
                    background: current ? 'var(--bg-0)' : reached ? 'var(--ink-1)' : 'transparent',
                    color: current ? 'var(--ink-1)' : reached ? 'var(--bg-0)' : 'var(--ink-3)',
                    border: '1px solid ' + (reached || current ? 'var(--ink-1)' : 'var(--line-2)'),
                    fontSize: 9, fontWeight: 700,
                  }}>{reached ? '✓' : i + 1}</span>
                  <span>{s.label}</span>
                </span>
                {current && <span className="tiny" style={{ opacity: 0.7 }}>{s.verb}</span>}
                {next && <span className="tiny muted">next</span>}
              </div>
              {i < AD_FLOW.length - 1 && (
                <Icon name="arrow_right" size={11} style={{ color: 'var(--ink-4)', flexShrink: 0 }} />
              )}
            </div>
          );
        })}
      </div>
      {isRejected && (
        <div className="hstack" style={{ marginTop: 8, padding: '8px 12px', background: 'hsl(var(--danger-h) var(--danger-s) 50% / 0.08)', border: '1px solid hsl(var(--danger-h) var(--danger-s) 50% / 0.3)', borderRadius: 4 }}>
          <Icon name="x" size={11} />
          <span className="tiny" style={{ flex: 1 }}>
            Archived from pipeline · {rejectionReason || 'No reason on file.'}
          </span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `ScorecardCard.js`.**

```jsx
import React, { useState, useMemo, useEffect } from 'react';
import api from '../../../../utils/api';
import { useToast } from '../../../../context/ToastContext';
import { SCORECARD_DIMS } from '../helpers';

export default function ScorecardCard({ userId, initial, onSaved }) {
  const toast = useToast();
  const [scores, setScores] = useState(() => {
    const out = {};
    SCORECARD_DIMS.forEach(d => { out[d.key] = initial?.[d.key] ?? null; });
    return out;
  });

  // If parent re-fetches and passes new initial, sync.
  useEffect(() => {
    const out = {};
    SCORECARD_DIMS.forEach(d => { out[d.key] = initial?.[d.key] ?? null; });
    setScores(out);
  }, [initial]);

  const total = useMemo(() =>
    SCORECARD_DIMS.reduce((s, d) => s + (scores[d.key] || 0), 0),
    [scores]);
  const avg = useMemo(() => {
    const filled = SCORECARD_DIMS.filter(d => scores[d.key] != null);
    return filled.length ? (filled.reduce((s, d) => s + scores[d.key], 0) / filled.length) : 0;
  }, [scores]);

  const setDim = async (key, n) => {
    const newVal = scores[key] === n ? null : n;
    setScores(s => ({ ...s, [key]: newVal }));
    try {
      await api.put(`/admin/applications/${userId}/scorecard`, { [key]: newVal });
      onSaved && onSaved();
    } catch {
      toast.error('Could not save score.');
      setScores(s => ({ ...s, [key]: scores[key] })); // revert
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Interview scorecard</h3>
        <span className="hstack tiny" style={{ gap: 8 }}>
          <span className="muted">Avg {avg ? avg.toFixed(1) : '—'}</span>
          <strong style={{ fontSize: 16, color: 'var(--ink-1)' }}>Total: {total} / 25</strong>
        </span>
      </div>
      <div className="card-body vstack" style={{ gap: 14 }}>
        {SCORECARD_DIMS.map(d => (
          <div key={d.key} className="hstack" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200, fontSize: 13 }}>{d.label}</div>
            <div className="hstack" style={{ gap: 6 }}>
              {[1, 2, 3, 4, 5].map(n => {
                const on = scores[d.key] != null && n <= scores[d.key];
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setDim(d.key, n)}
                    title={`${n}/5`}
                    aria-label={`${d.label} ${n} of 5`}
                    style={{
                      width: 36, height: 36, borderRadius: '50%',
                      border: '1px solid ' + (on ? 'var(--accent)' : 'var(--line-2)'),
                      background: on ? 'var(--accent)' : 'transparent',
                      cursor: 'pointer', padding: 0,
                      touchAction: 'manipulation',
                    }}
                  />
                );
              })}
            </div>
            <span className="tiny muted" style={{ width: 36, textAlign: 'right' }}>
              {scores[d.key] != null ? scores[d.key] + '/5' : '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Build check.** `cd client && npm run build`. Expected: still failing on the next missing file (Timeline, etc.), but not on these two.

---

### Task 2.3 — TimelineCard, OnboardingCard, ActionsCard, StatsCard

**Files:**
- Create: `client/src/pages/admin/applicationDetail/components/TimelineCard.js`
- Create: `client/src/pages/admin/applicationDetail/components/OnboardingCard.js`
- Create: `client/src/pages/admin/applicationDetail/components/ActionsCard.js`
- Create: `client/src/pages/admin/applicationDetail/components/StatsCard.js`

- [ ] **Step 1: `TimelineCard.js`.**

```jsx
import React, { useState } from 'react';
import api from '../../../../utils/api';
import { useToast } from '../../../../context/ToastContext';
import { relDay } from '../helpers';

const EVENT_LABELS = {
  application_submitted:     { title: 'Application submitted',  icon: 'mail' },
  status_changed:            { title: 'Status changed',         icon: 'arrow_right' },
  interview_scheduled:       { title: 'Interview scheduled',    icon: 'calendar' },
  interview_rescheduled:     { title: 'Interview rescheduled',  icon: 'calendar' },
  reminder_sent:             { title: 'Reminder sent',          icon: 'send' },
  note_added:                { title: 'Note added',             icon: 'pen' },
  onboarding_step_completed: { title: 'Onboarding step complete', icon: 'check' },
};

function describe(event) {
  const meta = event.metadata || {};
  if (event.event_type === 'status_changed' && meta.from && meta.to) {
    return `${meta.from} → ${meta.to}${meta.reason ? ` · ${meta.reason}` : ''}`;
  }
  if (event.event_type === 'interview_scheduled' && meta.interview_at) {
    const d = new Date(meta.interview_at);
    return `${d.toLocaleDateString()} · ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return null;
}

export default function TimelineCard({ userId, timeline, onPosted }) {
  const toast = useToast();
  const [draft, setDraft]     = useState('');
  const [posting, setPosting] = useState(false);

  const submit = async () => {
    const note = draft.trim();
    if (!note) return;
    setPosting(true);
    try {
      await api.post(`/admin/applications/${userId}/notes`, { note });
      setDraft('');
      onPosted && onPosted();
    } catch {
      toast.error('Could not post note.');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Notes &amp; activity</h3>
        <span className="k">{timeline?.length || 0}</span>
      </div>
      <div className="card-body">
        <div className="hstack" style={{ gap: 8, marginBottom: 14 }}>
          <textarea
            className="input"
            placeholder="Add an interview note…"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            style={{ flex: 1, minHeight: 56, padding: 10, resize: 'vertical' }}
          />
          <button className="btn btn-primary btn-sm" disabled={!draft.trim() || posting} onClick={submit} style={{ alignSelf: 'flex-end' }}>
            {posting ? 'Posting…' : 'Post'}
          </button>
        </div>
        <div className="vstack" style={{ gap: 0 }}>
          {(!timeline || timeline.length === 0) && (
            <div className="tiny muted" style={{ padding: '16px 0', textAlign: 'center' }}>No activity yet.</div>
          )}
          {timeline?.map((e, i) => {
            const cfg = EVENT_LABELS[e.event_type] || { title: e.event_type, icon: 'mail' };
            const isNote = e.event_type === 'note_added';
            return (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '14px 1fr 110px', gap: 14, padding: '10px 0', borderBottom: i < timeline.length - 1 ? '1px solid var(--line-1)' : 0 }}>
                <div style={{ position: 'relative', paddingTop: 6 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 999, background: isNote ? 'var(--accent)' : 'var(--ink-3)' }} />
                  {i < timeline.length - 1 && <div style={{ position: 'absolute', left: 3, top: 14, bottom: -10, width: 1, background: 'var(--line-1)' }} />}
                </div>
                <div>
                  {isNote ? (
                    <>
                      <div className="hstack tiny" style={{ gap: 6, marginBottom: 4 }}>
                        <strong>{e.actor_name || 'Admin'}</strong>
                        <span className="muted">noted</span>
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5 }}>{e.metadata?.note}</div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 13 }}><strong>{cfg.title}</strong></div>
                      {describe(e) && <div className="tiny muted" style={{ marginTop: 2 }}>{describe(e)}</div>}
                    </>
                  )}
                </div>
                <div className="tiny muted" style={{ textAlign: 'right' }}>{relDay(e.created_at)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `OnboardingCard.js`.**

```jsx
import React from 'react';
import Icon from '../../../../components/adminos/Icon';
import { ONBOARDING_ITEMS } from '../helpers';

export default function OnboardingCard({ a, onReminder }) {
  const pct = a.onboarding_progress ?? 0;
  return (
    <div className="card">
      <div className="card-head">
        <h3>Onboarding paperwork</h3>
        <span className="hstack tiny" style={{ gap: 8 }}>
          <strong style={{ color: pct >= 1 ? 'hsl(var(--ok-h) var(--ok-s) 50%)' : 'var(--ink-1)' }}>
            {Math.round(pct * 100)}%
          </strong>
        </span>
      </div>
      <div className="card-body">
        <div style={{ height: 6, background: 'var(--bg-2)', borderRadius: 99, overflow: 'hidden', marginBottom: 14 }}>
          <div style={{ height: '100%', width: (pct * 100) + '%', background: pct >= 1 ? 'hsl(var(--ok-h) var(--ok-s) 50%)' : 'var(--accent)', borderRadius: 99 }} />
        </div>
        <div className="vstack" style={{ gap: 6 }}>
          {ONBOARDING_ITEMS.map(it => {
            const isDone = !!a[it.key];
            return (
              <div key={it.key} className="hstack" style={{ gap: 10, padding: '6px 10px', borderRadius: 3 }}>
                <span style={{
                  width: 16, height: 16, borderRadius: '50%', display: 'grid', placeItems: 'center',
                  background: isDone ? 'hsl(var(--ok-h) var(--ok-s) 50%)' : 'transparent',
                  border: '1px solid ' + (isDone ? 'hsl(var(--ok-h) var(--ok-s) 50%)' : 'var(--line-2)'),
                  color: 'var(--bg-0)', fontSize: 9, fontWeight: 700, flexShrink: 0,
                }}>{isDone ? '✓' : ''}</span>
                <span style={{ flex: 1, fontSize: 13, color: isDone ? 'var(--ink-3)' : 'var(--ink-1)', textDecoration: isDone ? 'line-through' : 'none' }}>
                  {it.label}
                </span>
              </div>
            );
          })}
        </div>
        {a.onboarding_blocker && pct < 1 && (
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 12, width: '100%', justifyContent: 'center' }} onClick={onReminder}>
            <Icon name="mail" size={11} />Send reminder for {a.onboarding_blocker}
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `ActionsCard.js`.**

```jsx
import React from 'react';
import Icon from '../../../../components/adminos/Icon';
import { stageOf } from '../helpers';

export default function ActionsCard({ a, acting, onMove, onSchedule, onReject, onRestore, onReminder }) {
  const status = stageOf(a.onboarding_status);
  const isRejected = a.onboarding_status === 'rejected';
  const hasInterview = !!a.interview_at;

  let primary = null;
  if (isRejected) {
    primary = { label: 'Restore to Applied', icon: 'check', onClick: onRestore };
  } else if (status === 'applied') {
    primary = { label: 'Invite to interview', icon: 'arrow_right', onClick: () => onMove('interviewing') };
  } else if (status === 'interviewing' && !hasInterview) {
    primary = { label: 'Schedule interview', icon: 'calendar', onClick: onSchedule };
  } else if (status === 'interviewing' && hasInterview) {
    primary = { label: 'Hire', icon: 'check', onClick: () => onMove('in_progress') };
  }
  // Onboarding stage: no primary CTA — informational.

  return (
    <div className="card">
      <div className="card-head"><h3>Actions</h3></div>
      <div className="card-body vstack" style={{ gap: 8 }}>
        {primary && (
          <button className="btn btn-primary" disabled={acting} onClick={primary.onClick} style={{ justifyContent: 'center' }}>
            <Icon name={primary.icon} size={12} />{primary.label}
          </button>
        )}
        {!isRejected && status === 'interviewing' && hasInterview && (
          <button className="btn btn-secondary" disabled={acting} onClick={onSchedule} style={{ justifyContent: 'flex-start' }}>
            <Icon name="calendar" size={12} />Reschedule
          </button>
        )}
        {status === 'in_progress' && (
          <button className="btn btn-secondary" disabled={acting} onClick={onReminder} style={{ justifyContent: 'flex-start' }}>
            <Icon name="mail" size={12} />Send paperwork reminder
          </button>
        )}
        <button className="btn btn-secondary" disabled={acting} onClick={() => window.location.href = `mailto:${a.email}`} style={{ justifyContent: 'flex-start' }}>
          <Icon name="mail" size={12} />Email applicant
        </button>
        {!isRejected && status !== 'in_progress' && (
          <button className="btn btn-ghost" disabled={acting} onClick={onReject} style={{ justifyContent: 'flex-start', color: 'hsl(var(--danger-h) var(--danger-s) 60%)' }}>
            <Icon name="x" size={12} />Reject &amp; archive
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: `StatsCard.js`.**

```jsx
import React from 'react';
import { fmtDate } from '../../../../components/adminos/format';
import { relDay, dayDiff, SCORECARD_DIMS } from '../helpers';

export default function StatsCard({ a, scorecard }) {
  const days = dayDiff(a.applied_at);
  const total = scorecard
    ? SCORECARD_DIMS.reduce((s, d) => s + (scorecard[d.key] || 0), 0)
    : 0;
  return (
    <div className="card">
      <div className="card-head"><h3>Pipeline stats</h3></div>
      <div className="card-body">
        <dl className="dl">
          <dt>Applied</dt><dd>{relDay(a.applied_at)} <span className="muted">· {fmtDate(a.applied_at)}</span></dd>
          <dt>Days in pipeline</dt><dd className="num">{days != null ? days : '—'}</dd>
          {a.referral_source && (<><dt>Referral</dt><dd>{a.referral_source}</dd></>)}
          {a.interview_at && (
            <><dt>Interview</dt>
              <dd>{new Date(a.interview_at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</dd>
            </>
          )}
          {scorecard && total > 0 && (
            <><dt>Score</dt><dd className="num">{total} / 25</dd></>
          )}
        </dl>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Build check.** `cd client && npm run build`. Expected: still failing, but on the remaining files (FilesBlock, FlagsCard, ViabilityCard, RejectModal, sections).

---

### Task 2.4 — FilesBlock, FlagsCard, ViabilityCard, RejectModal

**Files:**
- Create: `client/src/pages/admin/applicationDetail/components/FilesBlock.js`
- Create: `client/src/pages/admin/applicationDetail/components/FlagsCard.js`
- Create: `client/src/pages/admin/applicationDetail/components/ViabilityCard.js`
- Create: `client/src/pages/admin/applicationDetail/components/RejectModal.js`

- [ ] **Step 1: `FilesBlock.js`.**

```jsx
import React from 'react';
import Icon from '../../../../components/adminos/Icon';

const EXT = (name) => name?.split('.').pop()?.toLowerCase() || 'file';

export default function FilesBlock({ a }) {
  const files = [
    a.resume_file_url   && { label: 'Resume',   url: a.resume_file_url,   name: a.resume_filename || 'resume.pdf' },
    a.basset_file_url   && { label: 'BASSET',   url: a.basset_file_url,   name: a.basset_filename || 'basset.pdf' },
    a.headshot_file_url && { label: 'Headshot', url: a.headshot_file_url, name: a.headshot_filename || 'headshot.jpg' },
  ].filter(Boolean);

  if (files.length === 0) {
    return (
      <div className="card">
        <div className="card-head"><h3>Files</h3></div>
        <div className="card-body tiny muted">No files uploaded.</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head"><h3>Files</h3><span className="k">{files.length}</span></div>
      <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
        {files.map(f => (
          <a key={f.label} href={f.url} target="_blank" rel="noreferrer"
             style={{ border: '1px solid var(--line-1)', borderRadius: 4, overflow: 'hidden', background: 'var(--bg-2)', textDecoration: 'none' }}>
            <div style={{ height: 80, display: 'grid', placeItems: 'center', position: 'relative', background: 'var(--bg-1)' }}>
              <Icon name="clipboard" size={26} />
              <span className="tag" style={{ position: 'absolute', top: 6, right: 6, textTransform: 'uppercase' }}>{EXT(f.name)}</span>
            </div>
            <div style={{ padding: '8px 10px' }}>
              <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 9.5, marginBottom: 2 }}>{f.label}</div>
              <div style={{ fontSize: 11.5, color: 'var(--ink-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `FlagsCard.js`.**

```jsx
import React from 'react';

export default function FlagsCard({ a }) {
  const flags = a.flags || [];
  return (
    <div className="card">
      <div className="card-head"><h3>Flags</h3></div>
      <div className="card-body hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
        {flags.length === 0 && <span className="tiny muted">None.</span>}
        {flags.map(f => {
          const isWarn = f.toLowerCase().startsWith('no ');
          return (
            <span key={f} className="tag" style={{
              color: isWarn ? 'hsl(var(--warn-h) var(--warn-s) 50%)' :
                     f === 'Referral' ? 'var(--accent)' : 'var(--ink-2)',
              borderColor: 'currentColor',
            }}>{f}</span>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `ViabilityCard.js`.**

```jsx
import React from 'react';

function tryParseArray(maybeJson) {
  try { return JSON.parse(maybeJson || '[]'); } catch { return []; }
}

export default function ViabilityCard({ a }) {
  const positions = tryParseArray(a.positions_interested);
  const items = [
    ['Position(s)', positions.join(', ') || '—'],
    ['Travel', a.travel_distance || '—'],
    ['Transport', a.reliable_transportation || '—'],
    ['Years', a.bartending_years > 0 ? `${a.bartending_years} yr` : 'Entry-level'],
    ['Last bartended', a.last_bartending_time || '—'],
    ['Setup conf.', a.setup_confidence != null ? `${a.setup_confidence} / 5` : '—'],
    ['Works alone', a.comfortable_working_alone || '—'],
    ['Saturdays', a.available_saturdays || '—'],
  ];
  return (
    <div className="card">
      <div className="card-head">
        <h3>Hiring viability</h3>
        <span className="muted tiny">Quick glance</span>
      </div>
      <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px 18px' }}>
        {items.map(([k, v]) => (
          <div key={k}>
            <div className="tiny muted" style={{ marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 9.5 }}>{k}</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-1)' }}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: `RejectModal.js`.**

```jsx
import React, { useState, useEffect } from 'react';

export default function RejectModal({ open, onClose, onConfirm }) {
  const [reason, setReason]     = useState('');
  const [submitting, setSubmit] = useState(false);

  useEffect(() => { if (!open) { setReason(''); setSubmit(false); } }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (!reason.trim()) return;
    setSubmit(true);
    try { await onConfirm(reason.trim()); }
    finally { setSubmit(false); }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
      display: 'grid', placeItems: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} className="card" style={{ width: 420, maxWidth: '92vw' }}>
        <div className="card-head"><h3>Reject application</h3></div>
        <div className="card-body vstack" style={{ gap: 12 }}>
          <p className="tiny muted">A short reason helps when reviewing later. Visible only to admins.</p>
          <textarea
            className="input"
            placeholder="e.g. limited availability, no BASSET, didn't show for screen…"
            value={reason}
            onChange={e => setReason(e.target.value)}
            style={{ minHeight: 90, padding: 10, resize: 'vertical' }}
            autoFocus
          />
          <div className="hstack" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
            <button className="btn btn-primary" onClick={submit} disabled={!reason.trim() || submitting}
                    style={{ background: 'hsl(var(--danger-h) var(--danger-s) 50%)' }}>
              {submitting ? 'Rejecting…' : 'Reject'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Build check.** `cd client && npm run build`. Expected: failing only on the section files.

---

### Task 2.5 — Sections (Words, Experience, Gear, Contact)

**Files:**
- Create: `client/src/pages/admin/applicationDetail/sections/SectionWords.js`
- Create: `client/src/pages/admin/applicationDetail/sections/SectionExperience.js`
- Create: `client/src/pages/admin/applicationDetail/sections/SectionGear.js`
- Create: `client/src/pages/admin/applicationDetail/sections/SectionContact.js`

- [ ] **Step 1: `SectionWords.js`.**

```jsx
import React from 'react';

const Block = ({ label, children }) => (
  <div>
    <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, marginBottom: 4 }}>{label}</div>
    <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55 }}>{children}</div>
  </div>
);

export default function SectionWords({ a }) {
  return (
    <div className="card">
      <div className="card-head"><h3>In their own words</h3></div>
      <div className="card-body vstack" style={{ gap: 14 }}>
        <Block label="Why Dr. Bartender?">
          {a.why_dr_bartender
            ? <span style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>"{a.why_dr_bartender}"</span>
            : <span className="muted">Not provided.</span>}
        </Block>
        {a.customer_service_approach && (
          <div style={{ borderTop: '1px solid var(--line-1)', paddingTop: 12 }}>
            <Block label="Customer service approach">{a.customer_service_approach}</Block>
          </div>
        )}
        {a.additional_info && (
          <div style={{ borderTop: '1px solid var(--line-1)', paddingTop: 12 }}>
            <Block label="Additional info">{a.additional_info}</Block>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `SectionExperience.js`.**

```jsx
import React from 'react';

function tryParseArray(maybeJson) {
  try { return JSON.parse(maybeJson || '[]'); } catch { return []; }
}

export default function SectionExperience({ a }) {
  const positions = tryParseArray(a.positions_interested);
  const types = (a.experience_types || '').split(',').map(s => s.trim()).filter(Boolean);
  return (
    <div className="card">
      <div className="card-head"><h3>Experience</h3></div>
      <div className="card-body">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginBottom: 14 }}>
          <div>
            <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10, marginBottom: 6 }}>Positions interested in</div>
            <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
              {positions.length === 0
                ? <span className="tiny muted">—</span>
                : positions.map(p => <span key={p} className="tag" style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>{p}</span>)}
            </div>
          </div>
          <div>
            <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10, marginBottom: 6 }}>Experience types</div>
            <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
              {types.length === 0
                ? <span className="tiny muted">—</span>
                : types.map(t => <span key={t} className="tag">{t}</span>)}
            </div>
          </div>
        </div>
        {a.bartending_experience_description && (
          <div style={{ borderTop: '1px solid var(--line-1)', paddingTop: 12 }}>
            <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10, marginBottom: 6 }}>Their description</div>
            <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
              {a.bartending_experience_description}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `SectionGear.js`.**

```jsx
import React from 'react';

const TOOLS = [
  ['tools_mixing_tins',  'Mixing tins'],
  ['tools_strainer',     'Strainer'],
  ['tools_ice_scoop',    'Ice scoop'],
  ['tools_bar_spoon',    'Bar spoon'],
  ['tools_tongs',        'Tongs'],
  ['tools_ice_bin',      'Ice bin'],
  ['tools_bar_mats',     'Bar mats'],
  ['tools_bar_towels',   'Bar towels'],
];
const EQUIP = [
  ['equipment_portable_bar',        'Portable bar'],
  ['equipment_cooler',              'Cooler'],
  ['equipment_table_with_spandex',  '6ft Table w/ Spandex'],
];

export default function SectionGear({ a }) {
  const tools = TOOLS.filter(([k]) => a[k]).map(([, l]) => l);
  const equip = EQUIP.filter(([k]) => a[k]).map(([, l]) => l);
  return (
    <div className="card">
      <div className="card-head"><h3>Tools &amp; equipment</h3></div>
      <div className="card-body">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          <div>
            <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10, marginBottom: 6 }}>Bar tools owned</div>
            <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
              {tools.length === 0
                ? <span className="tiny muted">{a.tools_none_will_start ? 'None — will start with team kit' : 'None listed'}</span>
                : tools.map(t => <span key={t} className="tag">{t}</span>)}
            </div>
          </div>
          <div>
            <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10, marginBottom: 6 }}>Bar equipment</div>
            <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
              {equip.length === 0
                ? <span className="tiny muted">{a.equipment_none_but_open ? 'None — open to acquiring' : 'None listed'}</span>
                : equip.map(t => <span key={t} className="tag">{t}</span>)}
            </div>
          </div>
        </div>
        <div style={{ borderTop: '1px solid var(--line-1)', paddingTop: 12, marginTop: 14 }}>
          <dl className="dl">
            <dt>Saturdays</dt><dd>{a.available_saturdays || '—'}</dd>
            <dt>Other commitments</dt><dd>{a.other_commitments || '—'}</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: `SectionContact.js`.**

```jsx
import React from 'react';
import { formatPhone } from '../../../../utils/formatPhone';

const formatDOB = (m, d, y) => {
  if (!m || !d || !y) return '—';
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
};

export default function SectionContact({ a }) {
  const addr = [a.street_address, [a.city, a.state].filter(Boolean).join(', '), a.zip_code]
    .filter(Boolean).join(' · ');
  return (
    <div className="card">
      <div className="card-head"><h3>Contact &amp; identity</h3></div>
      <div className="card-body">
        <dl className="dl">
          <dt>Email</dt><dd>{a.email}</dd>
          <dt>Phone</dt><dd className="mono">{formatPhone(a.phone) || a.phone}</dd>
          <dt>Address</dt><dd>{addr || '—'}</dd>
          <dt>Date of birth</dt><dd>{formatDOB(a.birth_month, a.birth_day, a.birth_year)}</dd>
          <dt>Emergency contact</dt>
          <dd>
            {a.emergency_contact_name || '—'}
            {a.emergency_contact_relationship && <span className="muted"> · {a.emergency_contact_relationship}</span>}
            {a.emergency_contact_phone && <div className="tiny muted mono">{formatPhone(a.emergency_contact_phone) || a.emergency_contact_phone}</div>}
          </dd>
        </dl>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Build passes.** `cd client && npm run build`. Expected: build succeeds.

---

### Task 2.6 — Wire route + delete legacy file

**Files:**
- Modify: `client/src/App.js`
- Delete: `client/src/pages/AdminApplicationDetail.js`

- [ ] **Step 1: Update the import path in App.js.** Find line 57:

```js
const AdminApplicationDetail = lazy(() => import('./pages/AdminApplicationDetail'));
```

Replace with:

```js
const AdminApplicationDetail = lazy(() => import('./pages/admin/applicationDetail/AdminApplicationDetail'));
```

- [ ] **Step 2: Delete the legacy file.**

```bash
git rm client/src/pages/AdminApplicationDetail.js
```

- [ ] **Step 3: Build passes.** `cd client && npm run build`. Expected: build succeeds.

- [ ] **Step 4: Manual UI smoke test.**
  - Start `npm run dev`. Navigate to `http://localhost:3000/admin/staffing/applications/<a-real-id>`.
  - Verify: identity bar with avatar, status chip, position chip(s), pipeline strip showing the right segment.
  - Click each primary CTA per stage (use a test applicant in each stage). Confirm transitions work.
  - Open scorecard, click a few dots, refresh — values persist.
  - Post a note in the timeline — appears immediately after refresh.
  - Click "Reject & archive" — modal opens, type a reason, confirm. Detail re-renders with rejection banner.
  - Click "Restore to Applied" on the rejected page — moves back.

---

### Task 2.7 — Phase 2 commit

- [ ] **Step 1: Commit.**

```bash
git add client/src/pages/admin/applicationDetail client/src/App.js
git rm client/src/pages/AdminApplicationDetail.js
git commit -m "feat(hiring): rewrite application detail page in admin-os vocab"
```

---

## Phase 3 — Hiring Dashboard + Docs

### Task 3.1 — InterviewScheduleModal

**Files:**
- Create: `client/src/components/adminos/InterviewScheduleModal.js`

- [ ] **Step 1: Build the modal.**

```jsx
import React, { useState, useEffect } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';

// Round to next 30-min slot for the default datetime.
const defaultWhen = () => {
  const now = new Date();
  now.setMinutes(now.getMinutes() < 30 ? 30 : 60, 0, 0);
  // Format for datetime-local input: YYYY-MM-DDTHH:mm
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
};

export default function InterviewScheduleModal({ open, applicant, onClose, onSaved }) {
  const toast = useToast();
  const [when, setWhen]         = useState(defaultWhen());
  const [notes, setNotes]       = useState('');
  const [sendEmail, setSendEm]  = useState(true);
  const [submitting, setSubmit] = useState(false);

  useEffect(() => {
    if (open && applicant) {
      setWhen(applicant.interview_at
        ? new Date(applicant.interview_at).toISOString().slice(0, 16)
        : defaultWhen());
      setNotes('');
      setSendEm(!applicant.interview_at); // default off when rescheduling
      setSubmit(false);
    }
  }, [open, applicant]);

  if (!open || !applicant) return null;

  const submit = async () => {
    setSubmit(true);
    try {
      await api.put(`/admin/applications/${applicant.id}/interview`, {
        interview_at: new Date(when).toISOString(),
        notes:        notes.trim() || null,
        send_email:   sendEmail,
      });
      toast.success('Interview scheduled.');
      onSaved && onSaved();
      onClose();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Could not schedule.');
    } finally {
      setSubmit(false);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
      display: 'grid', placeItems: 'center',
    }} data-app="admin-os">
      <div onClick={e => e.stopPropagation()} className="card" style={{ width: 460, maxWidth: '92vw' }}>
        <div className="card-head">
          <h3>{applicant.interview_at ? 'Reschedule' : 'Schedule'} interview · {applicant.full_name}</h3>
        </div>
        <div className="card-body vstack" style={{ gap: 12 }}>
          <label className="vstack" style={{ gap: 4 }}>
            <span className="tiny muted">When</span>
            <input
              type="datetime-local"
              className="input"
              value={when}
              onChange={e => setWhen(e.target.value)}
              style={{ padding: 10 }}
            />
          </label>
          <label className="vstack" style={{ gap: 4 }}>
            <span className="tiny muted">Notes (private)</span>
            <textarea
              className="input"
              placeholder="e.g. Phone — I'll call her"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              style={{ minHeight: 60, padding: 10, resize: 'vertical' }}
            />
          </label>
          <label className="hstack" style={{ gap: 8 }}>
            <input type="checkbox" checked={sendEmail} onChange={e => setSendEm(e.target.checked)} />
            <span className="tiny">Email confirmation to applicant</span>
          </label>
          <div className="hstack" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
            <button className="btn btn-primary" onClick={submit} disabled={!when || submitting}>
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build check.** `cd client && npm run build`. Expected: success.

---

### Task 3.2 — Rewrite HiringDashboard.js

**Files:**
- Modify (full rewrite): `client/src/pages/admin/HiringDashboard.js`

- [ ] **Step 1: Replace the file contents.** Open `client/src/pages/admin/HiringDashboard.js`, select all, and replace with:

```jsx
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import InterviewScheduleModal from '../../components/adminos/InterviewScheduleModal';

const ONBOARDING_STEPS = [
  'account_created','welcome_viewed','field_guide_completed',
  'agreement_completed','contractor_profile_completed',
  'payday_protocols_completed','onboarding_completed',
];

const tryParseArray = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
const initialsOf = (n) => (n || '?').split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2);
const daysSince = (d) => d ? Math.round((Date.now() - new Date(d).getTime()) / 86400000) : null;
const daysUntil = (d) => d ? Math.round((new Date(d).getTime() - Date.now()) / 86400000) : null;

const COLUMNS = [
  { key: 'applied',      label: 'Applied',     hint: 'Awaiting first review' },
  { key: 'interviewing', label: 'Interview',   hint: 'Invited or scheduled' },
  { key: 'in_progress',  label: 'Onboarding',  hint: 'Filling out paperwork' },
];

const STATE_LABELS = {
  applied: 'Applied', interviewing: 'Interview', in_progress: 'Onboarding',
  hired: 'Onboarding', // legacy alias
  approved: 'Active', deactivated: 'Deactivated',
  rejected: 'Rejected', unfinished: 'Unfinished signup',
};

export default function HiringDashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [apps, setApps]               = useState([]);
  const [appsLoading, setAppsLoading] = useState(true);
  const [summary, setSummary]         = useState({ new_apps_7d: 0, need_to_schedule: 0, stalled: 0, in_pipeline: 0 });

  const [searchQ, setSearchQ]               = useState('');
  const [searchResults, setSearchResults]   = useState([]);
  const [searchOpen, setSearchOpen]         = useState(false);
  const [searchLoading, setSearchLoading]   = useState(false);

  const [scheduleFor, setScheduleFor] = useState(null);

  const fetchAll = useCallback(async () => {
    setAppsLoading(true);
    try {
      const [appsRes, sumRes] = await Promise.all([
        api.get('/admin/applications?page=1&limit=200'),
        api.get('/admin/hiring/summary'),
      ]);
      setApps(appsRes.data.applications || []);
      setSummary(sumRes.data);
    } catch {
      toast.error('Failed to load hiring data.');
    } finally {
      setAppsLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Deep-link: /admin/hiring?schedule=<id> opens the schedule modal for that applicant.
  useEffect(() => {
    const id = searchParams.get('schedule');
    if (id && apps.length) {
      const a = apps.find(x => String(x.id) === String(id));
      if (a) setScheduleFor(a);
    }
  }, [searchParams, apps]);

  // Debounced search.
  useEffect(() => {
    if (!searchQ.trim() || searchQ.trim().length < 2) {
      setSearchResults([]); setSearchOpen(false);
      return;
    }
    setSearchLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.get(`/admin/hiring/search?q=${encodeURIComponent(searchQ.trim())}`);
        setSearchResults(r.data.results || []);
        setSearchOpen(true);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [searchQ]);

  const cols = useMemo(() => {
    const out = { applied: [], interviewing_unsched: [], interviewing_sched: [], in_progress: [] };
    for (const a of apps) {
      const s = a.onboarding_status === 'hired' ? 'in_progress' : a.onboarding_status;
      if (s === 'applied') out.applied.push(a);
      else if (s === 'interviewing') {
        if (a.interview_at) out.interviewing_sched.push(a);
        else out.interviewing_unsched.push(a);
      } else if (s === 'in_progress') out.in_progress.push(a);
    }
    out.applied.sort((a, b) => new Date(b.applied_at) - new Date(a.applied_at));
    out.interviewing_sched.sort((a, b) => new Date(a.interview_at) - new Date(b.interview_at));
    return out;
  }, [apps]);

  const newThisWeek = summary.new_apps_7d;

  return (
    <div className="page" data-app="admin-os">
      <div className="page-header">
        <div>
          <div className="page-title">Hiring</div>
          <div className="page-subtitle">{summary.in_pipeline} in pipeline · {newThisWeek} new this week</div>
        </div>
        <div className="page-actions" style={{ position: 'relative', minWidth: 280 }}>
          <input
            className="input"
            placeholder="Search all applicants…"
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
            onFocus={() => searchResults.length && setSearchOpen(true)}
            onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
            style={{ width: '100%', padding: '8px 12px' }}
          />
          {searchOpen && (
            <div className="card" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, width: 360, zIndex: 100, padding: 4 }}>
              {searchLoading && <div className="tiny muted" style={{ padding: 12 }}>Searching…</div>}
              {!searchLoading && searchResults.length === 0 && <div className="tiny muted" style={{ padding: 12 }}>No matches.</div>}
              {searchResults.map(r => (
                <div key={r.id} onMouseDown={() => {
                  setSearchOpen(false); setSearchQ('');
                  if (r.state === 'unfinished') {
                    toast.info(`${r.email} registered ${new Date(r.user_created_at).toLocaleDateString()} but hasn't submitted.`);
                  } else {
                    navigate(`/admin/staffing/applications/${r.id}`);
                  }
                }} style={{ padding: '8px 10px', cursor: 'pointer', borderRadius: 3 }} className="hover-bg">
                  <div className="hstack" style={{ gap: 8, justifyContent: 'space-between' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{r.full_name || r.email}</div>
                      <div className="tiny muted">{r.email}</div>
                    </div>
                    <StatusChip kind={r.state === 'rejected' ? 'danger' : r.state === 'unfinished' ? 'warn' : 'info'}>
                      {STATE_LABELS[r.state] || r.state}
                    </StatusChip>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* KPI strip */}
      <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
        <div className="stat">
          <div className="stat-label">New apps · 7d</div>
          <div className="stat-value" style={{ color: summary.new_apps_7d > 0 ? 'hsl(var(--ok-h) var(--ok-s) 52%)' : '' }}>
            {summary.new_apps_7d > 0 ? '+' : ''}{summary.new_apps_7d}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Need to schedule</div>
          <div className="stat-value" style={{ color: summary.need_to_schedule > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : '' }}>
            {summary.need_to_schedule}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Stalled</div>
          <div className="stat-value" style={{ color: summary.stalled > 0 ? 'hsl(var(--danger-h) var(--danger-s) 58%)' : '' }}>
            {summary.stalled}
          </div>
        </div>
      </div>

      {/* Kanban */}
      {appsLoading ? (
        <div className="loading"><div className="spinner"/>Loading…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(260px, 1fr))', gap: 12, alignItems: 'start' }}>
          {COLUMNS.map(col => (
            <div key={col.key} style={{
              background: 'var(--bg-2)', border: '1px solid var(--line-1)', borderRadius: 4,
              display: 'flex', flexDirection: 'column', minHeight: 380,
            }}>
              <div style={{ padding: '11px 12px 10px', borderBottom: '1px solid var(--line-1)' }}>
                <div className="hstack" style={{ justifyContent: 'space-between' }}>
                  <strong style={{ fontSize: 12.5 }}>{col.label}</strong>
                  <span className="k">
                    {col.key === 'interviewing'
                      ? cols.interviewing_unsched.length + cols.interviewing_sched.length
                      : cols[col.key].length}
                  </span>
                </div>
                <div className="tiny muted" style={{ fontSize: 10.5 }}>{col.hint}</div>
              </div>
              <div className="vstack" style={{ gap: 8, padding: 8, flex: 1 }}>
                {col.key === 'interviewing' ? (
                  <>
                    {cols.interviewing_unsched.length > 0 && (
                      <SubHeader label={`Unscheduled (${cols.interviewing_unsched.length})`} />
                    )}
                    {cols.interviewing_unsched.map(a =>
                      <ApplicantCard key={a.id} a={a} onOpen={() => navigate(`/admin/staffing/applications/${a.id}`)} onSchedule={() => setScheduleFor(a)} />
                    )}
                    {cols.interviewing_sched.length > 0 && (
                      <SubHeader label={`Scheduled (${cols.interviewing_sched.length})`} />
                    )}
                    {cols.interviewing_sched.map(a =>
                      <ApplicantCard key={a.id} a={a} onOpen={() => navigate(`/admin/staffing/applications/${a.id}`)} onSchedule={() => setScheduleFor(a)} />
                    )}
                    {cols.interviewing_unsched.length === 0 && cols.interviewing_sched.length === 0 && <EmptyTile />}
                  </>
                ) : (
                  <>
                    {cols[col.key].map(a =>
                      <ApplicantCard key={a.id} a={a} onOpen={() => navigate(`/admin/staffing/applications/${a.id}`)} onSchedule={() => setScheduleFor(a)} />
                    )}
                    {cols[col.key].length === 0 && <EmptyTile />}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <InterviewScheduleModal
        open={!!scheduleFor}
        applicant={scheduleFor}
        onClose={() => { setScheduleFor(null); setSearchParams({}); }}
        onSaved={() => { fetchAll(); }}
      />
    </div>
  );
}

const SubHeader = ({ label }) => (
  <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10, padding: '4px 4px 2px' }}>{label}</div>
);

const EmptyTile = () => (
  <div className="tiny muted" style={{ padding: '16px 8px', textAlign: 'center', border: '1px dashed var(--line-1)', borderRadius: 3 }}>
    Empty.
  </div>
);

function ApplicantCard({ a, onOpen, onSchedule }) {
  const positions = tryParseArray(a.positions_interested);
  const status = a.onboarding_status === 'hired' ? 'in_progress' : a.onboarding_status;
  const isUnscheduled = status === 'interviewing' && !a.interview_at;
  const days = daysSince(a.applied_at);

  return (
    <div onClick={onOpen} style={{
      padding: '10px 11px',
      background: isUnscheduled ? 'hsl(var(--warn-h) var(--warn-s) 50% / 0.06)' : 'var(--bg-1)',
      border: '1px solid ' + (isUnscheduled ? 'hsl(var(--warn-h) var(--warn-s) 50% / 0.4)' : 'var(--line-1)'),
      borderRadius: 4, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8,
    }} className="hover-lift">
      <div className="hstack" style={{ gap: 8 }}>
        <div className="avatar" style={{ width: 28, height: 28, fontSize: 10, flexShrink: 0 }}>
          {initialsOf(a.full_name)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {a.full_name}
          </div>
          <div className="hstack" style={{ gap: 4, marginTop: 2, flexWrap: 'wrap' }}>
            {positions.slice(0, 2).map(p => <span key={p} className="tag" style={{ fontSize: 9.5, padding: '1px 5px' }}>{p}</span>)}
            {positions.length > 2 && <span className="tiny muted">+{positions.length - 2}</span>}
          </div>
        </div>
      </div>
      {a.referral_source && (
        <div className="tiny" style={{ color: 'var(--accent)' }}>Referral · {a.referral_source}</div>
      )}
      <div className="hstack" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--line-1)', paddingTop: 6, marginTop: 'auto', alignItems: 'flex-end' }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 10.5 }}>
          <Footer a={a} status={status} onSchedule={onSchedule} />
        </div>
        <span className="tiny muted" style={{ marginLeft: 8, flexShrink: 0 }}>
          {days != null ? `${days}d` : ''}
        </span>
      </div>
    </div>
  );
}

function Footer({ a, status, onSchedule }) {
  if (status === 'applied') {
    return <span className="muted">{a.city}</span>;
  }
  if (status === 'interviewing' && !a.interview_at) {
    return (
      <button onClick={(e) => { e.stopPropagation(); onSchedule(); }}
              className="btn btn-secondary btn-sm"
              style={{ padding: '3px 8px', fontSize: 10.5 }}>
        Schedule →
      </button>
    );
  }
  if (status === 'interviewing' && a.interview_at) {
    const dt = new Date(a.interview_at);
    const diff = daysUntil(a.interview_at);
    const when = diff <= 0 ? 'Today' : diff === 1 ? 'Tomorrow' : `In ${diff}d`;
    return <span>{when} · {dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>;
  }
  if (status === 'in_progress') {
    const pct = Math.round((a.onboarding_progress || 0) * 100);
    return (
      <div style={{ width: '100%' }}>
        <div className="hstack" style={{ justifyContent: 'space-between', marginBottom: 3 }}>
          <span style={{ color: pct === 100 ? 'hsl(var(--ok-h) var(--ok-s) 50%)' : 'var(--ink-2)' }}>
            {pct === 100 ? 'Ready (auto-flips)' : `${pct}%`}
          </span>
          {a.onboarding_blocker && pct < 100 && <span className="muted" style={{ fontSize: 9.5 }}>{a.onboarding_blocker}</span>}
        </div>
        <div style={{ height: 3, background: 'var(--bg-2)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: pct + '%', height: '100%', background: pct === 100 ? 'hsl(var(--ok-h) var(--ok-s) 50%)' : 'var(--accent)' }} />
        </div>
      </div>
    );
  }
  return null;
}
```

- [ ] **Step 2: Build check.** `cd client && npm run build`. Expected: success.

- [ ] **Step 3: Manual UI smoke test.**
  - Navigate to `http://localhost:3000/admin/hiring`.
  - Verify: 3 kanban columns visible, KPI strip with 3 stats, search bar in the header.
  - Type a name into search — dropdown shows up to 20 results with state chips.
  - Click an applicant card → navigates to detail page.
  - On a card in Interview/Unscheduled, click "Schedule →" — modal opens, pick a time, save.
  - Card moves from Unscheduled to Scheduled group within the same column.
  - Refresh the page — KPI counts update.

---

### Task 3.3 — Documentation updates

**Files:**
- Modify: `.claude/CLAUDE.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md` (if exists; if not, skip — the spec mentions it but per the codebase, only update if the file exists)

- [ ] **Step 1: CLAUDE.md folder tree updates.** Find the folder tree under "Folder Structure" → `client/src/pages/admin/` block. Replace the line for `AdminApplicationDetail` (which doesn't exist there yet — it's at `client/src/pages/AdminApplicationDetail.js`) with the new `applicationDetail/` subfolder following the same shape used for `userDetail/`:

```
│   │   │   ├── applicationDetail/    # Application detail page (rebuilt 2026-04-28)
│   │   │   │   ├── AdminApplicationDetail.js  # Parent — shell, identity bar, pipeline, two-col layout
│   │   │   │   ├── helpers.js                  # AD_FLOW, SCORECARD_DIMS, ONBOARDING_ITEMS, initialsOf, relDay
│   │   │   │   ├── components/                 # PipelineStrip, ScorecardCard, TimelineCard, OnboardingCard, ActionsCard, StatsCard, FilesBlock, FlagsCard, ViabilityCard, RejectModal
│   │   │   │   └── sections/                   # SectionWords, SectionExperience, SectionGear, SectionContact
```

Update HiringDashboard.js's tree comment to: `# Hiring kanban (rewritten 2026-04-28 — kanban + search + KPIs + scheduling)`.

Add a new admin-os component entry for the schedule modal:

```
│   │   │   │   ├── InterviewScheduleModal.js   # Date/time/notes modal for scheduling interviews
```

(In the alphabetical position between `Icon.js` and `KebabMenu.js`.)

- [ ] **Step 2: Schema additions in CLAUDE.md.** Under "Schema changes" or near the existing schema-discipline notes, add a brief mention that `interview_scores` and `application_activity` exist. (One-line entries in the architecture description.)

- [ ] **Step 3: README.md folder tree.** Mirror the changes from Step 1 in the README's folder tree (it has the same shape).

- [ ] **Step 4: ARCHITECTURE.md (if it exists).** Check:

```bash
ls ARCHITECTURE.md 2>/dev/null
```

If it exists, add a brief "Hiring pipeline" section near the staff/contractor sections describing: 4 stages (Applied → Interview → Onboarding → Active), interview scheduling, scorecard, activity timeline, the two new tables. If it doesn't exist, skip — don't create it solely for this.

- [ ] **Step 5: Build check.** `cd client && npm run build`. Expected: success (no code change; just confirming nothing got accidentally broken).

---

### Task 3.4 — Phase 3 commit

- [ ] **Step 1: Final manual end-to-end smoke.** Walk a synthetic applicant through the full flow:
  1. Apply (via `/apply` form, including the new "Who referred you?" field).
  2. Open `/admin/hiring` — applicant appears in Applied column with referral chip.
  3. Click into them — detail page renders. Click "Invite to interview" → moves to Interview/Unscheduled.
  4. Back on /admin/hiring, click "Schedule →" on the card → modal opens, pick date/time/email checkbox, save.
  5. Card moves to Interview/Scheduled. Detail page now shows "Hire" as primary CTA + "Reschedule" + "Reject" secondaries.
  6. Click "Hire" → moves to Onboarding column. Detail page shows OnboardingCard in right rail.
  7. Click "Send paperwork reminder" → toast confirms. Activity timeline shows reminder_sent event.
  8. (Skip the actual onboarding — just verify the auto-activate path is described/documented.)
  9. From the rejected pile (set someone to rejected first), search by name → result with "Rejected" chip → click → detail page → "Restore to Applied" → back into Applied column.
  10. Search for an unfinished signup (a user without an applications row) — toast surfaces their email and signup date.
  11. Open scorecard during Interview stage — click dots, refresh, values persist. Total updates as you click.

- [ ] **Step 2: Commit.**

```bash
git add client/src/pages/admin/HiringDashboard.js client/src/components/adminos/InterviewScheduleModal.js .claude/CLAUDE.md README.md
# Add ARCHITECTURE.md only if you modified it.
git commit -m "feat(hiring): rewrite hiring dashboard with kanban + KPIs + search + scheduling"
```

---

## Self-Review (run after writing the plan)

This section was used during plan creation. Findings:

**1. Spec coverage** — every spec section maps to at least one task:
- Stage model → Task 1.1 (schema), Task 2.2 (PipelineStrip), Task 3.2 (kanban columns)
- Started bucket → Task 1.5 (search query LEFT JOIN handles users w/o applications)
- Search bar → Task 1.5 (endpoint), Task 3.2 (UI)
- KPI strip definitions → Task 1.5
- Per-card design → Task 3.2 (`ApplicantCard`)
- Schedule modal → Task 3.1
- Two-column detail layout → Task 2.1
- Pipeline strip 4 segments → Task 2.2
- Stage-aware CTAs → Task 2.3 (`ActionsCard`)
- Main column sections (Viability, Words, Experience, Gear, Contact) → Tasks 2.4 + 2.5
- Right rail (Actions/Stats/Onboarding/Files/Flags) → Tasks 2.3 + 2.4
- Scorecard 5 dims + total /25 → Task 2.2 (`ScorecardCard`)
- Timeline → Task 2.3 (`TimelineCard`)
- Schema additions → Task 1.1
- Form referral question → Task 1.6
- Email templates → Task 1.7
- Doc updates → Task 3.3
- Drops (work history, demo picker, alt layouts, etc.) → these are absences in the new code, not tasks themselves.

**2. Placeholder scan** — none of "TBD / TODO / implement later / similar to Task N" present in the plan.

**3. Type consistency** — function and prop names match across tasks: `onMove`, `onSchedule`, `onReject`, `onRestore`, `onReminder` consistent in `ActionsCard` and parent. `scorecard` shape consistent across StatsCard, ScorecardCard, server response. `timeline` events shape consistent between server merge query (Task 1.3 step 4) and TimelineCard renderer (Task 2.3 step 1 — `EVENT_LABELS` keys match the strings the server writes).

**4. One known seam:** the server's `/applications/:userId/move` endpoint only allows `applied -> interviewing` and `interviewing -> in_progress`. The client's `ActionsCard` only triggers those exact transitions. Any future stage like "active" auto-flip is handled by the existing onboarding-completion logic, NOT this endpoint — no contract drift.

---

## Out-of-scope reminders (do NOT build in these commits)

- Candidate-self-serve interview booking.
- ServSafe certification tracking.
- Per-role hiring filters.
- Drag-and-drop between kanban columns.
- Job-posting management.
