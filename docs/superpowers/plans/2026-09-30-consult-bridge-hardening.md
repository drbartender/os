---
spec: docs/superpowers/specs/2026-09-30-consult-bridge-hardening-design.md
lanes:
  - id: consult-bridge-hardening
    footprint:
      - server/routes/calcom.js                     # prior-uid memory, four known-uid checks (spec 5)
      - server/routes/calcom.test.js                # exists: extend, owns the schema check
      - server/db/schema.sql                        # consults.calcom_prior_event_ids (spec 5.2)
      - server/utils/consultCallChain.js            # dead fn out, one-stop email, notifyClientNoAnswer, placeLeg guards (995 lines at cut, hard cap 1000)
      - server/utils/consultCallChain.test.js       # exists: extend
      - server/utils/emailTemplates.js              # three new banners, one reworded
      - server/utils/emailTemplates.consultCall.test.js
      - server/routes/voiceConsultCall.js           # kill switch, repeat inside Gather, /dialend fallback
      - server/routes/voiceConsultCall.test.js
      - server/routes/voiceLeadCall.js              # /answer TwiML ONLY (spec 6.2)
      - server/routes/voiceLeadCall.test.js
      - server/utils/consultCallReaper.js           # new: both reaper arms (spec 4.3, 4.4)
      - server/utils/consultCallReaper.test.js      # new: takes over the consult reaper tests
      - server/utils/consultCallSweep.js            # runs the reaper every tick
      - server/utils/consultCallSweep.test.js
      - server/utils/vaCallingScheduler.js          # loses the consult reaper
      - server/utils/vaCallingScheduler.test.js
      - server/routes/admin/leadCalls.js            # comment only
      - client/src/utils/consultCallLabel.js        # bridge_unconfirmed label + comment
      - client/src/utils/consultCallLabel.test.js
      - server/index.js                             # ADMIN_PHONE / VA_CELL boot warnings
      - scripts/sensitive-paths.txt                 # the new reaper module
      - .env.example
      - README.md
      - ARCHITECTURE.md
      - .claude/CLAUDE.md
    blockedBy: []
    review: full-fleet   # Cal.com webhook + billed outbound voice; every consult module is sensitive-listed
---

# Consult Call Bridge Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **House override:** this repo executes plans through the lane model (`.claude/CLAUDE.md`): one worktree lane (`npm run worktree:new -- consult-bridge-hardening`), checkpoint commits in-lane, squash merge to main via `scripts/merge-lane.sh`. Task 1 shares no file with Tasks 2 to 6 and may run in parallel with them; Tasks 2 to 6 run in order because they share `consultCallChain.js`, `voiceConsultCall.js` and `emailTemplates.js`. Task 7 runs on main after the merge (the ledger, the walkthroughs file and the board are outside the footprint).

**Goal:** Every consult bridge failure reaches Dallas exactly once, and no repeated Cal.com delivery can duplicate a consult or silence a real one.

**Architecture:** A consult remembers every Cal.com uid it has carried (`calcom_prior_event_ids`), and the webhook treats any known uid as a replay in four places. The chain emails on any stopped sibling and on a failed client-no-answer text; `placeLeg` refuses malformed dial targets and never writes an error message into `detail`. The voice routes honor the kill switch at answer and press-1 and collect a digit during the repeat on both bridges. The stale-chain reaper moves into its own module, gains an unconfirmed-bridge arm, and rides the consult sweep's 60-second tick.

**Tech Stack:** Node 26 / Express 4, raw SQL on Neon Postgres via `pg`, `node:test` for server suites, Jest (react-scripts) for the one client util, Twilio TwiML strings.

**Spec:** `docs/superpowers/specs/2026-09-30-consult-bridge-hardening-design.md`

## Global Constraints

- `server/utils/consultCallChain.js` is 995 lines at lane cut. The pre-commit hook blocks any commit that makes a file over 1000 lines longer than it is at HEAD. Check `wc -l` before every commit that touches it; it must never exceed 1000.
- `scheduled_at` never round-trips through JavaScript (ruling R12): every slot comparison and every slot write stays in SQL.
- Claim-then-call law: a billed or notifying side effect fires only for the winner of a guarded write.
- The lead bridge changes in exactly one place: the `/answer` TwiML in `server/routes/voiceLeadCall.js` (and its test). No other lead file is touched.
- `VA_CELL` never reaches a DB record. Log lines carry `last4` only.
- Server suites share the dev database: run them ONE AT A TIME from the lane root and read the PASS COUNT, not just the fail count. `calcom.test.js` needs `NODE_ENV=test`.
- Copy is verbatim, character for character:
  - off message: `The consult call bridge is turned off. Goodbye.`
  - `unresolved reschedule` banner: `Someone rescheduled using this booker's email and we could not tell which booking moved, so the call for this slot was stopped and will not ring. If this is the slot they moved away from, there is nothing to do. If not, call them at the slot.`
  - `client no answer, no text destination` banner: `The client did not pick up when the bridge called them, and no text destination is configured, so this email is the only alert. Call them back.`
  - `client no answer, text failed` banner: `The client did not pick up when the bridge called them, and the text alert could not be sent, most likely a Twilio failure rather than a setting. Call them back.`
  - `bridge unconfirmed` banner: `Someone pressed 1 on this consult, but Twilio never reported the call to the client, so it most likely never connected. Call them to check.`
  - detail-page label: `pressed 1, bridge unconfirmed`
- Commit messages never contain backticks (bash executes them). Use `git commit -F - <<'MSG'`. Stage explicit paths only.

## Review Focus

1. A replay of the LATEST reschedule with different bytes (its new uid is the consult's current uid) must answer "Already rescheduled", run no tail, and file nothing. Pinned in Task 1.
2. A consult rescheduled twice must hold BOTH prior uids in order, and every earlier event for it must be a replay. Pinned in Task 1.
3. A malformed `ADMIN_PHONE` beside a valid `VA_CELL` must cost three undialed rings and then hop to Zul, never silence and never a Twilio call to the junk value. Pinned in Task 4.
4. A chain parked while the switch is off must stay parked, with no email, when the switch comes back on. Pinned in Task 6.
5. A client no-answer where both the text AND the fallback email fail must still answer Twilio with TwiML. Pinned in Task 3.

---

### Task 0: Cut the lane

- [ ] **Step 1: Create the lane and record it on the board**

```bash
cd /home/drbartender/projects/os
git pull --ff-only
npm run worktree:new -- consult-bridge-hardening
scripts/board-write.sh "In flight" "**consult-bridge-hardening** — cut 2026-09-30 off main: fix list section 0, the consult bridge's silent failures and the duplicate consult. [spec](superpowers/specs/2026-09-30-consult-bridge-hardening-design.md) / [plan](superpowers/plans/2026-09-30-consult-bridge-hardening.md)"
cd /home/drbartender/projects/worktrees/consult-bridge-hardening
wc -l server/utils/consultCallChain.js
```

Expected: the helper reports the node_modules, husky and `.env` links; `wc -l` prints `995`.

---

### Task 1: A consult remembers its prior Cal.com uids (spec 5)

**Files:**
- Modify: `server/db/schema.sql` (after `ALTER TABLE consults ADD COLUMN IF NOT EXISTS booker_phone TEXT;`)
- Modify: `server/routes/calcom.js` (router header, strand-heal, `handleCreated`, `handleCancelled`, `handleRescheduled`)
- Test: `server/routes/calcom.test.js`
- Docs: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: column `consults.calcom_prior_event_ids TEXT[] NOT NULL DEFAULT '{}'`; response texts `Already rescheduled` and `Booking already moved`.

- [ ] **Step 1: Make the suite apply the new DDL, then write the failing tests**

In `server/routes/calcom.test.js`, below `const TEST_SECRET = 'test-cal-secret';`, add:

```js
// consults.calcom_prior_event_ids arrives through schema.sql, which the server
// applies at boot. The suite applies the same statement itself (idempotent and
// additive), so it never depends on the dev server having restarted onto this
// code. Read out of schema.sql rather than restated, so the two cannot drift.
const SCHEMA_SQL = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '../db/schema.sql'), 'utf8'
);
const PRIOR_UIDS_DDL = SCHEMA_SQL.match(
  /ALTER TABLE consults ADD COLUMN IF NOT EXISTS calcom_prior_event_ids[^;]*;/
);
```

Replace the existing `before`:

```js
before(async () => {
  await pool.query("DELETE FROM webhook_events WHERE provider = 'calcom'");
});
```

with:

```js
before(async () => {
  if (PRIOR_UIDS_DDL) await pool.query(PRIOR_UIDS_DDL[0]);
  await pool.query("DELETE FROM webhook_events WHERE provider = 'calcom'");
});
```

Append at the END of the file:

```js
// ─── spec 2026-09-30 section 5: a consult remembers its prior uids ───
// handleRescheduled renames calcom_event_id, so without a memory of the old uid
// every later event naming it looked like a booking never seen: a redelivered
// CREATE filed a duplicate at the abandoned slot, and a superseded RESCHEDULE
// also stopped the real consult through the unresolved-reschedule tail.
const P = `test-prior-${Date.now()}`;

test('prior uids: schema.sql declares the column, and it is NOT NULL with an empty default', async () => {
  assert.ok(PRIOR_UIDS_DDL, 'the ALTER is in schema.sql');
  const { rows } = await pool.query(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'consults'
        AND column_name = 'calcom_prior_event_ids'`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data_type, 'ARRAY');
  assert.equal(rows[0].is_nullable, 'NO');
  assert.match(rows[0].column_default, /'\{\}'/);
});

test('prior uids: an in-place reschedule records the outgoing uid', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  await postCreated({
    uid: `${P}-a1`, startTime: '2027-07-01T15:00:00Z',
    attendees: [{ name: 'CalcomTest PriorA', email: `${P}-a@calcom-test.example` }],
  });
  const res = await postRescheduled({
    uid: `${P}-a2`, startTime: '2027-07-08T15:00:00Z', rescheduleUid: `${P}-a1`,
  });
  assert.match(res.text, /rescheduled in place/i);
  const { rows } = await pool.query(
    'SELECT calcom_prior_event_ids FROM consults WHERE calcom_event_id = $1', [`${P}-a2`]
  );
  assert.deepEqual(rows[0].calcom_prior_event_ids, [`${P}-a1`]);
});

test('prior uids: an identical redelivery of the original CREATE after a reschedule files no duplicate', async () => {
  await cleanupTestRows();
  const router = await buildApp(TEST_SECRET);
  const { calls, spy } = makeTailSpy();
  router.__setCalcomDeps({ consultCallTail: spy });
  const createBody = Buffer.from(JSON.stringify({
    triggerEvent: 'BOOKING_CREATED',
    payload: {
      uid: `${P}-b1`, startTime: '2027-07-01T15:00:00Z',
      attendees: [{ name: 'CalcomTest PriorB', email: `${P}-b@calcom-test.example` }],
    },
  }));
  assert.equal((await signedRequest(createBody, TEST_SECRET)).status, 200);
  await postRescheduled({ uid: `${P}-b2`, startTime: '2027-07-08T15:00:00Z', rescheduleUid: `${P}-b1` });
  calls.length = 0;

  const again = await signedRequest(createBody, TEST_SECRET);
  assert.equal(again.status, 200);
  assert.match(again.text, /already processed/i, 'a booking that moved is not stranded, so the dedupe row stands');
  const n = await pool.query(
    'SELECT COUNT(*)::int n FROM consults WHERE calcom_event_id IN ($1, $2)', [`${P}-b1`, `${P}-b2`]
  );
  assert.equal(n.rows[0].n, 1, 'one consult, at the new slot');
  assert.equal(calls.length, 0, 'no tail ran');
});

