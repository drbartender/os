# Staff Event Details Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every staffer can open a rich Event Details page for any staffable event (no approval gate), with request/waitlist/cover actions on the page, a hosted-event warning at request time, an admin-uploaded bar menu print file for assigned staff, and zero staff-facing "BEO" jargon; the ack machinery is untouched.

**Architecture:** Extract the BEO payload builder out of `server/routes/beo.js` into `server/utils/eventDetailsPayload.js`, loosen read auth to "any staff when the proposal has a non-cancelled shift" with server-side redaction of client phone and teammate phones for non-assigned viewers, and add a shift-keyed route file (`server/routes/eventDetails.js`) so the page loads by shiftId in one round trip. Menu print file lives on two new `proposals` columns with admin CRUD in `server/routes/proposals/menuPrint.js` and an authed R2 proxy download. The staff page reworks into brief (everyone) + assigned extras.

**Tech Stack:** Node.js 26 / Express 4, React 18 (CRA), Postgres raw SQL via `pg`, Cloudflare R2 via `server/utils/storage.js`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-22-staff-event-details-design.md`

## Global Constraints

- Internal identifiers NEVER change: `beo_acknowledged_at`, notification keys `beo_finalized` / `beo_reminder_t3`, route paths `/api/beo/*`, dispatcher keys, DB columns. Only staff-facing words change.
- The acknowledge flow's behavior is frozen: finalize gate, UPDATE predicates, nudges. Read auth loosens; write auth does not.
- Redaction is server-side only: a non-assigned staff viewer must never receive `client.phone` or teammate `phone` values in any payload.
- 404-before-role ordering stays: nonexistent proposal → 404; proposal with no non-cancelled shift → 404 for staff (admin/manager still 200). Never 403 on reads (403 would leak existence).
- Money/pricing fields stay OFF every staff payload (existing SELECT already excludes them; keep it that way when adding columns).
- No em dashes in any staff-facing or admin-facing copy.
- Wire keys snake_case. Errors via `AppError` subclasses. Client API via `utils/api.js` only.
- Server test law: one suite at a time against the dev DB, `node -r dotenv/config --test <file>` from repo root. Client gate: `cd client && CI=true npx react-scripts build`.
- File-size ratchet: `ShiftDetail.js` is 804 lines. The rework must NET SHRINK it (resolver deletion + extraction of the action area more than offsets additions). New files aim under 300 lines.
- Explicit `git add <path>` staging always. Lane checkpoints commit freely; the squash merge is the unit.
- `schema.sql` is a sensitive path: the server lane takes the full review fleet before merge regardless of size.

## Lane map

```yaml
lanes:
  - id: event-details-server
    footprint:
      - server/utils/eventDetailsPayload.js
      - server/routes/beo.js
      - server/routes/beo.test.js
      - server/routes/eventDetails.js
      - server/routes/eventDetails.test.js
      - server/routes/shifts.queries.js
      - server/routes/proposals/menuPrint.js
      - server/routes/proposals/menuPrint.test.js
      - server/routes/proposals/index.js
      - server/index.js
      - server/db/schema.sql
      - server/utils/smsTemplates.js
      - server/utils/smsTemplates.test.js
      - ARCHITECTURE.md
      - README.md
    depends_on: []
    review: full-fleet          # schema.sql sensitive + auth-model change
    # Fleet, matched to the batch: security-review (read-auth ungating, phone
    # redaction, menu-print IDOR + R2 proxy), database-review (schema add +
    # shifts LATERALs + feed join), consistency-check (beo_* identifier freeze),
    # code-review, performance-review.
  - id: event-details-staff-ui
    footprint:
      - client/src/pages/staff/ShiftDetail.js
      - client/src/pages/staff/ShiftsPage.js
      - client/src/pages/staff/HomePage.js
      - client/src/pages/staff/account/NotificationsSection.js
      - client/src/components/staff/BeoSections.js
      - client/src/components/staff/EventActionArea.js
      - client/src/components/staff/RequestSheet.js
      - client/src/components/staff/ShiftCard.js
      - README.md
    depends_on: [event-details-server]
    review: code-review         # display + flow; no money/auth surface
  - id: event-details-admin-ui
    footprint:
      - client/src/pages/admin/EventDetailPage.js
      - client/src/components/AdminMenuPrintBlock.js
      - README.md
    depends_on: [event-details-server]
    review: code-review
```

Lanes 2 and 3 run in parallel after lane 1 merges.

---

## Lane 1: event-details-server

### Task 1: Schema columns for the menu print file

**Files:**
- Modify: `server/db/schema.sql` (append at end)
- Modify: `ARCHITECTURE.md` (Database Schema section, proposals table)

**Interfaces:**
- Produces: `proposals.menu_print_key TEXT NULL`, `proposals.menu_not_required BOOLEAN NOT NULL DEFAULT FALSE` for Tasks 2, 4, 5.

- [ ] **Step 1: Append idempotent DDL to schema.sql**

```sql
-- Bar menu print file (staff event-details redesign, 2026-07-22 spec).
-- menu_print_key: R2 object key under menu-print/<proposalId>/. Replaced keys
-- orphan the old object (drink-plan logo pattern; storage.js has no delete).
-- menu_not_required: admin's explicit "no printed menu for this event" flag.
-- Tri-state derived, never stored: key present = ready; not_required = not_required;
-- else pending.
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS menu_print_key TEXT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS menu_not_required BOOLEAN NOT NULL DEFAULT FALSE;
```

- [ ] **Step 2: Apply to the dev DB**

Run from repo root:
```bash
node -r dotenv/config -e "const{pool}=require('./server/db');(async()=>{await pool.query(\"ALTER TABLE proposals ADD COLUMN IF NOT EXISTS menu_print_key TEXT\");await pool.query(\"ALTER TABLE proposals ADD COLUMN IF NOT EXISTS menu_not_required BOOLEAN NOT NULL DEFAULT FALSE\");const r=await pool.query(\"SELECT column_name,data_type,column_default FROM information_schema.columns WHERE table_name='proposals' AND column_name LIKE 'menu_%' ORDER BY column_name\");console.log(r.rows);process.exit(0)})()"
```
Expected: two rows, `menu_not_required` (`boolean`, default `false`) and `menu_print_key` (`text`, default null). The printed rows ARE the checkpoint; do not proceed on a bare success with no rows.

- [ ] **Step 3: Document in ARCHITECTURE.md** (proposals schema bullet list: add the two columns with one-line purpose each)

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.sql ARCHITECTURE.md
git commit -m "feat(schema): proposals.menu_print_key + menu_not_required"
```

### Task 2: Extract the payload builder, loosen read auth, redact client phone

**Files:**
- Create: `server/utils/eventDetailsPayload.js`
- Modify: `server/routes/beo.js`
- Test: `server/routes/beo.test.js` (update auth matrix in place)

**Interfaces:**
- Produces: `authorizeEventRead(req, proposalId)` (throws NotFoundError per Global Constraints; admin/manager bypass) and `buildEventDetailsPayload(req, proposalId)` returning the full JSON body. Consumed by Task 3.
- Payload additions: `viewer.is_assigned` (boolean), `menu_print` (`{status:'ready'|'not_required'|'pending'}`), `shifts` (array, shape below), `client.phone` null unless assigned or admin/manager.

- [ ] **Step 1: Update beo.test.js expectations first (TDD)**

Change/add these cases (reuse the file's existing harness, tokens, fixtures):

```js
// WAS: 403 for a staffer with no approved request. NOW: 200 + redaction.
test('unassigned staffer gets 200 with client phone and roster phones redacted', async () => {
  const res = await get(`/api/beo/${proposalId}`, otherStaffToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.client.phone, null);
  assert.ok(res.body.team_roster.every((r) => r.phone === null));
  assert.equal(res.body.viewer.is_assigned, false);
});

test('assigned staffer sees client phone and is_assigned true', async () => {
  const res = await get(`/api/beo/${proposalId}`, staffToken);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.client.phone, 'string');
  assert.equal(res.body.viewer.is_assigned, true);
});

test('proposal whose only shift is cancelled 404s for staff, 200s for admin', async () => {
  // fixture: insert a proposal + one shift with status='cancelled', clean up in after()
  const rs = await get(`/api/beo/${cancelledOnlyProposalId}`, staffToken);
  assert.equal(rs.status, 404);
  const ra = await get(`/api/beo/${cancelledOnlyProposalId}`, adminToken);
  assert.equal(ra.status, 200);
});

test('payload carries shifts array and menu_print tri-state', async () => {
  const res = await get(`/api/beo/${proposalId}`, staffToken);
  const s = res.body.shifts.find((x) => x.id === shiftId);
  assert.ok(s);
  assert.ok('equipment_required' in s && 'supply_run_required' in s && 'approved_by_role' in s);
  assert.deepEqual(res.body.menu_print, { status: 'pending' });
});
```

Also UPDATE the existing case `staff on cancelled shift 403` (beo.test.js:363-368): under the loosened auth a proposal whose shifts are all cancelled returns 404 for staff, so its assertion flips from 403 to 404.

Keep unchanged: nonexistent proposal 404, acknowledge tests, phone-gating roster tests for the assigned viewer. (The file has no logo tests despite its header comment; nothing to preserve there.)

- [ ] **Step 2: Run the suite to verify the new cases fail**

Run: `node -r dotenv/config --test server/routes/beo.test.js`
Expected: the four new/changed tests FAIL (403 where 200 expected, missing fields), the rest PASS.

- [ ] **Step 3: Create `server/utils/eventDetailsPayload.js`**

Move the body of beo.js's GET handler (proposal query, drink plan query, addons query, shift_requests query, roster query + computeName/computeInitials, viewerApproved query, response assembly) into:

```js
const { pool } = require('../db');
const { NotFoundError } = require('./errors');

/**
 * Read auth for event details (spec 2026-07-22): any authenticated staff may
 * read an event that has at least one non-cancelled shift. Admin/manager
 * always. 404 (never 403) so reads cannot probe proposal existence.
 */