test('prior uids: a CREATE for a moved booking with DIFFERENT bytes is already filed, not a new consult', async () => {
  await cleanupTestRows();
  const router = await buildApp(TEST_SECRET);
  const { calls, spy } = makeTailSpy();
  router.__setCalcomDeps({ consultCallTail: spy });
  const attendees = [{ name: 'CalcomTest PriorE', email: `${P}-e@calcom-test.example` }];
  await postCreated({ uid: `${P}-e1`, startTime: '2027-07-01T15:00:00Z', attendees });
  await postRescheduled({ uid: `${P}-e2`, startTime: '2027-07-08T15:00:00Z', rescheduleUid: `${P}-e1` });
  calls.length = 0;

  // A different body hash, so the dedupe never matches and the handler runs.
  const res = await postCreated({
    uid: `${P}-e1`, startTime: '2027-07-01T15:00:00Z', attendees, location: 'redelivered with a new field',
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /already filed/i);
  const n = await pool.query(
    'SELECT COUNT(*)::int n FROM consults WHERE calcom_event_id IN ($1, $2)', [`${P}-e1`, `${P}-e2`]
  );
  assert.equal(n.rows[0].n, 1);
  assert.equal(calls.length, 0);
});

test('prior uids: after two reschedules, every earlier event is a replay that files nothing and stops nothing', async () => {
  await cleanupTestRows();
  const router = await buildApp(TEST_SECRET);
  const { calls, spy } = makeTailSpy();
  router.__setCalcomDeps({ consultCallTail: spy });
  const email = `${P}-c@calcom-test.example`;
  const attendees = [{ name: 'CalcomTest PriorC', email }];
  await postCreated({ uid: `${P}-c1`, startTime: '2027-07-01T15:00:00Z', attendees });
  const firstMove = Buffer.from(JSON.stringify({
    triggerEvent: 'BOOKING_RESCHEDULED',
    payload: { uid: `${P}-c2`, startTime: '2027-07-08T15:00:00Z', rescheduleUid: `${P}-c1`, attendees },
  }));
  assert.match((await signedRequest(firstMove, TEST_SECRET)).text, /rescheduled in place/i);
  await postRescheduled({ uid: `${P}-c3`, startTime: '2027-07-15T15:00:00Z', rescheduleUid: `${P}-c2`, attendees });
  calls.length = 0;

  // The superseded move, byte-identical: the strand-heal path.
  const replay = await signedRequest(firstMove, TEST_SECRET);
  assert.equal(replay.status, 200);
  // The superseded move with different bytes: the handler path.
  const replay2 = await postRescheduled({
    uid: `${P}-c2`, startTime: '2027-07-08T15:00:00Z', rescheduleUid: `${P}-c1`, attendees, note: 'x',
  });
  assert.match(replay2.text, /already rescheduled/i);
  // The LATEST move with different bytes (Review Focus 1).
  const replay3 = await postRescheduled({
    uid: `${P}-c3`, startTime: '2027-07-15T15:00:00Z', rescheduleUid: `${P}-c2`, attendees, note: 'y',
  });
  assert.match(replay3.text, /already rescheduled/i);

  const rows = await pool.query(
    'SELECT calcom_event_id, calcom_prior_event_ids, scheduled_at FROM consults WHERE booker_email = $1', [email]
  );
  assert.equal(rows.rowCount, 1, 'no duplicate at any superseded slot');
  assert.equal(rows.rows[0].calcom_event_id, `${P}-c3`);
  assert.deepEqual(rows.rows[0].calcom_prior_event_ids, [`${P}-c1`, `${P}-c2`], 'both prior uids, in order');
  assert.equal(new Date(rows.rows[0].scheduled_at).toISOString(), '2027-07-15T15:00:00.000Z', 'still at the latest slot');
  assert.equal(calls.length, 0, 'no tail, so nothing was stopped as an unresolved reschedule');
});

test('prior uids: a CANCEL naming a moved-from uid writes nothing and leaves the live consult alone', async () => {
  await cleanupTestRows();
  await buildApp(TEST_SECRET);
  const attendees = [{ name: 'CalcomTest PriorD', email: `${P}-d@calcom-test.example` }];
  await postCreated({ uid: `${P}-d1`, startTime: '2027-07-01T15:00:00Z', attendees });
  await postRescheduled({ uid: `${P}-d2`, startTime: '2027-07-08T15:00:00Z', rescheduleUid: `${P}-d1`, attendees });

  const res = await postCancelled({ uid: `${P}-d1`, startTime: '2027-07-01T15:00:00Z', attendees });
  assert.equal(res.status, 200);
  assert.match(res.text, /already moved/i);
  const rows = await pool.query(
    'SELECT calcom_event_id, status FROM consults WHERE calcom_event_id IN ($1, $2)', [`${P}-d1`, `${P}-d2`]
  );
  assert.equal(rows.rowCount, 1, 'no junk cancelled row at the old uid');
  assert.equal(rows.rows[0].calcom_event_id, `${P}-d2`);
  assert.equal(rows.rows[0].status, 'scheduled', 'the live consult is untouched');
});
```

(`makeTailSpy`, `postCreated`, `postRescheduled` and `postCancelled` are function declarations earlier in the file, so they are hoisted and in scope here.)

- [ ] **Step 2: Run the suite and watch the new tests fail**

Run: `NODE_ENV=test node --test server/routes/calcom.test.js`
Expected: the schema test and all five prior-uid tests FAIL (no column; duplicates filed; `Booking already moved` / `Already rescheduled` never returned). Every pre-existing test still passes.

- [ ] **Step 3: Add the column to schema.sql**

Directly after `ALTER TABLE consults ADD COLUMN IF NOT EXISTS booker_phone TEXT;` insert:

```sql

-- Every Cal.com uid a consult carried before a reschedule (spec 2026-09-30,
-- section 5). handleRescheduled renames calcom_event_id and appends the outgoing
-- uid here in the same statement. calcom.js treats a uid found in EITHER column
-- as already seen, so a redelivered or superseded event can never file a
-- duplicate consult or stop the real one. NOT NULL DEFAULT '{}' backfills every
-- existing row to an empty list.
ALTER TABLE consults ADD COLUMN IF NOT EXISTS calcom_prior_event_ids TEXT[] NOT NULL DEFAULT '{}';
```

- [ ] **Step 4: Add the known-uid predicate to calcom.js**

Below `router.__setCalcomDeps = (d) => { _deps = { ..._deps, ...d }; };` add:

```js

// A consult remembers every Cal.com uid it has carried: handleRescheduled
// renames calcom_event_id and appends the outgoing uid to
// calcom_prior_event_ids. A uid matching EITHER has been seen, so an event
// naming it is a replay, never a new booking (spec 2026-09-30 section 5). A
// FIXED fragment: only $1 is ever bound into it.
const KNOWN_UID_WHERE = 'calcom_event_id = $1 OR $1 = ANY(calcom_prior_event_ids)';
```

- [ ] **Step 5: Gate the strand-heal on the known-uid check**

Replace:

```js
    if (healable && replayUid) {
      const consult = await pool.query(
        'SELECT 1 FROM consults WHERE calcom_event_id = $1 LIMIT 1',
        [replayUid]
      );
      stranded = consult.rowCount === 0;
    }
```

with:

```js
    if (healable && replayUid) {
      // A uid a consult has EVER carried is not stranded. After a reschedule the
      // old uid is absent from calcom_event_id because the booking moved, and
      // reprocessing it filed a duplicate at the abandoned slot.
      const consult = await pool.query(
        `SELECT 1 FROM consults WHERE ${KNOWN_UID_WHERE} LIMIT 1`,
        [replayUid]
      );
      stranded = consult.rowCount === 0;
    }
```

- [ ] **Step 6: Make handleCreated's fast path see prior uids**

Replace:

```js
    // Fast-path: skip if already filed. Perf optimization; the consults
    // ON CONFLICT below is the real correctness boundary.
    const existing = await client.query(
      'SELECT id FROM consults WHERE calcom_event_id = $1',
      [uid]
    );
```

with:

```js
    // Fast-path: skip if already filed. For the CURRENT uid the consults
    // ON CONFLICT below is the real correctness boundary. For a PRIOR uid (the
    // booking has since moved) this check is the ONLY one: the ON CONFLICT keys
    // on the current uid alone, and re-filing would put a duplicate consult at
    // the abandoned slot for the sweep to ring.
    const existing = await client.query(
      `SELECT id FROM consults WHERE ${KNOWN_UID_WHERE} LIMIT 1`,
      [uid]
    );
```

- [ ] **Step 7: Ignore a cancel that names a moved-from uid**

In `handleCancelled`, directly after the `if (!uid) { ... }` block, insert:

```js

  // A uid that a consult carried before a reschedule names a booking that has
  // already moved. The upsert below keys on the CURRENT uid only, so without
  // this it files a junk cancelled consult; it must not touch the live consult
  // either. A current or never-seen uid keeps the upsert unchanged.
  const known = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM consults WHERE calcom_event_id = $1) AS is_current,
            EXISTS (SELECT 1 FROM consults WHERE $1 = ANY(calcom_prior_event_ids)) AS is_prior`,
    [uid]
  );
  if (!known.rows[0].is_current && known.rows[0].is_prior) {
    return res.status(200).send('Booking already moved');
  }
```

- [ ] **Step 8: Short-circuit a replayed reschedule and record the outgoing uid**

In `handleRescheduled`, directly after the `if (!newUid || !newStartTime) { ... }` block, insert:

```js

  // A NEW uid we have already seen means this delivery is a replay: the latest
  // reschedule redelivered, or an OLDER one arriving after a later reschedule
  // renamed its uid away. Re-running an older one fell through to
  // handleCreated, filed a duplicate at the superseded slot, and had the tail
  // stop the client's real consult as an unresolved reschedule.
  const seen = await pool.query(
    `SELECT 1 FROM consults WHERE ${KNOWN_UID_WHERE} LIMIT 1`,
    [newUid]
  );
  if (seen.rowCount > 0) {
    return res.status(200).send('Already rescheduled');
  }
```

In the in-place UPDATE, replace:

```sql
       SET calcom_event_id = $1, scheduled_at = $2, status = 'scheduled',
```

with:

```sql
       SET calcom_event_id = $1, scheduled_at = $2, status = 'scheduled',
           calcom_prior_event_ids = array_append(calcom_prior_event_ids, calcom_event_id),
```

(SET expressions read the PRE-update row, so `calcom_event_id` on the right is the outgoing uid.)

- [ ] **Step 9: Run the suite and watch everything pass**

Run: `NODE_ENV=test node --test server/routes/calcom.test.js`
Expected: every test passes, including `strand-heal: a committed dedupe row with no consult reprocesses on redelivery` (the crash heal for a never-seen uid still works). Read the pass count: it is the old count plus 6.

- [ ] **Step 10: Document the column**

In `ARCHITECTURE.md`, find the `consults` table entry in the Database Schema section (grep `booker_phone`) and add beside it:

```md
- `calcom_prior_event_ids TEXT[] NOT NULL DEFAULT '{}'`: every Cal.com uid the consult carried before a reschedule. `handleRescheduled` appends the outgoing uid in the same UPDATE that renames `calcom_event_id`. `calcom.js` treats a uid in EITHER column as already seen (strand-heal, the CREATE fast path, a replayed RESCHEDULE, a CANCEL of a moved-from uid), so a redelivered or superseded Cal.com event can never file a duplicate consult or stop the real one (spec 2026-09-30).
```

In the webhook section (the bullets that begin `- **Release before the tail**`), add one bullet:

```md
- **Prior uids**: a reschedule renames `calcom_event_id`, so the webhook keeps the outgoing uid in `consults.calcom_prior_event_ids` and answers any event naming a known uid as a replay: the strand-heal only reprocesses a uid no consult has ever carried, `handleCreated` answers `Already filed`, `handleRescheduled` answers `Already rescheduled` before touching anything when its NEW uid is known, and `handleCancelled` answers `Booking already moved` for a uid that is only a prior one.
```

- [ ] **Step 11: Commit**