async function authorizeEventRead(req, proposalId) {
  const exists = await pool.query('SELECT 1 FROM proposals WHERE id = $1 LIMIT 1', [proposalId]);
  if (!exists.rowCount) throw new NotFoundError('Event not found.');
  if (req.user.role === 'admin' || req.user.role === 'manager') return;
  const r = await pool.query(
    `SELECT 1 FROM shifts WHERE proposal_id = $1 AND status != 'cancelled' LIMIT 1`,
    [proposalId]
  );
  if (!r.rowCount) throw new NotFoundError('Event not found.');
}

async function buildEventDetailsPayload(req, proposalId) { /* moved body */ }

module.exports = { authorizeEventRead, buildEventDetailsPayload };
```

Inside the moved body make exactly these changes:

a. Proposal SELECT adds `p.menu_print_key, p.menu_not_required` (still NO pricing/payment columns).

b. New shifts query after the roster query:

```js
const shiftsRow = await pool.query(
  `SELECT s.id, s.event_date, s.start_time, s.end_time, s.location, s.guest_count,
          s.positions_needed, s.equipment_required, s.supply_run_required,
          s.setup_minutes_before,
          abr.approved_by_role,
          cov.cover_requested_at, cov.cover_for_first_initial,
          my.id AS my_request_id, my.status AS my_request_status, my.position AS my_position,
          my.requested_positions AS my_requested_positions
     FROM shifts s
     LEFT JOIN LATERAL (
       SELECT csr.cover_requested_at,
              UPPER(LEFT(TRIM(COALESCE(cp2.preferred_name, '?')), 1)) AS cover_for_first_initial
         FROM shift_requests csr
         LEFT JOIN contractor_profiles cp2 ON cp2.user_id = csr.user_id
        WHERE csr.shift_id = s.id AND csr.cover_requested_at IS NOT NULL
          AND csr.status = 'approved' AND csr.dropped_at IS NULL
        ORDER BY csr.cover_requested_at ASC LIMIT 1
     ) cov ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(jsonb_object_agg(position, c), '{}'::jsonb) AS approved_by_role
         FROM (SELECT position, COUNT(*) c FROM shift_requests
                WHERE shift_id = s.id AND status = 'approved' AND dropped_at IS NULL
                  AND position IS NOT NULL GROUP BY position) g
     ) abr ON true
     LEFT JOIN LATERAL (
       SELECT sr.id, sr.status, sr.position, sr.requested_positions
         FROM shift_requests sr
        WHERE sr.shift_id = s.id AND sr.user_id = $2
          AND sr.status != 'denied' AND sr.dropped_at IS NULL
        ORDER BY sr.id DESC LIMIT 1
     ) my ON true
    WHERE s.proposal_id = $1 AND s.status != 'cancelled'
    ORDER BY s.id`,
  [proposalId, req.user.id]
);
```

c. Response assembly changes:

```js
const isPrivileged = req.user.role === 'admin' || req.user.role === 'manager';
const canSeeContact = viewerApproved || isPrivileged;
// client:
client: { name: p.client_name, phone: canSeeContact ? p.client_phone : null },
// viewer:
viewer: { is_admin: isAdmin, is_assigned: viewerApproved, is_acknowledged: isAck },
// appended:
shifts: shiftsRow.rows,
menu_print: p.menu_print_key
  ? { status: 'ready' }
  : p.menu_not_required
  ? { status: 'not_required' }
  : { status: 'pending' },