```bash
git add server/db/schema.sql server/routes/calcom.js server/routes/calcom.test.js ARCHITECTURE.md
git commit -F - <<'MSG'
feat(calcom): a consult remembers its prior Cal.com uids

A redelivered or superseded Cal.com event could file a duplicate consult at an
abandoned slot, and a superseded reschedule also stopped the real one. Any uid
a consult has carried is now a replay: heal, create, reschedule and cancel.
MSG
```

---

### Task 2: Room in the chain file, and a single stopped sibling emails (spec 4.1, 4.5)

**Files:**
- Modify: `server/utils/consultCallChain.js` (delete `fileDialCapTrip`; the sibling email gate)
- Modify: `server/utils/emailTemplates.js` (the `unresolved reschedule` banner and its comment)
- Modify: `server/routes/admin/leadCalls.js` (comment only)
- Modify: `client/src/utils/consultCallLabel.js` (comment only)
- Test: `server/utils/consultCallChain.test.js`, `server/utils/emailTemplates.consultCall.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `consultCallTail` emails once whenever `marked.rowCount > 0`.

- [ ] **Step 1: Update the tests to the new behavior**

In `server/utils/consultCallChain.test.js`, test `tail: an unresolved reschedule marks only future scheduled siblings on the RAW booker email (R2)`, replace:

```js
  assert.equal(emails.length, 0, 'sibling marking is silent');
```

with:

```js
  // One stopped row emails too (spec 2026-09-30 section 4.1): it is equally the
  // booker moving their own slot and a stranger stopping a client's only real
  // consult, and nothing here can tell those apart.
  assert.equal(emails.length, 1, 'a single stopped sibling emails once');
  assert.ok(emails[0].subject.includes('unresolved reschedule'), emails[0].subject);
```

Rename the test `tail: stopping MORE than one sibling emails once, because that is the ambiguous case` to `tail: stopping several siblings still sends ONE email, never one per row`, and replace its opening comment (the five lines beginning `// The only path in this feature`) with:

```js
  // However many siblings are stopped, the email count stays at one.
```

In `server/utils/emailTemplates.consultCall.test.js`, in the `banners` object, replace the `'unresolved reschedule'` entry with:

```js
    'unresolved reschedule': "Someone rescheduled using this booker's email and we could not tell which booking moved, so the call for this slot was stopped and will not ring. If this is the slot they moved away from, there is nothing to do. If not, call them at the slot.",
```

In the file header comment, on the line `// failed), and an unresolved reschedule that stopped more than one of a`, replace `stopped more than one of a` with `stopped any of a`.

- [ ] **Step 2: Run both suites and watch the updated assertions fail**

Run: `node --test server/utils/consultCallChain.test.js`
Expected: the R2 test FAILS (`emails.length` is 0). Everything else passes.

Run: `node --test server/utils/emailTemplates.consultCall.test.js`
Expected: `the banner tells the reader what to do, per reason` FAILS on `unresolved reschedule`.

- [ ] **Step 3: Delete the dead helper**

In `server/utils/consultCallChain.js`, delete the whole `fileDialCapTrip` block: the JSDoc beginning `/**\n * File a terminal spend-cap refusal and tell a human, at most once per window.` through the function's closing `}`, and one of the two blank lines on each side so exactly one blank line remains between `fileMissedWindow`'s closing `}` and the `openChain` JSDoc. Confirm it is dead first:

Run: `grep -rn "fileDialCapTrip" server client/src`
Expected: no output after the deletion (before it, only the definition).

- [ ] **Step 4: Email on any stopped sibling**

In `consultCallTail`, replace:

```js
      // This is the ONLY path in the feature that turns a consult that would
      // have rung into one that silently will not, so more than one row gets a
      // human. One row is the ordinary case, the booker moving their single
      // upcoming slot, and stays a log line. Two or more means at least one
      // separate, legitimate booking was stopped too, and nothing else watches
      // that. Behavior is unchanged (spec 4.2 marks them all either way): only
      // the visibility is raised.
      //
      // ONE email, not one per row, and the bound matters: the Cal.com booking
      // page is PUBLIC and these rows are inserted outside the daily cap, so a
      // per-row loop would be a Resend-quota amplifier reachable from the open
      // internet. The banner names the booker's whole set rather than a count,
      // and the log line above carries the count.
      if (marked.rowCount > 1) {
```

with:

```js
      // This is the ONLY path in the feature that turns a consult that would
      // have rung into one that silently will not, so ANY stopped row gets a
      // human (spec 2026-09-30 section 4.1). One row used to stay a log line on
      // the theory that it was the booker moving their own slot, but one row is
      // equally a stranger booking with this client's email and stopping their
      // only real consult, and nothing here can tell the two apart.
      //
      // ONE email, not one per row, and the bound matters: the Cal.com booking
      // page is PUBLIC and these rows are inserted outside the daily cap, so a
      // per-row loop would be a Resend-quota amplifier reachable from the open
      // internet. The log line above carries the count.
      if (marked.rowCount > 0) {
```

- [ ] **Step 5: Reword the banner**

In `server/utils/emailTemplates.js`, replace:

```js
  // The one path in the whole feature that turns a consult that WOULD have rung
  // into one that silently will not. Only sent when more than one row was
  // stopped, which is the case where at least one of them was a separate,
  // legitimate booking rather than the slot the booker just moved.
  ['unresolved reschedule', 'A reschedule named a booking we could not match, so this consult and every other upcoming consult for this booker were stopped and will not ring. Call them to confirm which slot is real.'],
```

with:

```js
  // The one path in the whole feature that turns a consult that WOULD have rung
  // into one that silently will not. Sent whenever at least one row was stopped
  // (spec 2026-09-30 section 4.1): the chain cannot tell the booker moving their
  // own slot from someone else's booking stopping a real one.
  ['unresolved reschedule', "Someone rescheduled using this booker's email and we could not tell which booking moved, so the call for this slot was stopped and will not ring. If this is the slot they moved away from, there is nothing to do. If not, call them at the slot."],
```

- [ ] **Step 6: Correct the two comments that describe the old gate**

In `server/routes/admin/leadCalls.js`, replace the five comment lines from `// attention item on every routine reschedule. The split we chose instead:` through `// write side owes this case a status of its own, tracked in the backlog.` with:

```js
// attention item on every routine reschedule. The split we chose instead:
// consultCallChain.js emails once whenever it stops a row (spec 2026-09-30
// section 4.1), and the client labels the details apart on the detail pages
// (consultCallLabel.js) so no browsing surface calls a live booking cancelled.
// A status of its own for this case was considered and decided against on
// 2026-09-30: the email closed the silence, and a rename changes no behavior.
```

In `client/src/utils/consultCallLabel.js`, in the `rescheduled_unresolved` note, replace the seven comment lines from `//                           have rung into one that silently will not: the` through `//                           instruction rather than just a fact.` with:

```js
//                           have rung into one that will not: the client is
//                           still expecting a call and nothing will ring. The
//                           chain emails once whenever it stops a row (spec
//                           2026-09-30), but the row has no needs-attention
//                           item, so this line is its only browsing surface,
//                           which is why it is the one that carries an
//                           instruction rather than just a fact.
```

- [ ] **Step 7: Run both suites and confirm the size**

Run: `node --test server/utils/consultCallChain.test.js`
Expected: all pass, with the same total as the Step 2 run (no tests added; the R2 test now passes).

Run: `node --test server/utils/emailTemplates.consultCall.test.js`
Expected: all pass.

Run: `wc -l server/utils/consultCallChain.js`
Expected: about 964, and certainly below 995.

- [ ] **Step 8: Commit**

```bash
git add server/utils/consultCallChain.js server/utils/consultCallChain.test.js server/utils/emailTemplates.js server/utils/emailTemplates.consultCall.test.js server/routes/admin/leadCalls.js client/src/utils/consultCallLabel.js
git commit -F - <<'MSG'
fix(consult call): a single stopped consult emails too

An unresolved reschedule that stopped exactly one of a booker's consults told
nobody, and one row is also what a stranger stopping a client's only real
consult looks like. Removes the dead fileDialCapTrip to make room in the file.
MSG
```

---

### Task 3: A failed client-no-answer text becomes the email (spec 4.2)

**Files:**
- Modify: `server/utils/consultCallChain.js` (new `notifyClientNoAnswer`, exported)
- Modify: `server/routes/voiceConsultCall.js` (`/dialend`, the import, `_deps`)
- Modify: `server/utils/emailTemplates.js` (two banners, the reasons JSDoc)
- Test: `server/utils/consultCallChain.test.js`, `server/routes/voiceConsultCall.test.js`, `server/utils/emailTemplates.consultCall.test.js`

**Interfaces:**
- Consumes: `sendMissedText({ attemptId, kind })` returning `'sent' | 'no_destination' | 'no_attempt' | 'send_failed'`; `sendChainEmail({ attemptId, reason })`.
- Produces: `notifyClientNoAnswer({ attemptId }) => Promise<void>`, never rejects. Email reasons `client no answer, no text destination` and `client no answer, text failed`.

- [ ] **Step 1: Write the failing chain tests**

In `server/utils/consultCallChain.test.js`, directly after the last `sendMissedText:` test (`never throws, and each failure reports its OWN reason`), add:

```js
// ─── notifyClientNoAnswer (spec 2026-09-30 section 4.2) ──────────

test('notifyClientNoAnswer: a sent text sends no email', async () => {
  const { attemptId } = await makeChainRow('cna-sent', { attemptStatus: 'connected', nextRingOffsetSec: null });
  await chain.notifyClientNoAnswer({ attemptId });
  assert.equal(texts.length, 1);
  assert.match(texts[0].body, /^Consult client did not answer:/);
  assert.equal(emails.length, 0);
});

test('notifyClientNoAnswer: a text that cannot go out becomes the one email, naming why', async () => {
  const { attemptId } = await makeChainRow('cna-fail', { attemptStatus: 'connected', nextRingOffsetSec: null });

  await withEnv({ VM_TEXT_DESTINATION: null, ADMIN_PHONE: null },
    () => chain.notifyClientNoAnswer({ attemptId }));
  assert.equal(texts.length, 0);
  assert.equal(emails.length, 1);
  assert.ok(emails[0].subject.includes('client no answer, no text destination'), emails[0].subject);

  chain.__setDeps({ sendSMS: async () => { throw new Error('twilio down'); } });
  await chain.notifyClientNoAnswer({ attemptId });
  assert.equal(emails.length, 2);
  assert.ok(emails[1].subject.includes('client no answer, text failed'), emails[1].subject);
});

test('notifyClientNoAnswer: never rejects, even when the fallback email fails too (Review Focus 5)', async () => {
  const { attemptId } = await makeChainRow('cna-boom', { attemptStatus: 'connected', nextRingOffsetSec: null });
  chain.__setDeps({
    sendSMS: async () => { throw new Error('twilio down'); },
    notifyAdminCategory: async () => { throw new Error('resend down'); },
  });
  await assert.doesNotReject(chain.notifyClientNoAnswer({ attemptId }));
  await assert.doesNotReject(chain.notifyClientNoAnswer(null));
  await assert.doesNotReject(chain.notifyClientNoAnswer());
});
```

- [ ] **Step 2: Point the route tests at the new dependency**

In `server/routes/voiceConsultCall.test.js`:

In `beforeEach`, replace:

```js
    // 'sent', not true: sendMissedText returns a discriminated string now, and a
    // boolean stub could not express a failure to a future consumer in this route.
    sendMissedText: async (args) => { textCalls.push(args); return 'sent'; },
```

with:

```js
    // The route hands the whole text-or-email decision to the chain (spec
    // 2026-09-30 section 4.2), so the stub records the call and nothing more.
    notifyClientNoAnswer: async (args) => { textCalls.push(args); },
```

Replace every `assert.deepEqual(textCalls, [{ attemptId, kind: 'client_no_answer' }]);` (two places, in the `/dialend on a no-answer latches once...` and `/dialend latches on the column...` tests) with:

```js
  assert.deepEqual(textCalls, [{ attemptId }]);
```