```

- [ ] **Step 4: Rewire `server/routes/beo.js`**

- Delete the old `authorize()` and the GET body; import `{ authorizeEventRead, buildEventDetailsPayload }`.
- KEEP each route's `parseInt` + `Number.isFinite` guard lines (beo.js:50-51 and siblings). Dropping them sends NaN to pg and 500s with 22P02 (the UUID token-guard class of bug). Belt-and-suspenders: `authorizeEventRead` also opens with `if (!Number.isFinite(proposalId)) throw new NotFoundError('Event not found.');`
- `GET /:proposalId` → `await authorizeEventRead(req, proposalId); res.json(await buildEventDetailsPayload(req, proposalId));`
- `GET /:proposalId/logo` and `POST /:proposalId/acknowledge` swap `authorize(` for `authorizeEventRead(` (acknowledge stays effectively assigned-only via its UPDATE predicates and the manager staffed check; add a comment saying so).
- Update the file-head comment block: read auth is any-staff-on-staffable-event, contact fields are redacted for non-assigned viewers.

- [ ] **Step 5: Run the suite to verify green**

Run: `node -r dotenv/config --test server/routes/beo.test.js`
Expected: PASS, all cases.

- [ ] **Step 6: Commit**

```bash
git add server/utils/eventDetailsPayload.js server/routes/beo.js server/routes/beo.test.js
git commit -m "feat(beo): extract payload builder, ungate staff reads with contact redaction"
```

### Task 3: Shift-keyed event-details route + menu print download proxy

**Files:**
- Create: `server/routes/eventDetails.js`
- Modify: `server/index.js` (one mount line after the `staffShiftActions` mount at line ~280: `app.use('/api/shifts', require('./routes/eventDetails'));`)
- Test: `server/routes/eventDetails.test.js` (new; clone the beo.test.js harness pattern: express app + real router + real auth + node http)
- Modify: `ARCHITECTURE.md` (route table), `README.md` (folder tree)

**Interfaces:**
- Consumes: `authorizeEventRead`, `buildEventDetailsPayload` (Task 2); `proposals.menu_print_key` (Task 1); `getSignedUrl` from `server/utils/storage.js`.
- Produces: `GET /api/shifts/:shiftId/event-details` and `GET /api/shifts/:shiftId/menu-print` for the staff UI lane.

- [ ] **Step 1: Write failing tests**

```js
test('event-details by shiftId returns payload + shift_id echo for any staffer', async () => {
  const res = await get(`/api/shifts/${shiftId}/event-details`, otherStaffToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.shift_id, shiftId);
  assert.equal(res.body.client.phone, null); // not assigned
});

test('cancelled shift 404s', async () => {
  const res = await get(`/api/shifts/${cancelledShiftId}/event-details`, staffToken);
  assert.equal(res.status, 404);
});

test('proposal-less legacy shift returns shift-only payload', async () => {
  const res = await get(`/api/shifts/${manualShiftId}/event-details`, staffToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.proposal, null);
  assert.equal(res.body.menu_print, null);
  assert.equal(res.body.shifts.length, 1);
});

test('menu-print download auth: 404 when no file, 403 for unassigned staff', async () => {
  const none = await get(`/api/shifts/${shiftId}/menu-print`, staffToken);
  assert.equal(none.status, 404); // no key uploaded on fixture
  // after UPDATE proposals SET menu_print_key = 'menu-print/<id>/test.pdf' on the fixture:
  const un = await get(`/api/shifts/${shiftId}/menu-print`, otherStaffToken);
  assert.equal(un.status, 403); // unassigned staffer may NOT download
});
// Deliberate coverage stance: the 200 path proxies live R2 (getSignedUrl + fetch),
// so it is NOT asserted in node:test. It is covered by the Task 6/9 manual checks.
```

- [ ] **Step 2: Run to verify failure** (`node -r dotenv/config --test server/routes/eventDetails.test.js` → cannot find module / 404s)

- [ ] **Step 3: Implement `server/routes/eventDetails.js`**

```js
// Shift-keyed staff event-details surface (spec 2026-07-22).
// GET /api/shifts/:shiftId/event-details  — full payload, any staff (redacted).
// GET /api/shifts/:shiftId/menu-print     — R2 proxy download, assigned staff + admin.
const express = require('express');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { beoReadLimiter } = require('../middleware/rateLimiters');
const asyncHandler = require('../middleware/asyncHandler');
const { NotFoundError, PermissionError, ExternalServiceError } = require('../utils/errors');
const { authorizeEventRead, buildEventDetailsPayload } = require('../utils/eventDetailsPayload');
const { getSignedUrl } = require('../utils/storage');

const router = express.Router();

async function loadShift(shiftId) {
  if (!Number.isFinite(shiftId)) throw new NotFoundError('Shift not found.');
  const r = await pool.query(
    `SELECT s.id, s.proposal_id, s.status, s.event_date, s.start_time, s.end_time,
            s.location, s.guest_count, s.event_type, s.event_type_custom, s.client_name,
            s.positions_needed, s.equipment_required, s.supply_run_required,
            s.setup_minutes_before
       FROM shifts s WHERE s.id = $1`, [shiftId]);
  const row = r.rows[0];
  if (!row || row.status === 'cancelled') throw new NotFoundError('Shift not found.');
  return row;
}

router.get('/:shiftId/event-details', auth, beoReadLimiter, asyncHandler(async (req, res) => {
  const shiftId = parseInt(req.params.shiftId, 10);
  const shift = await loadShift(shiftId);

  if (!shift.proposal_id) {
    // Legacy manual shift: brief renders from shift data alone.
    const my = await pool.query(
      `SELECT id, status, position, requested_positions FROM shift_requests
        WHERE shift_id = $1 AND user_id = $2 AND status != 'denied' AND dropped_at IS NULL
        ORDER BY id DESC LIMIT 1`, [shiftId, req.user.id]);
    const mine = my.rows[0] || null;
    const isPrivileged = req.user.role === 'admin' || req.user.role === 'manager';
    return res.json({
      shift_id: shiftId,
      proposal: null,
      client: { name: shift.client_name || null, phone: null },
      package: null, drink_plan: null, shopping_list_status: null,
      addons: [], shift_requests: [], team_roster: [], menu_print: null,
      shifts: [{
        id: shift.id, event_date: shift.event_date, start_time: shift.start_time,
        end_time: shift.end_time, location: shift.location, guest_count: shift.guest_count,
        positions_needed: shift.positions_needed, equipment_required: shift.equipment_required,
        supply_run_required: shift.supply_run_required, setup_minutes_before: shift.setup_minutes_before,
        approved_by_role: {}, cover_requested_at: null, cover_for_first_initial: null,
        my_request_id: mine?.id || null,
        my_request_status: mine?.status || null, my_position: mine?.position || null,
        my_requested_positions: mine?.requested_positions || null,
      }],
      viewer: {
        is_admin: isPrivileged,
        is_assigned: mine?.status === 'approved',
        is_acknowledged: false,
      },
    });
  }

  await authorizeEventRead(req, shift.proposal_id);
  const payload = await buildEventDetailsPayload(req, shift.proposal_id);
  res.json({ ...payload, shift_id: shiftId });
}));

router.get('/:shiftId/menu-print', auth, beoReadLimiter, asyncHandler(async (req, res) => {
  const shiftId = parseInt(req.params.shiftId, 10);
  const shift = await loadShift(shiftId);
  if (!shift.proposal_id) throw new NotFoundError('No menu print file for this event.');

  const isPrivileged = req.user.role === 'admin' || req.user.role === 'manager';
  if (!isPrivileged) {
    const r = await pool.query(
      `SELECT 1 FROM shift_requests sr JOIN shifts s ON s.id = sr.shift_id
        WHERE s.proposal_id = $1 AND sr.user_id = $2
          AND sr.status = 'approved' AND sr.dropped_at IS NULL AND s.status != 'cancelled'
        LIMIT 1`, [shift.proposal_id, req.user.id]);
    if (!r.rowCount) throw new PermissionError('Only assigned staff can download the menu file.');
  }

  const p = await pool.query('SELECT menu_print_key FROM proposals WHERE id = $1', [shift.proposal_id]);
  const key = p.rows[0] && p.rows[0].menu_print_key;
  if (!key) throw new NotFoundError('No menu print file for this event.');
  if (!key.startsWith('menu-print/')) throw new NotFoundError('No menu print file for this event.');

  const url = await getSignedUrl(key);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  let upstream;
  try {
    upstream = await fetch(url, { signal: ac.signal });
  } catch (err) {
    throw new ExternalServiceError('r2', err, 'Menu file is temporarily unavailable.');
  } finally {
    clearTimeout(timer);
  }
  if (!upstream.ok) {
    throw new ExternalServiceError('r2', new Error(`Upstream returned ${upstream.status}`), 'Menu file is temporarily unavailable.');
  }
  const ext = key.split('.').pop() || 'pdf';
  res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="bar-menu-${shift.proposal_id}.${ext}"`);
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.from(await upstream.arrayBuffer()));
}));

module.exports = router;
```

- [ ] **Step 4: Mount in `server/index.js`, run tests green, update ARCHITECTURE.md route table + README tree**

Run: `node -r dotenv/config --test server/routes/eventDetails.test.js` → PASS

- [ ] **Step 5: Commit**

```bash
git add server/routes/eventDetails.js server/routes/eventDetails.test.js server/index.js ARCHITECTURE.md README.md
git commit -m "feat(staff): shift-keyed event-details endpoint + menu print download proxy"
```

### Task 4: Admin menu-print CRUD routes

**Files:**
- Create: `server/routes/proposals/menuPrint.js`
- Modify: `server/routes/proposals/index.js` (add `router.use('/', require('./menuPrint'));` BEFORE the `./getOne` line; getOne must stay mounted last)
- Test: `server/routes/proposals/menuPrint.test.js`
- Modify: `ARCHITECTURE.md` (route table), `README.md` (folder tree)

**Interfaces:**
- Consumes: Task 1 columns; `uploadFile(buffer, filename)` from `server/utils/storage.js`; `isValidImageUpload` from `server/utils/fileValidation.js`.
- Produces: `POST /api/proposals/:id/menu-print` (multipart field `file`), `PATCH /api/proposals/:id/menu-print` (`{not_required: bool}`), `DELETE /api/proposals/:id/menu-print`. All respond `{ menu_print: { status } }`.

- [ ] **Step 1: Failing tests** (clone an existing proposals test harness, e.g. `crud.test.js` pattern; multipart body built by hand with a boundary over node http)

Cases:
```js
// upload PDF magic → 200 {menu_print:{status:'ready'}}; DB key LIKE 'menu-print/<id>/%.pdf'; menu_not_required reset to false
// upload a text buffer → 400 ValidationError (fieldErrors.file)
// oversize upload (MAX_FILE_SIZE + 1 bytes of valid-PDF-magic padding) → non-200 (express-fileupload global limit; accept 400 or 413)
// PATCH not_required:true with no file → 200 {status:'not_required'}
// PATCH not_required:true while a key exists → 409 ConflictError
// DELETE → 200 {status:'pending'}; key NULL in DB
// staff token on any of the three → 403
```

- [ ] **Step 2: Run to verify failure**

Run: `node -r dotenv/config --test server/routes/proposals/menuPrint.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `server/routes/proposals/menuPrint.js`**

```js
// Bar menu print file admin CRUD (spec 2026-07-22). File lands in R2 under
// menu-print/<proposalId>/; replaced/removed keys ORPHAN the old object
// (drink-plan logo precedent; storage.js has no delete).
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { uploadFile } = require('../../utils/storage');
const { isValidImageUpload } = require('../../utils/fileValidation');

const router = express.Router();
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

function menuPrintExt(file) {
  const buf = file && file.data;
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length >= 4 && buf.slice(0, 4).equals(PDF_MAGIC)) return 'pdf';
  if (buf.length >= 3 && buf.slice(0, 3).equals(JPEG_MAGIC)) return 'jpg';
  if (isValidImageUpload(file)) return 'png'; // PNG (JPEG already handled)
  return null;
}

function statusOf(row) {
  if (row.menu_print_key) return 'ready';
  if (row.menu_not_required) return 'not_required';
  return 'pending';
}

async function getProposalRow(id) {
  if (!Number.isFinite(id)) throw new NotFoundError('Proposal not found.');
  const r = await pool.query('SELECT id, menu_print_key, menu_not_required FROM proposals WHERE id = $1', [id]);
  if (!r.rowCount) throw new NotFoundError('Proposal not found.');
  return r.rows[0];
}

router.post('/:id/menu-print', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await getProposalRow(id);
  const file = req.files && req.files.file;
  if (!file) throw new ValidationError({ file: 'Attach the print file.' });
  const ext = menuPrintExt(file);
  if (!ext) throw new ValidationError({ file: 'PDF, PNG, or JPG only.' });
  const key = `menu-print/${id}/${crypto.randomUUID()}.${ext}`;
  await uploadFile(file.data, key);
  await pool.query(
    'UPDATE proposals SET menu_print_key = $1, menu_not_required = false WHERE id = $2',
    [key, id]
  );
  res.json({ menu_print: { status: 'ready' } });
}));

router.patch('/:id/menu-print', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = await getProposalRow(id);
  const notRequired = !!(req.body && req.body.not_required === true);
  if (notRequired && row.menu_print_key) {
    throw new ConflictError('Remove the uploaded file first.');
  }
  await pool.query('UPDATE proposals SET menu_not_required = $2 WHERE id = $1', [id, notRequired]);
  res.json({ menu_print: { status: statusOf({ ...row, menu_not_required: notRequired }) } });
}));