In `every route answers 200 when a dependency rejects`, replace `sendMissedText: boom,` with `notifyClientNoAnswer: boom,`. In `a non-Error rejection still answers TwiML`, replace `sendMissedText: reject,` with `notifyClientNoAnswer: reject,`.

- [ ] **Step 3: Add the two banners to the template test**

In `server/utils/emailTemplates.consultCall.test.js`, add to `REASONS`:

```js
  'client no answer, no text destination',
  'client no answer, text failed',
```

and to the `banners` object:

```js
    'client no answer, no text destination': 'The client did not pick up when the bridge called them, and no text destination is configured, so this email is the only alert. Call them back.',
    'client no answer, text failed': 'The client did not pick up when the bridge called them, and the text alert could not be sent, most likely a Twilio failure rather than a setting. Call them back.',
```

- [ ] **Step 4: Run the three suites and watch them fail**

Run, one at a time:
- `node --test server/utils/consultCallChain.test.js` (Expected: the three new tests FAIL with `chain.notifyClientNoAnswer is not a function`.)
- `node --test server/routes/voiceConsultCall.test.js` (Expected: the two `/dialend` latch tests FAIL because `textCalls` stays empty.)
- `node --test server/utils/emailTemplates.consultCall.test.js` (Expected: the two new banner checks FAIL.)

- [ ] **Step 5: Implement notifyClientNoAnswer**

In `server/utils/consultCallChain.js`, directly after `finishMissed`'s closing `}`, add:

```js

// The client-no-answer twin of MISSED_TEXT_EMAIL_REASON, with its own banners:
// the client not picking up and nobody on our side answering need different next steps.
const CLIENT_NO_ANSWER_EMAIL_REASON = new Map([
  ['no_destination', 'client no answer, no text destination'],
  ['send_failed', 'client no answer, text failed'],
  ['no_attempt', 'client no answer, text failed'],
]);

/**
 * The bridged client did not pick up: text Dallas their number, and turn a text
 * that could not go out into the one email (spec 2026-09-30 section 4.2). Caller
 * must be the /dialend latch winner. Never throws: both helpers swallow.
 */
async function notifyClientNoAnswer(opts) {
  const { attemptId } = opts || {};
  const outcome = await sendMissedText({ attemptId, kind: 'client_no_answer' });
  if (outcome === 'sent') return;
  await sendChainEmail({ attemptId, reason: CLIENT_NO_ANSWER_EMAIL_REASON.get(outcome) || 'client no answer, text failed' });
}
```

In `module.exports`, after `sendMissedText,` add `notifyClientNoAnswer,`.

- [ ] **Step 6: Use it from /dialend**

In `server/routes/voiceConsultCall.js`, replace the import:

```js
const {
  onLegTerminal, guardStillScheduled, sendMissedText, MAX_ADMIN_RINGS,
} = require('../utils/consultCallChain');
```

with:

```js
const {
  onLegTerminal, guardStillScheduled, notifyClientNoAnswer, MAX_ADMIN_RINGS,
} = require('../utils/consultCallChain');
```

Replace:

```js
let _deps = { isValidTwilioRequest, pool, onLegTerminal, guardStillScheduled, sendMissedText };
```

with:

```js
let _deps = { isValidTwilioRequest, pool, onLegTerminal, guardStillScheduled, notifyClientNoAnswer };
```

In `/dialend`, replace:

```js
    // Text-exactly-once law: only the latch winner notifies. Twilio delivers
    // this callback at-least-once.
    if (latched.rowCount === 1) {
      await _deps.sendMissedText({ attemptId, kind: 'client_no_answer' });
    }
```

with:

```js
    // Text-exactly-once law: only the latch winner notifies. Twilio delivers
    // this callback at-least-once. A text that cannot go out becomes the one
    // email inside notifyClientNoAnswer (spec 2026-09-30 section 4.2); it used
    // to be discarded here, so that miss told nobody.
    if (latched.rowCount === 1) {
      await _deps.notifyClientNoAnswer({ attemptId });
    }
```

- [ ] **Step 7: Add the banners**

In `server/utils/emailTemplates.js`, inside `CONSULT_CALL_BANNERS`, directly after the `'missed, text failed'` entry, add:

```js
  // The client leg's own pair (spec 2026-09-30 section 4.2): Dallas or Zul DID
  // answer and press 1, and it was the client who did not pick up.
  ['client no answer, no text destination', 'The client did not pick up when the bridge called them, and no text destination is configured, so this email is the only alert. Call them back.'],
  ['client no answer, text failed', 'The client did not pick up when the bridge called them, and the text alert could not be sent, most likely a Twilio failure rather than a setting. Call them back.'],
```

In the `consultCallAdmin` JSDoc `@param {string} args.reason one of:` list, add `'client no answer, no text destination', 'client no answer, text failed',` after `'missed, text failed',`.

- [ ] **Step 8: Run the three suites, then check the size**

Run, one at a time, the same three commands as Step 4.
Expected: all pass; the chain suite's pass count is 3 higher than at the end of Task 2.

Run: `wc -l server/utils/consultCallChain.js`
Expected: at most 985.

- [ ] **Step 9: Commit**

```bash
git add server/utils/consultCallChain.js server/utils/consultCallChain.test.js server/routes/voiceConsultCall.js server/routes/voiceConsultCall.test.js server/utils/emailTemplates.js server/utils/emailTemplates.consultCall.test.js
git commit -F - <<'MSG'
fix(consult call): a client no-answer text that fails becomes the email

The /dialend text result was discarded, so with no text destination or a
Twilio failure a client who never picked up was reported to nobody.
MSG
```

---

### Task 4: placeLeg refuses malformed targets and never stores an error message (spec 6.3, 6.4)

**Files:**
- Modify: `server/utils/consultCallChain.js` (`placeLeg`)
- Modify: `server/index.js` (boot warnings)
- Test: `server/utils/consultCallChain.test.js`

**Interfaces:**
- Consumes: `STRICT_E164` (already in the file), `onLegTerminal`'s existing `create_failed` path.
- Produces: detail value `invalid_dial_target`; `placeLeg` returns `false` without calling `placeBridgedCall` for a malformed target.

- [ ] **Step 1: Write the failing tests**

In `server/utils/consultCallChain.test.js`, directly after `advanceChain: a ring 1 create throw records create_failed and re-arms with ring 2 timing`, add:

```js
// ─── placeLeg guards (spec 2026-09-30 sections 6.3 and 6.4) ──────

test('placeLeg: an error with no code never writes its message, so VA_CELL stays out of the database', async () => {
  const { attemptId } = await makeChainRow('scrub-va');
  chain.__setDeps({
    placeBridgedCall: async () => { throw new Error(`Call to ${VA_CELL} could not be created`); },
  });
  await withEnv({ ADMIN_PHONE: null }, () => chain.advanceChain({ attemptId }));
  const row = await rowOf(attemptId);
  assert.equal(row.va_call_status, 'create_failed');
  assert.equal(row.detail, 'create_failed', 'a fixed word, never err.message');
  assert.ok(!String(row.detail).includes('+63'), 'the dialed number never reaches detail');
});

test('placeLeg: a malformed ADMIN_PHONE is never dialed; three undialed rings, then the hop to Zul (Review Focus 3)', async () => {
  const { attemptId } = await makeChainRow('bad-admin-target');
  await withEnv({ ADMIN_PHONE: '312-555-0142' }, async () => {
    await chain.advanceChain({ attemptId });
    let row = await rowOf(attemptId);
    assert.equal(placed.length, 0, 'Twilio never sees the malformed number');
    assert.equal(row.admin_call_status, 'create_failed');
    assert.equal(row.detail, 'invalid_dial_target');
    assert.equal(row.status, 'pending', 'the existing failed-leg path re-arms the next ring');
    assert.equal(row.admin_ring, 1);
    assert.equal(await ringOffsetExact(attemptId, 60), true);

    await chain.advanceChain({ attemptId });
    await chain.advanceChain({ attemptId });
    row = await rowOf(attemptId);
    assert.equal(row.admin_ring, 3);
    assert.equal(row.status, 'calling_va', 'after ring 3 the chain hops to Zul');
  });
  assert.equal(placed.length, 1, 'the only call placed is the Zul leg');
  assert.equal(placed[0].to, VA_CELL);
});

test('placeLeg: a malformed VA_CELL is never dialed and the chain ends in the call-failed email', async () => {
  const { attemptId } = await makeChainRow('bad-va-target');
  await withEnv({ ADMIN_PHONE: null, VA_CELL: '0917 123 4567' }, () => chain.advanceChain({ attemptId }));
  assert.equal(placed.length, 0);
  const row = await rowOf(attemptId);
  assert.equal(row.status, 'failed');
  assert.equal(row.va_call_status, 'create_failed');
  assert.equal(row.detail, 'invalid_dial_target');
  assert.equal(emails.length, 1);
  assert.ok(emails[0].subject.includes('call failed'), emails[0].subject);
});
```

(`makeChainRow`'s consult sits two hours out, and `advanceChain` does not check `next_ring_at`, so calling it three times in a row walks rings 1 to 3 without waiting. `VA_CELL` is the suite's `+639171234567`.)

- [ ] **Step 2: Run and watch them fail**

Run: `node --test server/utils/consultCallChain.test.js`
Expected: the scrub test FAILS (`detail` holds the message); both target tests FAIL (`placed.length` is not 0).

- [ ] **Step 3: Guard placeLeg**

In `placeLeg`, directly after `const ringParam = isAdmin ? [ring] : [];` add:

```js
  // Dial-target check (spec 2026-09-30 section 6.4), VERBATIM so what passes is
  // exactly what Twilio dials. Malformed = a failed leg, never "unset" (a quiet skip).
  if (!STRICT_E164.test(String(to || ''))) {
    await _deps.pool.query(
      `UPDATE consult_call_attempts SET ${statusCol} = 'create_failed', detail = $2, updated_at = NOW()
        WHERE id = $1${ringGuard}`,
      [attemptId, 'invalid_dial_target', ...ringParam]
    ).catch(() => {});
    console.error(`[consultCall] ${leg} dial target is not strict E.164; leg not placed for attempt ${attemptId}`);
    return false;
  }
```

In `placeLeg`'s catch, replace:

```js
      [attemptId, String((err && (err.code || err.message)) || 'create_failed').slice(0, 200), ...ringParam]
```

with:

```js
      // err.code or a fixed word, NEVER err.message (it can carry VA_CELL).
      [attemptId, String((err && err.code) || (err && err.message === 'sid_unpersistable' ? 'sid_unpersistable' : 'create_failed')).slice(0, 200), ...ringParam]
```

In the `placeLeg` JSDoc, replace ` * @param {string} args.to ADMIN_PHONE or VA_CELL, dialed VERBATIM (dial-target law)` with ` * @param {string} args.to ADMIN_PHONE or VA_CELL, format-checked then dialed VERBATIM`.

- [ ] **Step 4: Run and confirm the size**

Run: `node --test server/utils/consultCallChain.test.js`
Expected: all pass, pass count 3 higher than after Task 3. The existing `advanceChain: a ring 1 create throw...` test still passes (`err.code = 21211` is still stored).

Run: `wc -l server/utils/consultCallChain.js`
Expected: at most 1000. If it is over, shorten comments you added in Tasks 3 and 4 until it is not; never touch behavior to make room.

- [ ] **Step 5: Boot warnings**

In `server/index.js`, directly after the `CONSULT_CALLER_ID` block's closing `}`, add:

```js

// The consult bridge's two dial targets (spec 2026-09-30 section 6.4). placeLeg
// refuses a value that is not strict E.164 and records that leg as failed, so a
// Render typo costs rings instead of dialing junk; this makes the typo visible
// at boot. Tested verbatim, like placeLeg. UNSET stays silent: leaving either
// one unset is a real configuration. The value itself is never logged.
for (const key of ['ADMIN_PHONE', 'VA_CELL']) {
  const value = process.env[key];
  if (value && !/^\+[1-9]\d{6,14}$/.test(value)) {
    const msg = `[consultCall] ${key} is set but not strict E.164; the consult bridge will record that leg as failed instead of dialing it`;
    console.warn(msg);
    try {
      const Sentry = require('@sentry/node');
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureMessage(msg, { level: 'warning', tags: { component: 'startup', subsystem: 'consult-call' } });
      }
    } catch (_) { /* sentry optional in dev */ }
  }
}
```