router.delete('/:id/menu-print', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = await getProposalRow(id);
  await pool.query('UPDATE proposals SET menu_print_key = NULL WHERE id = $1', [id]);
  res.json({ menu_print: { status: statusOf({ ...row, menu_print_key: null }) } });
}));

module.exports = router;
```

- [ ] **Step 4: Mount in proposals/index.js, run tests green, update docs**

Run: `node -r dotenv/config --test server/routes/proposals/menuPrint.test.js` → PASS

- [ ] **Step 5: Confirm the proposal payload carries the new columns.** Verified at plan-review time: `getOne.js` selects `p.*`, so `menu_print_key` / `menu_not_required` ride along with NO edit to getOne.js (do not touch it; it is outside this lane's footprint). Just spot-check with a curl or the test harness that `GET /api/proposals/:id` includes both fields.

- [ ] **Step 6: Commit**

```bash
git add server/routes/proposals/menuPrint.js server/routes/proposals/menuPrint.test.js server/routes/proposals/index.js ARCHITECTURE.md README.md
git commit -m "feat(admin): menu print file upload/flag/remove routes"
```

### Task 5: Feed pricing_type + SMS copy reword

**Files:**
- Modify: `server/routes/shifts.queries.js` (STAFF_OPEN_SHIFTS_SQL)
- Modify: `server/utils/smsTemplates.js` (staffBeoNudgeSms, line ~164)
- Test: `server/utils/smsTemplates.test.js` (update expected string)

**Interfaces:**
- Produces: `package_pricing_type` on every staff open-shifts feed row (`'per_guest'` = hosted) for RequestSheet's hosted warning.

- [ ] **Step 1: Feed SQL.** In STAFF_OPEN_SHIFTS_SQL add to the select list `spk.pricing_type AS package_pricing_type,` and add joins after the `drink_plans` join:

```sql
LEFT JOIN proposals pp ON pp.id = s.proposal_id
LEFT JOIN service_packages spk ON spk.id = pp.package_id
```

(Contact columns stay off the feed; only pricing_type rides along.)

- [ ] **Step 2: SMS template.** Replace the template string in `staffBeoNudgeSms`:

```js
return `Event details ready from Dr. Bartender: ${truncated} on ${eventDateLocal}. Tap to review and confirm: ${beoUrl}`;
```

Update the function's doc comment (BEO → event details). Function name and callers unchanged.

- [ ] **Step 3: Assert the new feed column.** `server/routes/shifts.withdraw.test.js` is the suite that actually drives `GET /api/shifts` (staffShiftHandlers.test.js does NOT touch the feed). Add one assertion to an existing feed-reading case there:

```js
assert.ok('package_pricing_type' in feedRow, 'staff feed row carries package_pricing_type');
```

Run: `node -r dotenv/config --test server/routes/shifts.withdraw.test.js`
Expected: PASS with the new assertion.

- [ ] **Step 4: Commit the feed change**

```bash
git add server/routes/shifts.queries.js server/routes/shifts.withdraw.test.js
git commit -m "feat(staff): package_pricing_type on the open-shifts feed"
```

- [ ] **Step 5: Update smsTemplates.test.js expectation, run suite**

Run: `node -r dotenv/config --test server/utils/smsTemplates.test.js` → PASS
Also re-run `node -r dotenv/config --test server/routes/beo.test.js` → PASS (lane-neighbor check).

- [ ] **Step 6: Commit the copy reword separately** (independent feature, separately revertable)

```bash
git add server/utils/smsTemplates.js server/utils/smsTemplates.test.js
git commit -m "copy(sms): BEO nudge says event details"
```

---

## Lane 2: event-details-staff-ui

### Task 6: ShiftDetail rework into Event Details (brief + assigned tiers)

**Files:**
- Modify: `client/src/pages/staff/ShiftDetail.js`
- Modify: `client/src/components/staff/BeoSections.js` (new cards)
- Create: `client/src/components/staff/EventActionArea.js`
- Modify: `README.md` (folder tree)

**Interfaces:**
- Consumes: `GET /api/shifts/:shiftId/event-details` (Task 3 payload: `shifts[]`, `menu_print`, `viewer.is_assigned`, redacted `client.phone`).
- Produces: `EquipmentCard({ equipment, supplyRun })`, `RolesCard({ positionsNeeded, approvedByRole })`, `BarMenuCard({ menuPrint, shiftId })` exported from BeoSections.js; `EventActionArea({ viewer, myShift, shiftId, clientName, onRequest, onWithdraw, onClaimCover, onConfirm, acknowledging, isDrinkPlanFinalized, dropProps })` from EventActionArea.js.

- [ ] **Step 1: Replace the data layer.** Delete `resolveProposal` and the `/shifts` + `/shifts/user/:id/events` lookups (ShiftDetail.js lines ~89-122). Replace `fetchBeo` with:

```js
const fetchDetails = useCallback(async () => {
  if (!Number.isFinite(shiftId)) return;
  setLoading(true);
  setError(null);
  try {
    const [detailsRes, cocktailsRes, mocktailsRes] = await Promise.all([
      api.get(`/shifts/${shiftId}/event-details`),
      api.get('/cocktails').catch(() => ({ data: { cocktails: [] } })),
      api.get('/mocktails').catch(() => ({ data: { mocktails: [] } })),
    ]);
    setBeo(detailsRes.data);
    setDrinkCatalogs({
      cocktails: cocktailsRes.data?.cocktails || [],
      mocktails: mocktailsRes.data?.mocktails || [],
    });
  } catch (err) {
    setError(err?.status === 404 ? 'Shift not found, it may have been cancelled.' : err?.message || 'Could not load this event.');
  } finally {
    setLoading(false);
  }
}, [shiftId]);
```

Derive the shift row from the payload instead of nav state:

```js
const myShift = useMemo(
  () => (Array.isArray(beo?.shifts) ? beo.shifts.find((s) => s.id === shiftId) : null) || null,
  [beo?.shifts, shiftId]
);
```

Every prior `shiftRow` read switches to `myShift` (date, times, setup, position via `my_position`, request status via `my_request_status`). `isMyShiftApproved` becomes `viewer.is_assigned`.

- [ ] **Step 2: Add the new brief cards to BeoSections.js**

```jsx
// Local parser: shifts.equipment_required is TEXT holding a JSON array ('[]').
// (LogisticsTag has a private parseEquipment; it is not exported, so define here.)
function safeParseArray(raw) {
  if (Array.isArray(raw)) return raw.filter((t) => typeof t === 'string' && t.trim());
  if (typeof raw !== 'string') return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((t) => typeof t === 'string' && t.trim()) : [];
  } catch {
    return [];
  }
}