Verify it parses: `node --check server/index.js` (Expected: no output.)

- [ ] **Step 6: Commit**

```bash
git add server/utils/consultCallChain.js server/utils/consultCallChain.test.js server/index.js
git commit -F - <<'MSG'
fix(consult call): format-check both dial targets; never store an error message

A malformed ADMIN_PHONE or VA_CELL is now recorded as a failed leg without
calling Twilio, with a boot warning, and a failed leg stores the Twilio code or
a fixed word so Zul's number can never reach the attempt row.
MSG
```

---

### Task 5: The kill switch covers answer and press-1; press-1 works during the repeat (spec 6.1, 6.2)

**Files:**
- Modify: `server/routes/voiceConsultCall.js` (`/answer`, `/digit`)
- Modify: `server/routes/voiceLeadCall.js` (`/answer` TwiML only)
- Test: `server/routes/voiceConsultCall.test.js`, `server/routes/voiceLeadCall.test.js`

**Interfaces:**
- Consumes: `isEnabled()` exported by `consultCallChain.js`.
- Produces: the off message TwiML; both bridges' `/answer` with both readings inside `<Gather>`.

- [ ] **Step 1: Write the failing consult route tests**

In `server/routes/voiceConsultCall.test.js`, add `'CONSULT_CALL_ENABLED'` to `ENV_KEYS`, and in `before` add `delete process.env.CONSULT_CALL_ENABLED;` after `delete process.env.VA_CALL_TIME_LIMIT_SEC;`.

Replace the test `/answer speaks the booker and the slot inside a Gather, then repeats once and hangs up` with:

```js
test('/answer puts BOTH readings inside the Gather, so a 1 during the repeat is collected (spec 2026-09-30 6.2)', async () => {
  const { attemptId } = await makeChain('answer');
  const res = await post(`/api/voice/consult/answer?attempt=${attemptId}&leg=admin&ring=1&play=1`);
  assert.equal(res.status, 200);
  assert.match(res.body, /<Gather numDigits="1" timeout="10" method="POST"/);
  assert.ok(res.body.includes(`digit?attempt=${attemptId}&amp;leg=admin&amp;ring=1&amp;play=1`), res.body);
  const gather = (res.body.match(/<Gather[^>]*>([\s\S]*?)<\/Gather>/) || [])[1] || '';
  const says = gather.match(new RegExp(`Potion planning call with Sarah M, booked for ${SPOKEN_SLOT}\\.`, 'g')) || [];
  assert.equal(says.length, 2, 'the reading and its one repeat both sit inside the Gather');
  assert.match(gather, /<\/Say><Pause length="1"\/><Say>/, 'a short pause between the two readings');
  assert.match(res.body, /Press 1 to call them now\. Press 9 to hear this again\./);
  assert.ok(res.body.endsWith('</Gather><Hangup/></Response>'), 'nothing but the hangup after the Gather');
});
```

Directly after it, add:

```js
test('/answer with the kill switch off says so and reads no briefing (spec 2026-09-30 6.1)', async () => {
  const { attemptId } = await makeChain('answer-off');
  process.env.CONSULT_CALL_ENABLED = 'false';
  let res;
  try {
    res = await post(`/api/voice/consult/answer?attempt=${attemptId}&leg=admin&ring=1&play=1`);
  } finally {
    delete process.env.CONSULT_CALL_ENABLED;
  }
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('<Say>The consult call bridge is turned off. Goodbye.</Say><Hangup/>'), res.body);
  assert.doesNotMatch(res.body, /<Gather/);
  assert.doesNotMatch(res.body, /Potion planning call/);
});
```

Directly after `/digit press 1 on the admin leg claims the bridge and dials the booker from the 1922`, add:

```js
test('/digit press 1 with the kill switch off claims and dials nothing, before any other check (spec 2026-09-30 6.1)', async () => {
  const { attemptId } = await makeChain('digit-off');
  process.env.CONSULT_CALL_ENABLED = 'false';
  let res;
  try {
    res = await post(`/api/voice/consult/digit?attempt=${attemptId}&leg=admin&ring=1`, { Digits: '1' });
  } finally {
    delete process.env.CONSULT_CALL_ENABLED;
  }
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('The consult call bridge is turned off. Goodbye.'), res.body);
  assert.doesNotMatch(res.body, /<Dial/);
  assert.equal(guardCalls.length, 0, 'the switch is checked before the still-scheduled guard');
  const row = await rowOf(attemptId);
  assert.equal(row.status, 'calling_admin', 'nothing was claimed');
  assert.equal(row.answered_by, null);
});
```

- [ ] **Step 2: Update the lead route test**

In `server/routes/voiceLeadCall.test.js`, replace the test `/answer plays the Gather-wrapped briefing with one automatic repeat` with:

```js
test('/answer puts BOTH readings inside the Gather, so a 1 during the repeat is collected (spec 2026-09-30 6.2)', async () => {
  const attemptId = await makeAttempt(await makeLead('answer'));
  const res = await post(`/api/voice/lead/answer?attempt=${attemptId}&leg=admin`);
  assert.equal(res.status, 200);
  assert.match(res.body, /<Gather numDigits="1" timeout="10"/);
  assert.ok(res.body.includes(`digit?attempt=${attemptId}&amp;leg=admin&amp;play=1`), res.body);
  const gather = (res.body.match(/<Gather[^>]*>([\s\S]*?)<\/Gather>/) || [])[1] || '';
  const says = gather.match(/New Thumbtack lead: Sarah M/g) || [];
  assert.equal(says.length, 2, 'the reading and its one repeat both sit inside the Gather');
  assert.match(gather, /<\/Say><Pause length="1"\/><Say>/);
  assert.ok(res.body.endsWith('</Gather><Hangup/></Response>'), 'nothing but the hangup after the Gather');
});
```

- [ ] **Step 3: Run both suites and watch the new tests fail**

Run: `node --test server/routes/voiceConsultCall.test.js`
Expected: the Gather test and both switch-off tests FAIL.

Run: `node --test server/routes/voiceLeadCall.test.js`
Expected: the Gather test FAILS.

- [ ] **Step 4: Kill switch and TwiML on the consult route**

In `server/routes/voiceConsultCall.js`, add `isEnabled,` to the `consultCallChain` import (after `notifyClientNoAnswer,`).

Directly after `apologyTwiml`, add:

```js

/**
 * The kill switch is off (spec 2026-09-30 section 6.1): say so and dial
 * nothing. The leg's own status callback then files the chain skipped_disabled
 * through the existing onLegTerminal and advanceChain paths.
 */
function switchedOffTwiml(res) {
  sendTwiml(res, '<Response><Say>The consult call bridge is turned off. Goodbye.</Say><Hangup/></Response>');
}
```

In `/answer`, directly after `if (!attemptId || !leg || ring === null) return apologyTwiml(res);`, add:

```js
    if (!isEnabled()) return switchedOffTwiml(res);
```

Replace the `/answer` TwiML:

```js
    sendTwiml(res,
      `<Response>`
        + `<Gather numDigits="1" timeout="10" method="POST" action="${action}">`
          + `<Say>${briefing}</Say>`
        + `</Gather>`
        + `<Say>${briefing}</Say>`
        + `<Hangup/>`
      + `</Response>`
    );
```

with:

```js
    // BOTH readings sit inside the Gather (spec 2026-09-30 section 6.2). The
    // repeat used to follow it, with no collector behind it, so a 1 pressed
    // during the second reading was lost.
    sendTwiml(res,
      `<Response>`
        + `<Gather numDigits="1" timeout="10" method="POST" action="${action}">`
          + `<Say>${briefing}</Say>`
          + `<Pause length="1"/>`
          + `<Say>${briefing}</Say>`
        + `</Gather>`
        + `<Hangup/>`
      + `</Response>`
    );
```

In the `/answer` JSDoc, replace the line ` * spoken briefing; a second <Say> is the one automatic repeat; then hang up` with ` * spoken briefing AND its one automatic repeat; then hang up`.

In `/digit`, directly after the `if (digits !== '1') { ... }` block and before `const row = await loadAttempt(attemptId);`, add:

```js
    // Kill switch, FIRST (spec 2026-09-30 section 6.1): flipping it off
    // mid-ring must not still buy one billed client leg.
    if (!isEnabled()) return switchedOffTwiml(res);
```

- [ ] **Step 5: TwiML on the lead route**

In `server/routes/voiceLeadCall.js` `/answer`, replace:

```js
    sendTwiml(res,
      `<Response>` +
        `<Gather numDigits="1" timeout="10" method="POST" action="${action}">` +
          `<Say>${briefing}</Say>` +
        `</Gather>` +
        `<Say>${briefing}</Say>` +
        `<Hangup/>` +
      `</Response>`
    );
```

with:

```js
    // BOTH readings sit inside the Gather (spec 2026-09-30 section 6.2): a
    // repeat after it had no collector, so a 1 during it was lost.
    sendTwiml(res,
      `<Response>` +
        `<Gather numDigits="1" timeout="10" method="POST" action="${action}">` +
          `<Say>${briefing}</Say>` +
          `<Pause length="1"/>` +
          `<Say>${briefing}</Say>` +
        `</Gather>` +
        `<Hangup/>` +
      `</Response>`
    );
```

If that route's JSDoc describes the repeat as following the Gather, reword it the same way.

- [ ] **Step 6: Run both suites**

Run: `node --test server/routes/voiceConsultCall.test.js` then `node --test server/routes/voiceLeadCall.test.js`
Expected: all pass. Consult suite: 2 more tests than after Task 3. Lead suite: same count as before.

- [ ] **Step 7: Commit**

```bash
git add server/routes/voiceConsultCall.js server/routes/voiceConsultCall.test.js server/routes/voiceLeadCall.js server/routes/voiceLeadCall.test.js
git commit -F - <<'MSG'
fix(voice bridges): the kill switch covers press-1; press 1 works during the repeat

With the consult switch off, answering says so and pressing 1 dials nothing.
On both the consult and lead bridges the repeated briefing now sits inside the
Gather, so a 1 pressed during the second reading is collected.
MSG
```

---

### Task 6: The reaper moves under the consult sweep and reports unconfirmed bridges (spec 4.3, 4.4)

**Files:**
- Create: `server/utils/consultCallReaper.js`
- Create: `server/utils/consultCallReaper.test.js`
- Modify: `server/utils/consultCallSweep.js`, `server/utils/consultCallSweep.test.js`
- Modify: `server/utils/vaCallingScheduler.js`, `server/utils/vaCallingScheduler.test.js`
- Modify: `server/utils/emailTemplates.js`, `server/utils/emailTemplates.consultCall.test.js`
- Modify: `client/src/utils/consultCallLabel.js`, `client/src/utils/consultCallLabel.test.js`
- Modify: `scripts/sensitive-paths.txt`, `.env.example`, `README.md`, `ARCHITECTURE.md`, `.claude/CLAUDE.md`

**Interfaces:**
- Consumes: `consultCallChain.isEnabled()`, `consultCallChain.sendChainEmail({ attemptId, reason })`, `consultCallChain.STALE_MINUTES`.
- Produces: `reapStaleConsultCallAttempts() => Promise<number>` (moved, unchanged behavior), `reapUnconfirmedBridges() => Promise<number>`, `BRIDGE_GRACE_SEC = 600`, `__setDeps({ pool, sendChainEmail })`. The sweep's tick result gains `reaped` and `unconfirmedBridges`. Email reason `bridge unconfirmed`; detail `bridge_unconfirmed`.

- [ ] **Step 1: Write the reaper suite (moved tests plus the new arm)**

Create `server/utils/consultCallReaper.test.js`:

```js
require('dotenv').config();
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  reapStaleConsultCallAttempts, reapUnconfirmedBridges, BRIDGE_GRACE_SEC, __setDeps,
} = require('./consultCallReaper');

// ─── consult call reaper (spec 2026-08-25 section 4.2; moved and given a
// second arm by spec 2026-09-30 sections 4.3 and 4.4) ────────────────────
// Both arms are TABLE-WIDE by design, so every assertion is scoped to this
// run's ids. Shared dev DB: run this suite ALONE.

// A STABLE prefix, so cleanup can scope itself with one LIKE and still mop up
// after a run that crashed before its after() hook.
const PREFIX = 'ccr-consult-reap-';
const SAVED = {
  CONSULT_CALL_ENABLED: process.env.CONSULT_CALL_ENABLED,
  VA_CALL_TIME_LIMIT_SEC: process.env.VA_CALL_TIME_LIMIT_SEC,
};

async function cleanup() {
  await pool.query(
    `DELETE FROM consult_call_attempts WHERE consult_id IN
       (SELECT id FROM consults WHERE calcom_event_id LIKE $1)`,
    [`${PREFIX}%`]
  );
  await pool.query('DELETE FROM consults WHERE calcom_event_id LIKE $1', [`${PREFIX}%`]);
}

before(cleanup);
after(async () => {
  await cleanup();
  await pool.end();
});
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  __setDeps({ pool, sendChainEmail: (...a) => require('./consultCallChain').sendChainEmail(...a) });
});

// Explicit column list: dev and prod disagree on consults column ORDER.
async function mkConsult(tag, minutesPastSlot) {
  const { rows } = await pool.query(
    `INSERT INTO consults (calcom_event_id, scheduled_at, status, booker_name, booker_email, booker_phone)
     VALUES ($1, NOW() - make_interval(mins => $2::int), 'scheduled',
             'Reaper Test', 'ccr-reap@example.test', '+17735550188')
     RETURNING id`,
    [`${PREFIX}${Date.now()}-${tag}-${Math.floor(Math.random() * 1e6)}`, minutesPastSlot]
  );
  return rows[0].id;
}

// scheduled_at copied IN SQL (ruling R12). next_ring_at non-null so the stale
// arm's next_ring_at = NULL is observable.
async function mkConsultAttempt(consultId, status) {
  const { rows } = await pool.query(
    `INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, next_ring_at)
     SELECT c.id, c.scheduled_at, $2, NOW() + INTERVAL '1 minute'
       FROM consults c WHERE c.id = $1
     RETURNING id`,
    [consultId, status]
  );
  return Number(rows[0].id);
}

// A press-1 row: connected, answered by Dallas, bridge started this many
// seconds ago, with or without either report of the client leg.
async function mkBridge(tag, { startedSecAgo, duration = null, noAnswer = false }) {
  const consultId = await mkConsult(tag, Math.ceil(startedSecAgo / 60) + 1);
  const { rows } = await pool.query(
    `INSERT INTO consult_call_attempts
       (consult_id, scheduled_at, status, answered_by, bridge_started_at, bridge_duration_sec, client_no_answer_at)
     SELECT c.id, c.scheduled_at, 'connected', 'admin',
            NOW() - make_interval(secs => $2::int), $3::int,
            CASE WHEN $4::boolean THEN NOW() ELSE NULL END
       FROM consults c WHERE c.id = $1
     RETURNING id`,
    [consultId, startedSecAgo, duration, noAnswer]
  );
  return Number(rows[0].id);
}

async function rowsById(ids) {
  const { rows } = await pool.query(
    'SELECT id, status, detail, next_ring_at FROM consult_call_attempts WHERE id = ANY($1)', [ids]
  );
  return Object.fromEntries(rows.map((r) => [Number(r.id), r]));
}

function recorder() {
  const emails = [];
  __setDeps({ pool, sendChainEmail: async (args) => { emails.push(args); } });
  return emails;
}

// ── the stale arm (moved from vaCallingScheduler.test.js, behavior unchanged) ─

test('stale arm (enabled): stale pending and calling_va rows fail as stale_reaped, emailed once each', async () => {
  process.env.CONSULT_CALL_ENABLED = 'true';
  const emails = recorder();
  const stalePending = await mkConsultAttempt(await mkConsult('p', 45), 'pending');
  const staleVa = await mkConsultAttempt(await mkConsult('v', 45), 'calling_va');
  const mine = [stalePending, staleVa];

  await reapStaleConsultCallAttempts();

  const byId = await rowsById(mine);
  for (const id of mine) {
    assert.equal(byId[id].status, 'failed', `stale row ${id} reaped`);
    assert.equal(byId[id].detail, 'stale_reaped');
    assert.equal(byId[id].next_ring_at, null, 'a reaped chain must never ring again');
  }
  const mineEmailed = emails.filter((e) => mine.includes(e.attemptId));
  assert.equal(mineEmailed.length, 2, 'exactly one email per reaped row');
  assert.deepEqual([...new Set(mineEmailed.map((e) => e.attemptId))].sort(), [...mine].sort());
  assert.ok(mineEmailed.every((e) => e.reason === 'call failed'));
});

test('stale arm (enabled): a connected bridge and a five-minute-old slot are untouched', async () => {
  process.env.CONSULT_CALL_ENABLED = 'true';
  const emails = recorder();
  const connected = await mkConsultAttempt(await mkConsult('c', 45), 'connected');
  const fresh = await mkConsultAttempt(await mkConsult('f', 5), 'pending');
  const mine = [connected, fresh];

  await reapStaleConsultCallAttempts();

  const byId = await rowsById(mine);
  assert.equal(byId[connected].status, 'connected', 'the stale arm never touches a bridge');
  assert.equal(byId[connected].detail, null);
  assert.equal(byId[fresh].status, 'pending', 'five minutes past the slot, the chain may still be mid-ring');
  assert.equal(emails.filter((e) => mine.includes(e.attemptId)).length, 0);
});

test('stale arm (switch off): stale rows are parked skipped_disabled, ZERO emails, and stay quiet when it comes back on (Review Focus 4)', async () => {
  process.env.CONSULT_CALL_ENABLED = 'false';
  const emails = recorder();
  const stalePending = await mkConsultAttempt(await mkConsult('dp', 45), 'pending');
  const staleVa = await mkConsultAttempt(await mkConsult('dv', 45), 'calling_va');
  const mine = [stalePending, staleVa];

  await reapStaleConsultCallAttempts();

  let byId = await rowsById(mine);
  for (const id of mine) {
    assert.equal(byId[id].status, 'skipped_disabled', `row ${id} is parked, not failed`);
    assert.equal(byId[id].detail, 'stale_reaped');
    assert.equal(byId[id].next_ring_at, null);
  }
  assert.equal(emails.length, 0, 'the kill switch silences the alert too');

  process.env.CONSULT_CALL_ENABLED = 'true';
  await reapStaleConsultCallAttempts();
  await reapUnconfirmedBridges();
  byId = await rowsById(mine);
  for (const id of mine) assert.equal(byId[id].status, 'skipped_disabled', 'a parked row is never reaped later');
  assert.equal(emails.filter((e) => mine.includes(e.attemptId)).length, 0);
});

// ── the bridge arm (spec 2026-09-30 section 4.3) ────────────────────────────

test('bridge arm: a press-1 with no report of the client leg past the limit flips to failed and emails once', async () => {
  process.env.CONSULT_CALL_ENABLED = 'true';
  delete process.env.VA_CALL_TIME_LIMIT_SEC;
  const emails = recorder();
  const silent = await mkBridge('silent', { startedSecAgo: 1800 + BRIDGE_GRACE_SEC + 60 });

  await reapUnconfirmedBridges();
  await reapUnconfirmedBridges();

  const byId = await rowsById([silent]);
  assert.equal(byId[silent].status, 'failed');
  assert.equal(byId[silent].detail, 'bridge_unconfirmed');
  const mine = emails.filter((e) => e.attemptId === silent);
  assert.equal(mine.length, 1, 'flipped once, emailed once, however many passes run');
  assert.equal(mine[0].reason, 'bridge unconfirmed');
});

test('bridge arm: a duration, a no-answer latch, or time still inside the limit leaves the row connected', async () => {
  process.env.CONSULT_CALL_ENABLED = 'true';
  delete process.env.VA_CALL_TIME_LIMIT_SEC;
  const emails = recorder();
  const withDuration = await mkBridge('dur', { startedSecAgo: 3000, duration: 0 });
  const withLatch = await mkBridge('latch', { startedSecAgo: 3000, noAnswer: true });
  const young = await mkBridge('young', { startedSecAgo: 1800 + BRIDGE_GRACE_SEC - 60 });
  const mine = [withDuration, withLatch, young];

  await reapUnconfirmedBridges();

  const byId = await rowsById(mine);
  for (const id of mine) assert.equal(byId[id].status, 'connected', `row ${id} untouched`);
  assert.equal(emails.filter((e) => mine.includes(e.attemptId)).length, 0);
});

test('bridge arm: the limit follows VA_CALL_TIME_LIMIT_SEC', async () => {
  process.env.CONSULT_CALL_ENABLED = 'true';
  process.env.VA_CALL_TIME_LIMIT_SEC = '600';
  const emails = recorder();
  const past = await mkBridge('short-limit', { startedSecAgo: 600 + BRIDGE_GRACE_SEC + 60 });

  await reapUnconfirmedBridges();

  assert.equal((await rowsById([past]))[past].status, 'failed');
  assert.equal(emails.filter((e) => e.attemptId === past).length, 1);
});

test('bridge arm: with the switch off it writes nothing and emails nothing', async () => {
  process.env.CONSULT_CALL_ENABLED = 'false';
  const emails = recorder();
  const silent = await mkBridge('off', { startedSecAgo: 1800 + BRIDGE_GRACE_SEC + 60 });

  assert.equal(await reapUnconfirmedBridges(), 0);
  assert.equal((await rowsById([silent]))[silent].status, 'connected');
  assert.equal(emails.length, 0);
});
```

- [ ] **Step 2: Add the sweep wiring tests**

In `server/utils/consultCallSweep.test.js`, directly after `const VALID_PHONE = '+12563281203';` add:

```js

// The reaper is table-wide like every sweep query and has its own suite
// (consultCallReaper.test.js). A no-op by default here, so a stranded row some
// other suite left behind can never move this suite's counters; the wiring
// tests below install recording stubs.
const NOOP_REAPER = {
  reapStaleConsultCallAttempts: async () => 0,
  reapUnconfirmedBridges: async () => 0,
};
```

In `beforeEach`, replace `sweep.__setDeps({ pool, chain });` with `sweep.__setDeps({ pool, chain, reaper: NOOP_REAPER });`.

In the window-boundaries test, replace:

```js
  assert.deepEqual(r, {
    opened: 3, capTripped: 0, skippedInvalid: 0, missedWindow: 2, ringsProcessed: 1,
  });
```

with:

```js
  assert.deepEqual(r, {
    opened: 3, capTripped: 0, skippedInvalid: 0, missedWindow: 2, ringsProcessed: 1,
    reaped: 0, unconfirmedBridges: 0,
  });
```

Directly after the `kill switch: the tick returns the skipped shape...` test, add:

```js
test('kill switch off: only the stale reap runs, because it parks and never alerts', async () => {
  const seen = [];
  sweep.__setDeps({ reaper: {
    reapStaleConsultCallAttempts: async () => { seen.push('stale'); return 0; },
    reapUnconfirmedBridges: async () => { seen.push('bridge'); return 0; },
  } });
  process.env.CONSULT_CALL_ENABLED = 'false';
  let r;
  try {
    r = await sweep.runConsultCallSweep();
  } finally {
    delete process.env.CONSULT_CALL_ENABLED;
  }
  assert.deepEqual(r, { skipped: true });
  assert.deepEqual(seen, ['stale']);
});

test('the reaper rides every tick: both arms run and their counts come back', async () => {
  const seen = [];
  sweep.__setDeps({ reaper: {
    reapStaleConsultCallAttempts: async () => { seen.push('stale'); return 2; },
    reapUnconfirmedBridges: async () => { seen.push('bridge'); return 1; },
  } });
  const r = await sweep.runConsultCallSweep();
  assert.deepEqual(seen, ['stale', 'bridge']);
  assert.equal(r.reaped, 2);
  assert.equal(r.unconfirmedBridges, 1);
});

test('a throwing reaper arm costs neither the ring step nor the other arm, and the tick still fails', async () => {
  const due = await makeConsult('r-due', { offsetSec: -120 });
  assert.equal(await chain.openChain({ consultId: due }), 'opened');
  const seen = [];
  sweep.__setDeps({ reaper: {
    reapStaleConsultCallAttempts: async () => { seen.push('stale'); throw new Error('reap_down'); },
    reapUnconfirmedBridges: async () => { seen.push('bridge'); return 0; },
  } });
  await assert.rejects(sweep.runConsultCallSweep(), /reap_down/);
  assert.deepEqual(seen, ['stale', 'bridge'], 'the bridge arm still ran');
  const rows = await attemptsFor(due);
  assert.equal(rows[0].status, 'calling_admin', 'the ring a booker is waiting for still went out');
  assert.equal(placed.length, 1);
});
```

- [ ] **Step 3: Replace the VA scheduler's consult tests**

In `server/utils/vaCallingScheduler.test.js`:
- Remove `reapStaleConsultCallAttempts,` from the destructured import.
- Delete `CONSULT_PREFIX` and its comment, the two consult DELETEs inside `cleanup()` and their comment, `SAVED_CONSULT_ENABLED` and its comment, the consult-enabled restore inside `afterEach`, and `sendConsultCallChainEmail: require('./consultCallChain').sendChainEmail,` from the `afterEach` restore.
- Delete the whole `consult-call stale reaper` section: its header comment, `mkConsult`, `mkConsultAttempt`, `consultRows`, and the three `consult reaper (...)` tests.
- Replace BOTH masking tests (`a throwing consult reap masks neither the prune nor the lead reap` and `a throwing lead reap masks neither the prune nor the consult reap`) with:

```js
test('a throwing lead reap does not mask the prune, and the VA prune never touches consult rows', async () => {
  const seen = [];
  let pruneCalls = 0;
  __setDeps({
    pruneVaCallingRows: async () => { pruneCalls += 1; return 7; },
    sendLeadCallChainEmail: async () => { throw new Error('must not be called'); },
    pool: reapGuardPool(seen, 'lead_call_attempts'),
  });

  const n = await pruneVaCallingRows();
  assert.equal(pruneCalls, 1, 'the prune ran');
  assert.equal(n, 7, 'and its result still comes back to the caller');
  assert.ok(seen.some((s) => s.includes('lead_call_attempts')), 'the lead reap was attempted');
  assert.ok(!seen.some((s) => s.includes('consult_call_attempts')),
    'consult rows belong to the consult sweep now (spec 2026-09-30 section 4.4)');
});
```

Keep `reapGuardPool` and update its comment to say it throws for the lead reap's table.

- [ ] **Step 4: Label and banner tests**

In `client/src/utils/consultCallLabel.test.js`, rename `detail never changes a label outside the cap and cancelled branches` to `detail never changes a label outside the cap, cancelled and unconfirmed-bridge branches`, update the comment above it to name the third branch, and add after it:

```js
// spec 2026-09-30 section 4.3: somebody DID answer and press 1, and Twilio never
// reported the client leg. Its own words, not the generic failed label.
test('a press-1 the reaper flipped reads as an unconfirmed bridge', () => {
  expect(consultCallOutcomeLabel(row({ status: 'failed', detail: 'bridge_unconfirmed' })))
    .toBe('pressed 1, bridge unconfirmed');
  expect(consultCallOutcomeLabel(row({ status: 'missed', detail: 'bridge_unconfirmed' }))).toBe('missed');
});
```

In `server/utils/emailTemplates.consultCall.test.js`, add `'bridge unconfirmed',` to `REASONS`, and to `banners`:

```js
    'bridge unconfirmed': 'Someone pressed 1 on this consult, but Twilio never reported the call to the client, so it most likely never connected. Call them to check.',
```

- [ ] **Step 5: Run the four suites and watch them fail**

Run, one at a time:
- `node --test server/utils/consultCallReaper.test.js` (Expected: fails at require, `Cannot find module './consultCallReaper'`.)
- `node --test server/utils/consultCallSweep.test.js` (Expected: the window test and the three new tests FAIL.)
- `node --test server/utils/emailTemplates.consultCall.test.js` (Expected: the `bridge unconfirmed` banner check FAILS.)
- `cd client && CI=true npx react-scripts test --watchAll=false src/utils/consultCallLabel.test.js; cd ..` (Expected: the new label test FAILS.)

- [ ] **Step 6: Create the reaper module**

Create `server/utils/consultCallReaper.js`:

```js
/**
 * Consult call bridge: the reaper (spec 2026-08-25 section 4.2; moved here and
 * given a second arm by spec 2026-09-30 sections 4.3 and 4.4).
 *
 * It rides the consult sweep's 60-second tick, under
 * RUN_CONSULT_CALL_SWEEP_SCHEDULER. It used to ride the hourly VA prune under
 * RUN_VA_CALLING_SCHEDULER, so the sweep could run with its only rescue
 * switched off: calling_* rows then held a cap slot for 24 hours and nobody
 * was told.
 *
 *   reapStaleConsultCallAttempts()  a chain stranded mid-ring (pending or
 *                                   calling_*) half an hour past its slot.
 *   reapUnconfirmedBridges()        a press-1 that never produced any report
 *                                   of the client leg.
 *
 * Each UPDATE is the claim: every id it returns is a row THIS pass
 * transitioned, so each email goes out exactly once.
 */

const { pool } = require('../db');
const consultCallChain = require('./consultCallChain');

// Past the call's own time limit, how long a bridge may stay silent before it
// is reported. Ten minutes absorbs a late status callback.
const BRIDGE_GRACE_SEC = 600;

// Same 1800s default as consultCallChain.js and voiceConsultCall.js, each of
// which keeps its own copy (house pattern, never exported).
function timeLimitSec() { return parseInt(process.env.VA_CALL_TIME_LIMIT_SEC, 10) || 1800; }

let deps = {
  pool,
  sendChainEmail: (...a) => consultCallChain.sendChainEmail(...a),
};
function __setDeps(d) { deps = { ...deps, ...d }; }

// A consult chain can be stranded in a non-terminal state by a crash, by a
// Twilio status callback that never arrives, or by a deploy landing mid-chain.
// Nothing else rescues it: the sweep only opens chains inside a five-minute
// window around the slot, so a row left in pending/calling_* just sits there
// and Dallas never learns the consult went unanswered.
//
// Anchored on scheduled_at, NOT created_at like the lead sibling: the whole ring
// plan finishes within twelve minutes of the slot (TOO_LATE_VA_SEC), so a slot
// half an hour gone is unambiguously stranded, while a chain opened early for a
// slot still in the future is not yet late at all. 'connected' is excluded:
// that is the bridge arm's business.
//
// Kill switch off, the SAME rows are filed 'skipped_disabled' and nothing is
// emailed. That branch is the point of the function, not a detail: if Dallas
// flips the switch off during an incident, every chain parked mid-flight would
// otherwise be reported to him as a system failure, one email per consult,
// when the system did exactly what he told it to. The sweep runs this arm even
// while the switch is off, for exactly that reason.
async function reapStaleConsultCallAttempts() {
  const enabled = consultCallChain.isEnabled();
  const reaped = await deps.pool.query(
    `UPDATE consult_call_attempts
        SET status = $1, detail = $2, next_ring_at = NULL, updated_at = NOW()
      WHERE status IN ('pending', 'calling_admin', 'calling_va')
        AND scheduled_at < NOW() - make_interval(mins => $3::int)
      RETURNING id`,
    [enabled ? 'failed' : 'skipped_disabled', 'stale_reaped', consultCallChain.STALE_MINUTES]
  );
  // The switch silences the alert, not just the dialing.
  if (!enabled) return reaped.rowCount;
  for (const row of reaped.rows) {
    // 'call failed' rather than a skip banner: a stranded row IS a system
    // fault, and that banner is the one that says go look at the system.
    await deps.sendChainEmail({ attemptId: Number(row.id), reason: 'call failed' });
  }
  return reaped.rowCount;
}

// A press-1 claims 'connected', which was terminal and never reaped, so a
// <Dial> that failed at Twilio without producing either callback left a
// settled-looking row and no alert. The client leg reports back two ways: its
// <Number statusCallback> writes bridge_duration_sec, and the <Dial action>
// (/dialend) latches client_no_answer_at for no-answer, busy, failed or
// canceled. A row with neither, past the call's own time limit plus grace, has
// no evidence the client was ever called. It becomes 'failed' so it shows in
// Needs attention. If Twilio merely lost the report of a real call, the cost
// is one false alarm, which is the right way for this feature to be wrong.
//
// Switch off: no write and no email, matching the stale arm's silence. A row
// left 'connected' then is picked up on the first tick after it comes back on.
async function reapUnconfirmedBridges() {
  if (!consultCallChain.isEnabled()) return 0;
  const reaped = await deps.pool.query(
    `UPDATE consult_call_attempts
        SET status = 'failed', detail = 'bridge_unconfirmed', updated_at = NOW()
      WHERE status = 'connected'
        AND bridge_duration_sec IS NULL
        AND client_no_answer_at IS NULL
        AND bridge_started_at < NOW() - make_interval(secs => $1::int)
      RETURNING id`,
    [timeLimitSec() + BRIDGE_GRACE_SEC]
  );
  for (const row of reaped.rows) {
    await deps.sendChainEmail({ attemptId: Number(row.id), reason: 'bridge unconfirmed' });
  }
  return reaped.rowCount;
}

module.exports = {
  reapStaleConsultCallAttempts, reapUnconfirmedBridges, BRIDGE_GRACE_SEC, __setDeps,
};
```

- [ ] **Step 7: Wire it into the sweep**

In `server/utils/consultCallSweep.js`:

After `const chain = require('./consultCallChain');` add `const reaper = require('./consultCallReaper');`.

Replace `let deps = { pool, chain };` with `let deps = { pool, chain, reaper };`.

Directly after `processDueRings`'s closing `}`, add:

```js

/**
 * Steps 4 and 5, the reaper's two arms (spec 2026-09-30 section 4.4). Two
 * steps rather than one so either arm failing cannot cost the other its pass.
 */
async function reapStaleChains(counts) {
  counts.reaped += await deps.reaper.reapStaleConsultCallAttempts();
}

async function reapSilentBridges(counts) {
  counts.unconfirmedBridges += await deps.reaper.reapUnconfirmedBridges();
}
```

In `runConsultCallSweep`, replace:

```js
  if (!deps.chain.isEnabled()) return { skipped: true };
```

with:

```js
  if (!deps.chain.isEnabled()) {
    // The stale reap still runs with the switch off (spec 2026-09-30 section
    // 4.4). Its disabled branch parks a stranded chain skipped_disabled and
    // emails nobody; skipped here, those rows would sit until the switch came
    // back and then be reaped as failures, one email per consult, for a stop
    // Dallas ordered. Nothing is dialed, opened or filed.
    try {
      await deps.reaper.reapStaleConsultCallAttempts();
    } catch (err) {
      throw toError(err);
    }
    return { skipped: true };
  }
```

Replace:

```js
  const counts = {
    opened: 0, capTripped: 0, skippedInvalid: 0, missedWindow: 0, ringsProcessed: 0,
  };
```

with:

```js
  const counts = {
    opened: 0, capTripped: 0, skippedInvalid: 0, missedWindow: 0, ringsProcessed: 0,
    reaped: 0, unconfirmedBridges: 0,
  };
```

Replace the step list:

```js
  for (const [name, step] of [
    ['open', openDueChains], ['missed-window', fileMissedWindows], ['fire', processDueRings],
  ]) {
```