export function EquipmentCard({ equipment, supplyRun }) {
  const list = safeParseArray(equipment);
  if (list.length === 0 && !supplyRun) return null;
  return (
    <div className="sp-card tight">
      <div className="sp-card-head"><div className="sp-card-title">Equipment &amp; supplies</div></div>
      {list.map((item) => (
        <div key={item} className="sp-row" style={{ padding: '0.35rem 0', fontSize: 13 }}>{item}</div>
      ))}
      {supplyRun && (
        <div className="sp-row" style={{ padding: '0.35rem 0', fontSize: 13 }}>
          Supply run required for this event.
        </div>
      )}
      <div style={{ fontSize: 12, color: 'var(--sp-ink-3)', marginTop: 6, lineHeight: 1.5 }}>
        Standard bar kit includes a small handled cooler (about 3 cases of beer plus ice,
        or two 20 lb ice bags). Mats, ice bins, and the tip jar ride inside it. Bring it
        even when the client has coolers.
      </div>
    </div>
  );
}

export function RolesCard({ positionsNeeded, approvedByRole }) { /* pills reusing staffingRoles utils, same math as ShiftsPage rows */ }

export function BarMenuCard({ menuPrint, shiftId }) {
  const [downloading, setDownloading] = React.useState(false);
  if (!menuPrint) return null;
  const [downloadError, setDownloadError] = React.useState(null);
  async function download() {
    setDownloading(true);
    setDownloadError(null);
    try {
      const res = await api.get(`/shifts/${shiftId}/menu-print`, { responseType: 'blob' });
      // Server sends Content-Disposition with the right extension; honor it.
      const cd = res.headers?.['content-disposition'] || '';
      const m = cd.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = m ? m[1] : 'bar-menu.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err?.message || 'Could not download the menu file.');
    } finally {
      setDownloading(false);
    }
  }
  return (
    <div className="sp-card tight">
      <div className="sp-card-head"><div className="sp-card-title">Bar menu</div></div>
      {menuPrint.status === 'ready' && (
        <>
          <button type="button" className="sp-btn sp-btn-sm" onClick={download} disabled={downloading}>
            {downloading ? 'Downloading…' : 'Download print file'}
          </button>
          {downloadError && <div className="sp-modal-error">{downloadError}</div>}
          <div style={{ fontSize: 12.5, color: 'var(--sp-ink-2)', marginTop: 6, lineHeight: 1.55 }}>
            Print the menu and bring it framed (frames will be stocked at the Pilsen storage
            unit). The menu and frame stay with the client after the event. You get a flat $5
            for the print. A clean tablet or iPad on a stand works as an alternative if it is
            a decent size. Framed menus plan around 8x10.
          </div>
        </>
      )}
      {menuPrint.status === 'not_required' && (
        <div style={{ fontSize: 13, color: 'var(--sp-ink-2)' }}>No printed menu for this event.</div>
      )}
      {menuPrint.status === 'pending' && (
        <div style={{ fontSize: 13, color: 'var(--sp-ink-3)' }}>
          Print file not posted yet. Check back closer to the event.
        </div>
      )}
    </div>
  );
}
```

(BarMenuCard needs `import api from '../../utils/api';` at the top of BeoSections.js. RolesCard imports `parsePositionsNeeded, rosterCounts, CANONICAL_LABELS` from `../../utils/staffingRoles` and renders the same `sp-roster-pill` spans ShiftsPage.js lines 430-443 render; copy that JSX.)

- [ ] **Step 3: Create EventActionArea.js.** Move OUT of ShiftDetail.js, unchanged: the drop/cover card JSX (lines ~532-577), the sticky confirm bar JSX (lines ~579-622), `dropTitle/dropSub/dropCta` helpers (lines ~716-734), and render them inside the new component. Add the two new states:

```jsx
// viewerState: 'assigned' | 'pending' | 'waitlisted' | 'browsing'
{viewerState === 'browsing' && (
  <div className="sp-confirm-bar">
    <div className="sp-confirm-bar-msg">
      <strong>Want this shift?</strong> Request it and the lead will review.
    </div>
    <button type="button" className="sp-btn sp-btn-lg sp-btn-primary" onClick={onRequest}>
      {coverNeeded ? 'Cover this' : fullyStaffed ? 'Join waitlist' : 'Request this shift'}
    </button>
  </div>
)}
{(viewerState === 'pending' || viewerState === 'waitlisted') && (
  <div className="sp-confirm-bar">
    <div className="sp-confirm-bar-msg">
      <strong>{viewerState === 'waitlisted' ? 'You are on the waitlist.' : 'Request pending review.'}</strong>
    </div>
    <button type="button" className="sp-btn sp-btn-sm sp-btn-ghost" onClick={onWithdraw} disabled={busy}>
      {viewerState === 'waitlisted' ? 'Leave waitlist' : 'Withdraw'}
    </button>
  </div>
)}
```

`viewerState` derivation in ShiftDetail: `viewer.is_assigned` → assigned; `myShift.my_request_status === 'pending'` → pending or waitlisted (classify with `classifyRequest` exactly like ShiftsPage's PendingRow, lines ~570-577); else browsing. `fullyStaffed`/`coverNeeded` from `myShift` roster math + payload cover flags. Withdraw calls `DELETE /shifts/requests/${myShift.my_request_id}` then refetch. Request opens RequestSheet with a row assembled from `myShift` + `package_pricing_type: beo.package?.pricing_type`; on submitted, refetch. Cover claim posts `/shifts/requests/${shiftId}/claim-cover` (same handler code as ShiftsPage `claimCover`).

- [ ] **Step 4: Rewire the ShiftDetail render.** Section title "Event details" replaces "Banquet Event Order". Card order in the brief: meta grid, EquipmentCard, RolesCard, GratuityTipsCard (moves up, before drinks), then drinks/addons/logistics/custom menu/notes/consult (all now unconditioned on assignment). Assigned-only block: Call client button (only when `client.phone` non-null), TeamRosterCard, ShoppingListCard, BarMenuCard, and EventActionArea (always rendered; it branches internally). Chips: `Details confirmed` / `Awaiting your confirm` / `Details not finalized yet`. Pre-finalize banner copy, exactly per spec: "Details still being finalized. Confirm unlocks once the lead finalizes the plan." Confirm bar copy: "Confirm you've read the event details." / button "Confirm details". Toast: "Event details confirmed. The lead has been notified."

- [ ] **Step 5: Verify net line counts.** `wc -l client/src/pages/staff/ShiftDetail.js` must be BELOW 804. Run `npm run check:filesize` → no new RED.

- [ ] **Step 6: Build gate + visual check**

```bash
cd client && CI=true npx react-scripts build
```
Expected: green. Then local dev run. The dev server is a Claude-managed background process with NO auto-reload: restart it first so lane 1's new endpoints are live. Manual checks, each with its expected outcome:

- Staff dev JWT NOT on the event: full brief renders (date, equipment, roles, gratuity card, drinks); Request bar shows; the Call client button is ABSENT (client.phone is null server-side); Bar menu card absent.
- Same staffer after requesting: pending bar with Withdraw; waitlist variant when every picked role is full (classifyRequest math).
- Assigned staff dev JWT: Call client visible, roster phones visible, Bar menu card downloads the uploaded fixture file, confirm bar gated on finalize exactly as before.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/staff/ShiftDetail.js client/src/components/staff/BeoSections.js client/src/components/staff/EventActionArea.js README.md
git commit -m "feat(staff): event-details page, brief for all staff + assigned extras + on-page request"
```

### Task 7: Hosted-event warning in RequestSheet

**Files:**
- Modify: `client/src/components/staff/RequestSheet.js`

**Interfaces:**
- Consumes: `shift.package_pricing_type` (from the feed row via ShiftsPage, or assembled row via ShiftDetail Task 6).

- [ ] **Step 1: Add hosted gating.** After `transportRequired` (line ~70):

```js
const isHosted = shift?.package_pricing_type === 'per_guest';
const [hostedAck, setHostedAck] = useState(false);
```

Reset `setHostedAck(false)` in the existing open-effect (line ~79). Add to the disable chain (line ~121):

```js
const blockedNoHostedAck = isHosted && !hostedAck;
const submitDisabled = submitting || busy || blockedNoRole || blockedNoAck || blockedNoHostedAck;
```

- [ ] **Step 2: Warning block**, rendered above the transport block:

```jsx
{isHosted && (
  <>
    <div className="sp-cover-banner" style={{ marginTop: '0.6rem' }}>
      <AlertIcon size={14} />
      <span>
        <strong>Hosted event.</strong> Plan for 90 minutes of setup and up to 2.5 hours
        of supply handling. Expect supply pickup and dropoff, and possibly a grocery
        pickup or receiving a delivery. These events are usually handled by management
        and senior staff.
      </span>
    </div>
    <label className="sp-ack-row">
      <input type="checkbox" checked={hostedAck} disabled={submitting}
        onChange={(e) => setHostedAck(e.target.checked)} />
      <span>I understand what hosted events require and I am ready for the supply work.</span>
    </label>
  </>
)}
```