with:

```js
  for (const [name, step] of [
    ['open', openDueChains], ['missed-window', fileMissedWindows], ['fire', processDueRings],
    ['reap-stale', reapStaleChains], ['reap-bridge', reapSilentBridges],
  ]) {
```

Replace the log block:

```js
  if (counts.opened || counts.capTripped || counts.skippedInvalid
      || counts.missedWindow || counts.ringsProcessed) {
    console.log(
      `[consultCallSweep] opened=${counts.opened} capTripped=${counts.capTripped} `
      + `skippedInvalid=${counts.skippedInvalid} missedWindow=${counts.missedWindow} `
      + `ringsProcessed=${counts.ringsProcessed}`
    );
  }
```

with:

```js
  if (counts.opened || counts.capTripped || counts.skippedInvalid
      || counts.missedWindow || counts.ringsProcessed
      || counts.reaped || counts.unconfirmedBridges) {
    console.log(
      `[consultCallSweep] opened=${counts.opened} capTripped=${counts.capTripped} `
      + `skippedInvalid=${counts.skippedInvalid} missedWindow=${counts.missedWindow} `
      + `ringsProcessed=${counts.ringsProcessed} reaped=${counts.reaped} `
      + `unconfirmedBridges=${counts.unconfirmedBridges}`
    );
  }
```

In `runConsultCallSweep`'s JSDoc `@returns`, add `reaped: number, unconfirmedBridges: number` to the counts shape and one line: `reaped and unconfirmedBridges count rows the two reaper arms transitioned this tick.` Replace the comment line `// Raised AFTER all three steps ran:` with `// Raised AFTER every step ran:`.

- [ ] **Step 8: Remove the consult reaper from the VA scheduler**

In `server/utils/vaCallingScheduler.js`:
- Delete `const consultCallChain = require('./consultCallChain');`, the `sendConsultCallChainEmail` dep line, the whole `reapStaleConsultCallAttempts` function with its comment block, the consult `try { ... } catch` block inside `pruneVaCallingRows` together with its comment, and `reapStaleConsultCallAttempts,` from `module.exports`.
- In the file header, replace the sentences `It also carries\n//                               the two stale-chain reapers, lead-call and\n//                               consult-call. Each reaper is separately\n//                               guarded, so neither can mask the other, and\n//                               neither can swallow the prune's result on its\n//                               way out.` with text saying it carries the lead-call stale reaper, separately guarded so it cannot swallow the prune's result, and that the consult-call reaper moved to `consultCallReaper.js` (spec 2026-09-30), riding the consult sweep.
- Update the comment above `pruneVaCallingRows` so it no longer mentions a consult reap.

Run: `grep -n "consult" server/utils/vaCallingScheduler.js`
Expected: only the header's pointer to `consultCallReaper.js`.

- [ ] **Step 9: The banner and the label**

In `server/utils/emailTemplates.js`, inside `CONSULT_CALL_BANNERS`, after the two `client no answer` entries, add:

```js
  // spec 2026-09-30 section 4.3: somebody pressed 1 and Twilio never reported
  // the client leg, so the client most likely never rang.
  ['bridge unconfirmed', 'Someone pressed 1 on this consult, but Twilio never reported the call to the client, so it most likely never connected. Call them to check.'],
```

and add `'bridge unconfirmed',` to the `consultCallAdmin` JSDoc reasons list.

In `client/src/utils/consultCallLabel.js`, in `consultCallOutcomeLabel`, directly after `if (cc.status === 'skipped_cancelled') return consultCancelledLabel(cc.detail);`, add:

```js
  // A press-1 the reaper flipped because Twilio never reported the client leg
  // (spec 2026-09-30 section 4.3). Its own words, not the generic 'failed':
  // somebody DID answer and press 1, and the line should say so.
  if (cc.status === 'failed' && cc.detail === 'bridge_unconfirmed') return 'pressed 1, bridge unconfirmed';
```

In the header comment of that file, change `Only the cap and cancelled branches read it,` to `Only the cap, cancelled and unconfirmed-bridge branches read it,`.

- [ ] **Step 10: Run every suite this task touched**

Run, one at a time, reading each pass count:
- `node --test server/utils/consultCallReaper.test.js` (Expected: 7 pass.)
- `node --test server/utils/consultCallSweep.test.js` (Expected: all pass; 3 more than before.)
- `node --test server/utils/vaCallingScheduler.test.js` (Expected: all pass; 4 fewer than before, since 5 tests were removed and 1 added.)
- `node --test server/utils/emailTemplates.consultCall.test.js` (Expected: all pass.)
- `cd client && CI=true npx react-scripts test --watchAll=false src/utils/consultCallLabel.test.js; cd ..` (Expected: all pass.)

- [ ] **Step 11: Sensitive path and docs**

In `scripts/sensitive-paths.txt`, in the consult call bridge block, after `server/utils/consultCallSweep.js` add `server/utils/consultCallReaper.js`.

Run: `node scripts/sensitive-match.js server/utils/consultCallReaper.js`
Expected: it reports a match. (If the script takes input differently, read its header and use its documented form.)

In `.claude/CLAUDE.md` and `README.md`, env tables:
- `RUN_VA_CALLING_SCHEDULER`: remove the consult-call reaper from what it disables, and delete the sentences that say the consult-call reaper rides `pruneVaCallingRows` and is controlled by this flag.
- `RUN_CONSULT_CALL_SWEEP_SCHEDULER`: add that the sweep also runs the consult-call reaper every tick (stranded chains, and press-1 bridges Twilio never reported), and that the stale half still runs with `CONSULT_CALL_ENABLED=false`, parking stranded chains `skipped_disabled` with no email.

In `.env.example`, grep `RUN_VA_CALLING_SCHEDULER` and `RUN_CONSULT_CALL_SWEEP_SCHEDULER` and make the same two corrections to their comment blocks.

In `README.md` folder tree, add under `consultCallLookups.js`:

```md
│   │   ├── consultCallReaper.js # Consult call bridge reaper, riding the consult sweep's 60-second tick (spec 2026-09-30). reapStaleConsultCallAttempts fails a chain stranded mid-ring 30 minutes past its slot (or parks it skipped_disabled with no email while the kill switch is off); reapUnconfirmedBridges flips a press-1 with no report of the client leg past the call's time limit plus 10 minutes to failed / bridge_unconfirmed and emails once
```

Update the `consultCallSweep.js` line to add `, and runs the consult call reaper's two arms every tick`, and remove any consult-reaper mention from the `vaCallingScheduler.js` line.

In `ARCHITECTURE.md`:
- Replace the `- **The reaper**, riding the hourly VA-calling pass (`vaCallingScheduler.js`), has two modes.` bullet with one describing `consultCallReaper.js` riding the sweep: the stale arm (unchanged rules, still runs while the switch is off) and the bridge arm (`connected`, no `bridge_duration_sec`, no `client_no_answer_at`, `bridge_started_at` older than the time limit plus 600 seconds, becomes `failed` / `bridge_unconfirmed` with one `bridge unconfirmed` email; no-op while the switch is off).
- In the sweep bullet, change `One tick, three steps:` to `One tick, five steps:` and add the two reaper steps at the end.
- In the consult `Writers:` line, replace `vaCallingScheduler.js` (stale reap) with `consultCallReaper.js` (stale reap and unconfirmed bridges).

- [ ] **Step 12: Commit**

```bash
git add server/utils/consultCallReaper.js server/utils/consultCallReaper.test.js server/utils/consultCallSweep.js server/utils/consultCallSweep.test.js server/utils/vaCallingScheduler.js server/utils/vaCallingScheduler.test.js server/utils/emailTemplates.js server/utils/emailTemplates.consultCall.test.js client/src/utils/consultCallLabel.js client/src/utils/consultCallLabel.test.js scripts/sensitive-paths.txt .env.example README.md ARCHITECTURE.md .claude/CLAUDE.md
git commit -F - <<'MSG'
feat(consult call): the reaper rides the consult sweep and reports unconfirmed bridges

The stale-chain reaper moves out of the VA prune into its own module on the
consult sweep's tick, so the sweep can never run without its rescue. A new arm
flips a press-1 that Twilio never reported past the call limit to failed, with
one email and a Needs attention item.
MSG
```

---

### Task 7: Verify, review, merge, and close the ledger

- [ ] **Step 1: Run every suite the lane reaches, one at a time, from the lane root**

```bash
NODE_ENV=test node --test server/routes/calcom.test.js
node --test server/utils/consultCallChain.test.js
node --test server/routes/voiceConsultCall.test.js
node --test server/routes/voiceLeadCall.test.js
node --test server/utils/consultCallReaper.test.js
node --test server/utils/consultCallSweep.test.js
node --test server/utils/vaCallingScheduler.test.js
node --test server/utils/emailTemplates.consultCall.test.js
node --test server/utils/calcomWebhookHelpers.test.js
node --test server/routes/proposals/getOne.consultCall.test.js
node --test server/routes/clients.consultCalls.test.js
node --test server/utils/consultCallLookups.test.js
node --test server/db/constraintContract.test.js
cd client && CI=true npx react-scripts test --watchAll=false src/utils/consultCallLabel.test.js src/pages/admin/overview/queueItems.test.js; cd ..
```

Expected: every suite green, and each pass count matches the arithmetic in the task that touched it. A red run with a cap or quota failure means leaked fixtures: count rows before reading code.

Also run: `grep -rn "sendMissedText\|reapStaleConsultCallAttempts\|fileDialCapTrip" server client/src --include=*.js | grep -v test`
Expected: `sendMissedText` only inside `consultCallChain.js`; `reapStaleConsultCallAttempts` only in `consultCallReaper.js`; no `fileDialCapTrip`.

Run: `node scripts/check-file-size.js --all | grep -E "consultCallChain|consultCallSweep|consultCallReaper|calcom.js|voiceConsultCall"`
Expected: no RED entry.

- [ ] **Step 2: Per-lane review, full fleet**

Every file in `git diff --name-only main...HEAD` goes into the coverage manifest. Dispatch the review agents in `.claude/agents/` (code, security, database, consistency, performance lenses as the diff warrants), chunked so each finishes. The iron rule applies: an agent that does not return an explicit verdict is a blind spot, not a pass. Fix, re-run the affected suites, commit.

- [ ] **Step 3: Merge**

From `/home/drbartender/projects/os` on main, with a clean tree: `scripts/merge-lane.sh consult-bridge-hardening`. Squash message names the lane and links this plan. Then `npm run worktree:rm -- consult-bridge-hardening`, and delete the branch only after the three merged-lane checks in `.claude/CLAUDE.md` pass.

- [ ] **Step 4: Close the ledger, file the walkthrough, update the board (on main)**

In `docs/fix-list-remaining-2026-07-02.md`:
- Delete the whole section 0 (`## 0. The consult call bridge is LIVE...` up to, not including, `## 1. Money paths`, leaving one `---` separator), and its six `| 0 |` rows in the one-screen table.
- Delete the section 3 entry `### Pressing 1 during the automatic repeat does nothing, on BOTH bridges`. It has no row in the one-screen table; leave every `| 3 |` row alone.
- Under `# Settled — do not re-raise`, add one line: `- **The consult sibling stop keeps skipped_cancelled / rescheduled_unresolved (2026-09-30).** A status of its own was decided against: the one-row email closed the silence, and a rename changes no behavior.`

In `docs/walkthroughs-owed.md`, add an entry: after deploy, one real billed walk on a synthetic consult in the 2026-08-26 shape. Press 1 during the SECOND reading and confirm the bridge connects. Then set `CONSULT_CALL_ENABLED=false`, let a ring answer, confirm the spoken off message and that no client leg is placed. Set it back and confirm a chain opens (a kill-switch state is confirmed only by observing behavior).

Commit the two docs together on main with explicit paths, then `scripts/board-write.sh "Recently shipped" "**consult-bridge-hardening** — merged 2026-09-30 (<squash sha>): fix list section 0 closed."`