- [ ] **Step 3: Build gate** (`cd client && CI=true npx react-scripts build`) → green. Manual check: a per_guest event's sheet blocks submit until ticked; a fixed-price event shows no banner.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/staff/RequestSheet.js
git commit -m "feat(staff): hosted-event warning + acknowledgment in RequestSheet"
```

### Task 8: Staff-facing BEO copy sweep

**Files:**
- Modify: `client/src/pages/staff/HomePage.js` (line ~143)
- Modify: `client/src/components/staff/ShiftCard.js` (lines ~207-208)
- Modify: `client/src/pages/staff/account/NotificationsSection.js` (lines ~98-99, ~103-104, ~157)

- [ ] **Step 1: Apply the rewords**

- HomePage: `Confirm the {nextShift.client_name || 'event'} event details`
- ShiftCard chips: `Details confirmed` / `Details to confirm` (ShiftsPage's Mine tab renders these THROUGH ShiftCard, so no ShiftsPage.js edit is needed for chips; its footprint entry exists only in case the Task 6 wiring touches it)
- NotificationsSection: label `Event details ready to confirm`, sub `Event details are locked and waiting for my confirm.`; reminder sub `Auto SMS if I have not confirmed upcoming event details.`; critical-path explainer: `Critical-path messages (event details finalized, schedule changes, payday) can't be fully muted.` (ids `beo_finalized` / `beo_reminder_t3` and `CRITICAL_CATEGORIES` untouched)

- [ ] **Step 2: Sweep for leftovers**

Run: `grep -rn "BEO" client/src --include="*.js"` and reword any remaining STAFF-VISIBLE string. Internal ids (`beo_*`), API paths (`/beo/`), and code comments may keep the term; admin-facing strings belong to lane 3.

- [ ] **Step 3: Build gate + commit**

```bash
cd client && CI=true npx react-scripts build
git add client/src/pages/staff/HomePage.js client/src/components/staff/ShiftCard.js client/src/pages/staff/account/NotificationsSection.js
git commit -m "copy(staff): BEO becomes event details everywhere staff-facing"
```

---

## Lane 3: event-details-admin-ui

### Task 9: Admin bar-menu block + link label

**Files:**
- Create: `client/src/components/AdminMenuPrintBlock.js`
- Modify: `client/src/pages/admin/EventDetailPage.js` (link label line ~494; render the block after the `View event details` link, before `EventDetailPlanLogo`)
- Modify: `README.md` (folder tree)

**Interfaces:**
- Consumes: proposal payload fields `menu_print_key` / `menu_not_required` (Task 4 step 5); routes from Task 4.
- Produces: `<AdminMenuPrintBlock proposalId menuPrintKey menuNotRequired onChange />`.

- [ ] **Step 1: Implement the component**

```jsx
import React, { useRef, useState } from 'react';
import api from '../utils/api';

/** Admin upload/flag control for the staff bar-menu print file (spec 2026-07-22). */
export default function AdminMenuPrintBlock({ proposalId, menuPrintKey, menuNotRequired, onChange }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const status = menuPrintKey ? 'ready' : menuNotRequired ? 'not_required' : 'pending';

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange?.();
    } catch (err) {
      setError(err?.fieldErrors?.file || err?.message || 'Could not update the menu file.');
    } finally {
      setBusy(false);
    }
  }

  function upload(file) {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    run(() => api.post(`/proposals/${proposalId}/menu-print`, form));
  }

  return (
    <div className="card" style={{ padding: 'var(--gap)' }}>
      <div className="hstack" style={{ justifyContent: 'space-between' }}>
        <strong>Bar menu print file</strong>
        <span className={'badge ' + (status === 'ready' ? 'badge-success' : 'badge-muted')}>
          {status === 'ready' ? 'Uploaded' : status === 'not_required' ? 'No menu needed' : 'Not posted'}
        </span>
      </div>
      <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg" style={{ display: 'none' }}
        onChange={(e) => upload(e.target.files && e.target.files[0])} />
      <div className="hstack" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || menuNotRequired}
          onClick={() => fileRef.current?.click()}>
          {menuPrintKey ? 'Replace file' : 'Upload file'}
        </button>
        {menuPrintKey && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
            onClick={() => run(() => api.delete(`/proposals/${proposalId}/menu-print`))}>
            Remove
          </button>
        )}
        {!menuPrintKey && (
          <label className="hstack" style={{ gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={menuNotRequired} disabled={busy}
              onChange={(e) => run(() => api.patch(`/proposals/${proposalId}/menu-print`, { not_required: e.target.checked }))} />
            No menu needed for this event
          </label>
        )}
      </div>
      {error && <div className="text-error" style={{ marginTop: 6 }}>{error}</div>}
      <div className="text-muted" style={{ fontSize: 12, marginTop: 6 }}>
        Assigned staff download this from their event details page, print it, and bring it framed.
      </div>
    </div>
  );
}
```

(Match the page's actual class names when wiring in; EventDetailPage's neighboring blocks are the source of truth for `card` / `hstack` / badge classes; adjust to what is actually used there.)

- [ ] **Step 2: Wire into EventDetailPage.** Change `View BEO` to `View event details` (line ~494). Render `<AdminMenuPrintBlock proposalId={proposal.id} menuPrintKey={proposal.menu_print_key} menuNotRequired={proposal.menu_not_required} onChange={loadProposal} />` in the right-hand vstack after that link.

- [ ] **Step 3: Build gate + manual check**

```bash
cd client && CI=true npx react-scripts build
```
Manual (restart the Claude-managed dev server first; no auto-reload): upload a PDF on a dev event, see Uploaded badge; staff side (assigned dev JWT) shows Download and the file round-trips; Remove reverts to Not posted; toggle flips to No menu needed; PATCH-while-file-exists shows the 409 message inline.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/AdminMenuPrintBlock.js client/src/pages/admin/EventDetailPage.js README.md
git commit -m "feat(admin): bar menu print upload block + event details link label"
```

---

## Design-fleet review (2026-07-22)

plan-fidelity, plan-decomposition, plan-feasibility all completed with explicit verdicts. Both blockers fixed in place: the `shifts[]` cover-flags producer/consumer gap (cover LATERAL added to the Task 2 query + legacy branch), and the getOne.js footprint trip (dissolved: getOne selects `p.*`, so Task 4 no longer edits it). All feasibility warnings folded: cancelled-shift test flips 403→404, NaN guards explicitly retained, `safeParseArray` defined, feed assertion moved to shifts.withdraw.test.js, oversize upload case added, spec copy restored verbatim, dev-server restart added to manual checks, download error handling + Content-Disposition filename honored, lane-1 fleet agents named. Accepted as-is: Task 3 keeps the event-details endpoint and download proxy in one checkpoint commit (both live in one file, and lane checkpoints squash to a single commit on main, so the revert unit is the lane either way).

## Self-review notes (done at plan time)

- Spec coverage: ungate+redaction (T2), shift-keyed endpoint + legacy fallback + download (T3), menu CRUD (T4), feed pricing_type + SMS copy (T5), page tiers + cards + on-page actions (T6), hosted warning (T7), copy sweep staff (T8), admin block + label (T9), schema+docs (T1, folded doc steps). Gratuity card move: T6 step 4. Cooler copy: T6 step 2.
- The `pay_cents_estimate` chip is deliberately absent: no server feed supplies it (verified 2026-07-22); adding pay estimates is not in the spec.
- Type consistency: `menu_print.status` values `ready|not_required|pending` used identically in T3/T4/T6/T9; `viewer.is_assigned` produced in T2, consumed in T6; `package_pricing_type` produced in T5, consumed in T7.
