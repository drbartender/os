# Phone System Phase 1a: The Call Experience, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both Twilio lines behave like a real business: the 1922 rings Dallas, the 0082 rings Zul, and either one that goes unanswered plays that person's own greeting, offers a single "press 1 to reach someone else" escalation to the other person, and otherwise takes a voicemail delivered to that line's owner.

**Architecture:** Everything hangs off one new concept, `line` (`'primary'` | `'zul'`), stamped on each line's `<Dial action>` query string, resolved once in the shared missed handler, persisted on `voicemail_delivery`, and then used to pick the greeting, the escalation target, and the delivery channel. The escalation is a new billed outbound leg, so it gets the full toll-fraud treatment already proven in the lead-call bridge: a claim-guarded state transition, a dedicated daily cap, a quiet window, a hard `timeLimit`, and a key-to-accept whisper so an unattended carrier voicemail can never swallow the call. TwiML fragments shared by two route files move into one small builder module so the greeting and the `<Record>` verb can never drift.

**Tech Stack:** Node.js 26 / Express 4, Postgres (raw SQL via `pg`), Twilio Programmable Voice (TwiML), Telegram Bot API, `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-26-phone-system-redesign-design.md` (revision 3, commit `a8be8086`)

**Plan revision 2** (rev 2 folds in the `/review-plan` fleet). What changed, because
several of these are correctness fixes and not polish:

1. **The whisper screen was self-defeating.** A carrier voicemail that answers and
   is then hung up by the whisper's `<Hangup/>` is still an ANSWERED child leg, so
   Twilio reports `DialCallStatus=completed`, and rev 1's `escalate/done` read that
   as "they talked" and hung up on the caller. Acceptance is now explicit STATE
   (`escalation_accepted_at`, set only by a real keypress) and `done` consults it
   instead of trusting `DialCallStatus`.
2. **A gated primary SMS was being treated as delivered.** `sendSMS` does not throw
   when notifications are gated or creds are missing; it returns a
   `dev-skipped-*` sid. Rev 1 marked such a row `delivered` and deleted the
   recording, parking it outside both retry and delivery forever. Now it returns
   `'skipped'`, which is the same contract the Telegram path already honors.
3. **Per-line delivery was only half done.** The route's bootstrap gate and its
   `unfetchable`/`failed` operator alerts still assumed Zul, so a primary voicemail
   was undeliverable when her chat id was unset and its failures alerted her
   instead of Dallas. Task 6 now makes that tail line-aware.
4. **`/inbound` now fails closed too**, per spec section 8's explicit "ALL voice
   webhooks", instead of being silently narrowed to only the routes this plan adds.
5. **The public phone constants split is now a task** (rev 1 filed a code change as
   an owner checkbox; an owner cannot split a JS constant).
6. Canary corrections (`SENTRY_DSN_SERVER` must be set in the test; `line` and
   `tail` must be resolved ABOVE the cheap-branch return or the block is
   unreachable), an honest file-size budget with a second extraction, review
   checkpoints added for the two batches that most needed one (the live-path
   rewrite and the spend-guard SQL), the atomic extraction moved into Task 1, and
   the harness corrections the feasibility pass found (`vaCallingDdl()` not
   `vaCallingSql`, `dbTest` not `test`, `claim.fromE164` not `claimed.fromE164`,
   explicit `notificationsEnabled`, `sid()` numbering from 40, `$DATABASE_URL` for
   psql in a lane shell).

**Scope note.** This is Phase **1a** of the spec's Phase 1. It deliberately excludes transcription, the AI summary/tag, R2 audio storage, the listen-link page, and the 14-day purge; those are Phase **1b** and get their own plan. 1a leaves the existing Twilio-fetch delivery path intact, so the shipped redelivery sweep keeps working unchanged. Phase 2 (moving client SMS off the 888 to the 1922) is gated on 224 A2P approval and is out of scope here.

## Global Constraints

- **No em dashes** in any copy, comment prose, or spoken text. Commas, periods, colons, parentheticals only.
- **Every voice webhook in this plan fails CLOSED on signature, in every environment.** Use the `requireSignature` shape (`server/routes/voice.js:172-183`, mirrored from `server/routes/voiceLeadCall.js:62-71`). Do NOT use `passesSignature` (`voice.js:212-227`), which has a `NODE_ENV !== 'production'` warn-and-allow skip. The pre-existing `/inbound` handler keeps `passesSignature` unchanged; every route this plan ADDS uses the fail-closed gate.
- **`xmlEscape` escapes `& < >` and NOT quotes** (`server/utils/xmlEscape.js`). Therefore every value interpolated into a TwiML **attribute** must be safe by construction: a validated integer, a fixed enum member, an env-provided strict-E.164 string, or a URL we built. Free text goes in element text only. This invariant is already stated at `voiceLeadCall.js:181-184`; keep it.
- **Escalation dial targets come ONLY from env** (`VA_CELL`, `VM_PRIMARY_DIAL_TARGET`), validated to strict E.164 before use. A caller-supplied value must never reach a `<Dial>`.
- **`VM_ESCALATION_ENABLED` defaults OFF.** With it off, the 0082 line must emit byte-identical TwiML to what production emits today (greeting then `<Record>`, no `<Gather>`). This is the protect-working-paths requirement: the 0082 voicemail path is live and battle-tested.
- **`line` is a fixed enum, never free text.** `resolveLine` coerces anything unrecognized to `'zul'`, which is both the safe default and the correct value for every row that predates this change.
- All SQL parameterized (`$1`, `$2`). Schema statements idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
- Webhook handlers return TwiML or a bare status code and never throw `AppError`, matching `voice.js` and `voiceLeadCall.js`.
- Log every branch with the existing last-4 redaction idiom (`String(x).slice(-4)`). Caller numbers and chat ids are never logged in full.
- **Schema is applied by `initDb()`** in `server/db/index.js` on boot. There is no `applySchema.js`.
- **Server suites run ONE AT A TIME against the shared dev DB:** `node -r dotenv/config --test <file>`. The lane has no `.env` of its own; pass `dotenv_config_path=/home/drbartender/projects/os/.env` when running from a worktree.
- **File-size discipline:** `server/routes/voice.js` is **624 lines** today against a 700-line soft cap. This plan moves `greetingVerb`, `GREETING_TEXT`, and `vmMaxLengthSec` OUT of it into `server/utils/voicemailTwiml.js` before adding the primary handler, which keeps the file near 670. Do not skip the extraction: adding the new handler without it pushes past the cap.
- Money is not touched. No pricing, invoice, or payout surface is in scope.
- Line cites were verified 2026-07-26. Where a cite and the code disagree by a line or two, trust the described content, not the number.

## Lane map

```yaml
lanes:
  - id: phone-1a
    footprint:
      - server/db/schema.sql
      - server/db/schema.vaCalling.test.js
      - server/utils/voicemailLine.js
      - server/utils/voicemailLine.test.js
      - server/utils/voicemailTwiml.js
      - server/utils/voicemailTwiml.test.js
      - server/utils/voicemailEscalation.js
      - server/utils/voicemailEscalation.test.js
      - server/utils/voicemail.js
      - server/utils/voicemail.test.js
      - server/utils/vaCallingScheduler.js
      - server/utils/vaCallingScheduler.test.js
      - server/routes/voice.js
      - server/routes/voice.test.js
      - server/routes/voiceEscalate.js
      - server/routes/voiceEscalate.test.js
      - server/index.js
      - client/src/utils/constants.js
      - client/src/pages/Completion.js
      - client/src/pages/ApplicationStatus.js
      - client/src/pages/FieldGuide.js
      - client/src/pages/PaydayProtocols.js
      - client/src/pages/proposal/proposalView/ProposalView.js
      - scripts/sensitive-paths.txt
      - .env.example
      - .claude/CLAUDE.md
      - README.md
      - ARCHITECTURE.md
    depends_on: []
    review_fleet: [security-review, database-review, code-review, consistency-check]
```

**One lane, deliberately.** Every candidate split lands in `server/routes/voice.js` two or more times: the `line` plumbing, the primary handler, and the `<Gather>` wrapper all edit it, and the delivery task edits `server/utils/voicemail.js` which the plumbing task also touches. Splitting buys no parallelism (the tasks are strictly sequential: the util must exist before the route that calls it) and buys real merge pain in a live billed-voice file.

Full review fleet regardless of size: `server/routes/voice.js`, `server/utils/voicemail.js`, `server/utils/telegram.js`, `server/utils/sms.js`, and `server/utils/twilioSignature.js` are already on `scripts/sensitive-paths.txt`. Task 1 adds the four new modules. This is a billed-voice path, so `/second-opinion` runs alongside the fleet at push.

**Task order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Strictly sequential.

The seven code tasks are review-and-bisect units, NOT independently deployable
increments. Between Task 3 and Task 6 the tree is knowingly in a half state (the
primary handler stamps `line=primary` while delivery still ignores it, so a primary
voicemail would go to Zul's Telegram). That is harmless because nothing reaches
`/inbound/primary` until the Twilio webhook is repointed after deploy, but do not
merge or cherry-pick a partial lane.

**Per-task review checkpoints** (mid-build checks, scoped to the batch; the lane fleet still runs at merge):

| After | Agent | Why |
|---|---|---|
| Task 1, commit 1 (schema) | `database-review` | The four new columns, the `NOT NULL DEFAULT 'zul'` backfill semantics, and the CHECK enums. Fires on the schema commit alone so the reviewer is not reading 200 lines of unrelated JS. |
| Task 1, commit 2 (utils) | `code-review` | `escalationTargetFor` is the only thing between env config and a `<Dial>` attribute, and the quiet-window and canary logic are pure functions worth a read before any route calls them. |
| Task 2 | `code-review` | The ONLY batch that rewrites the live 0082 document and changes a live `<Dial action>` URL, and it makes `/inbound` fail closed. "Byte-identical when escalation is off" is the whole safety claim; someone other than the author should check it. |
| Task 3 | `security-review` + `code-review` | A new public webhook that places a billed `<Dial>` (signature gate, limiter bucket, attribute safety), PLUS the canary, which edits the live shared missed handler and moves its early-return boundary. |
| Task 4 | `database-review` | The toll-fraud spend guard itself: the `escalated_at IS NULL` claim, the rolling-window count, and the accept/read pair the caller-stranding fix depends on. No database reviewer sees this SQL otherwise, because the Task 1 checkpoint fires before it exists. |
| Task 5 | `security-review` + `code-review` | The escalation end to end: claim guard, cap, quiet window, the whisper screen and its acceptance state, attribute safety, and the `<Gather>` change to a live path. |
| Task 6 | `code-review` + `security-review` | Per-line delivery: the gated-send contract, the line-aware route tail, the internal SMS bypassing the client ledger and consent path, and no PII in logs. |
| Task 7 | `code-review` | A client-facing constant split where getting it backwards points client texting at an unapproved number. |
| Task 8 | `consistency-check` | Docs against the code that actually landed. |

---

## Lane: phone-1a

### Task 1: The `line` concept, its schema, and the two pure helper modules

Three columns and two new pure-ish modules. Everything downstream imports these, so it lands first. No route file is touched in this task.

**Files:**
- Modify: `server/db/schema.sql` (append inside the voicemail block, after the `idx_voicemail_delivery_created_at` index at line 3638-3639, before the "Proposal option groups" divider)
- Modify: `server/db/schema.vaCalling.test.js`
- Modify: `scripts/sensitive-paths.txt`
- Create: `server/utils/voicemailLine.js`
- Create: `server/utils/voicemailLine.test.js`
- Create: `server/utils/voicemailTwiml.js`
- Create: `server/utils/voicemailTwiml.test.js`

**Interfaces:**
- Consumes: `xmlEscape` from `server/utils/xmlEscape.js`; `API_URL` from `server/utils/urls.js`.
- Produces:
  - `voicemailLine.js`: `LINES` (frozen `['primary','zul']`), `resolveLine(raw) => 'primary'|'zul'`, `escalationTargetFor(line) => string|null`, `inQuietWindow(line, now) => boolean`, `quietWindowFor(line) => {start,end,tz}|null`, `primaryRingSec() => number`, `interceptionSuspicion({line, status, dialCallDuration}) => {suspect: boolean, dialSec: number|null}`
  - `voicemailTwiml.js`: `GREETING_TEXT_ZUL`, `GREETING_TEXT_PRIMARY`, `ESCALATION_PROMPT_TEXT`, `vmMaxLengthSec() => number`, `greetingVerbForLine(line) => string`, `escalationPromptVerb() => string`, `recordVerb() => string`, `escalationEnabled() => boolean`

- [ ] **Step 1: Add the three columns to `server/db/schema.sql`**

Append directly after the `idx_voicemail_delivery_created_at` index (schema.sql:3638-3639), before the "Proposal option groups" divider:

```sql
-- Phase 1a (spec 2026-07-26): the phone system became two-line, so every row
-- must record WHICH number the call arrived on. `line` drives three decisions
-- downstream: which greeting plays, who a press-1 escalation rings, and which
-- channel the voicemail is delivered on. Getting it wrong delivers a client's
-- voicemail to the wrong person, so it is NOT NULL.
--
-- NOT NULL DEFAULT 'zul' is also the backfill: every row that predates this
-- column was a 224-0082 (Zul) call, which is exactly what the default assigns,
-- so no separate UPDATE is needed and a re-run cannot corrupt anything. The
-- default is a migration device, not a fallback the live path relies on:
-- claimMissedCall always passes an explicit line (see voicemail.js).
ALTER TABLE voicemail_delivery
  ADD COLUMN IF NOT EXISTS line TEXT NOT NULL DEFAULT 'zul';
DO $$ BEGIN
  ALTER TABLE voicemail_delivery DROP CONSTRAINT IF EXISTS voicemail_delivery_line_check;
  ALTER TABLE voicemail_delivery
    ADD CONSTRAINT voicemail_delivery_line_check CHECK (line IN ('primary','zul'));
END $$;

-- escalated_at is the press-1 escalation's CLAIM and its spend window, the same
-- double duty call_sid's PK serves for the missed-call ping. Twilio delivers a
-- <Gather action> at least once, so the claim is what stops a redelivered
-- callback from placing a SECOND billed leg. Counting rows where it is NOT NULL
-- inside a rolling 24h is VM_ESCALATION_DAILY_CAP.
ALTER TABLE voicemail_delivery
  ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
-- escalation_accepted_at is set ONLY when a human presses a key on the whisper,
-- and it is the thing escalate/done branches on. It has to exist because
-- DialCallStatus cannot answer the question: a carrier voicemail that picks up
-- and is then hung up by the whisper's screen is still an ANSWERED child leg, so
-- Twilio reports 'completed' for both "they talked" and "a machine grabbed it and
-- we rejected it". Trusting that status hangs up on a caller who never reached a
-- person. Explicit acceptance state is the only reliable discriminator.
ALTER TABLE voicemail_delivery
  ADD COLUMN IF NOT EXISTS escalation_accepted_at TIMESTAMPTZ;
-- Why the escalation ended. Observability only; nothing branches on it.
ALTER TABLE voicemail_delivery
  ADD COLUMN IF NOT EXISTS escalation_outcome TEXT;
DO $$ BEGIN
  ALTER TABLE voicemail_delivery DROP CONSTRAINT IF EXISTS voicemail_delivery_esc_outcome_check;
  ALTER TABLE voicemail_delivery
    ADD CONSTRAINT voicemail_delivery_esc_outcome_check CHECK (
      escalation_outcome IS NULL OR escalation_outcome IN (
        'answered','no_answer','declined','skipped_cap','skipped_quiet','skipped_no_target'
      )
    );
END $$;
-- Partial index: the cap counts only escalated rows, which are a small minority.
CREATE INDEX IF NOT EXISTS idx_voicemail_delivery_escalated_at
  ON voicemail_delivery (escalated_at) WHERE escalated_at IS NOT NULL;
```

- [ ] **Step 2: Apply the schema to the dev DB**

Run: `node -r dotenv/config -e "require('./server/db').initDb().then(() => process.exit(0))"`
Expected: exits 0. Statements are idempotent, so a re-run is safe.

**A lane worktree has no `.env`** (`scripts/worktree-new.js` symlinks only
`node_modules`, `client/node_modules`, and `.husky/_`), so `$DATABASE_URL` is empty
in a lane shell and bare `psql` would silently fall back to a local socket. Export
it first for every psql step in this plan:

```bash
export DATABASE_URL=$(grep -oP '(?<=^DATABASE_URL=).*' /home/drbartender/projects/os/.env | tr -d '"')
```

Verify: `psql "$DATABASE_URL" -c "\d voicemail_delivery"` lists `line` (not null, default `'zul'`), `escalated_at`, `escalation_accepted_at`, `escalation_outcome`, both new CHECK constraints, and the partial index.

Verify the backfill actually landed on existing rows:
Run: `psql "$DATABASE_URL" -c "SELECT line, COUNT(*) FROM voicemail_delivery GROUP BY line"`
Expected: every pre-existing row reads `zul`, and zero rows read NULL.

- [ ] **Step 3: Extend `server/db/schema.vaCalling.test.js`**

That suite slices `schema.sql` from the `-- Zul VA Calling` marker to EOF via the
`vaCallingDdl()` FUNCTION (`schema.vaCalling.test.js:53-58`) and executes the slice
in its `before()`, so this DDL is already inside its scope.

Three harness facts to match exactly, all verified:
- The whole-file string is `schemaSql` (`:8`); the existing CONTENT tests assert
  against it. There is no `vaCallingSql` variable.
- `pool` is only assigned inside `before()` when `HAS_DB` (`:47-50, :60-67`), so any
  test that touches the DB must use `dbTest` (`:48`, which is `test.skip` without a
  `DATABASE_URL`), never a bare `test`.
- A `DO $$ ... END $$` block is new to `schema.sql`; the feasibility pass confirmed
  the suite's `splitStatements` keeps it intact.

```js
test('voicemail_delivery carries the line + escalation columns idempotently', () => {
  assert.match(schemaSql, /ADD COLUMN IF NOT EXISTS line TEXT NOT NULL DEFAULT 'zul'/);
  assert.match(schemaSql, /CHECK \(line IN \('primary','zul'\)\)/);
  assert.match(schemaSql, /ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ/);
  assert.match(schemaSql, /ADD COLUMN IF NOT EXISTS escalation_accepted_at TIMESTAMPTZ/);
  assert.match(schemaSql, /ADD COLUMN IF NOT EXISTS escalation_outcome TEXT/);
  assert.match(schemaSql, /idx_voicemail_delivery_escalated_at/);
});

test('the new DDL is inside the slice the suite actually applies', () => {
  // Guard against the block being appended below the slice boundary, which would
  // make the catalog tests below pass only because someone ran initDb by hand.
  assert.match(vaCallingDdl(), /ADD COLUMN IF NOT EXISTS line TEXT NOT NULL/);
});

dbTest('line is NOT NULL and defaults to zul so old rows backfill', async () => {
  const { rows } = await pool.query(
    `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'voicemail_delivery'
        AND column_name IN ('line','escalated_at','escalation_accepted_at','escalation_outcome')
      ORDER BY column_name`
  );
  const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));
  assert.equal(byName.line.is_nullable, 'NO');
  assert.match(byName.line.column_default, /'zul'/);
  assert.equal(byName.escalated_at.is_nullable, 'YES');
  assert.equal(byName.escalation_outcome.is_nullable, 'YES');
});

dbTest('the line CHECK rejects an unknown line', async () => {
  await assert.rejects(
    () => pool.query(
      `INSERT INTO voicemail_delivery (call_sid, line) VALUES ($1, 'not-a-line')`,
      ['CAschemaline' + '0'.repeat(20)]
    ),
    /voicemail_delivery_line_check/
  );
});
```

Run: `node -r dotenv/config --test server/db/schema.vaCalling.test.js`
Expected: PASS, including the pre-existing assertions.

- [ ] **Step 4: Register the new modules as sensitive**

In `scripts/sensitive-paths.txt`, inside the 224-inbound-voicemail block (currently `server/utils/telegram.js` + `server/utils/voicemail.js`), add:

```
server/utils/voicemailLine.js
server/utils/voicemailTwiml.js
server/utils/voicemailEscalation.js
server/routes/voiceEscalate.js
```

`scripts/sensitive-match.js` anchors globs so they never cross `/`, and no existing `server/utils/*` or `server/routes/*` glob matches these files.

Verify (real red/green, the matcher is CLI-runnable and grep-style exit-coded):

Run: `node scripts/sensitive-match.js server/utils/voicemailLine.js server/utils/voicemailTwiml.js server/utils/voicemailEscalation.js server/routes/voiceEscalate.js`
Expected: before the edit, exit 1 and no output. After, exit 0 and all four paths printed.

- [ ] **Step 5: Write the failing test for `voicemailLine.js`**

Create `server/utils/voicemailLine.test.js`:

```js
require('dotenv').config();
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const line = require('./voicemailLine');

const SAVED = { ...process.env };
beforeEach(() => {
  delete process.env.VM_PRIMARY_DIAL_TARGET;
  delete process.env.VM_ESCALATION_QUIET_ZUL;
  delete process.env.VM_ESCALATION_QUIET_PRIMARY;
  process.env.VA_CELL = '+639171234567';
});
after(() => { process.env = { ...SAVED }; });

test('resolveLine accepts primary and defaults everything else to zul', () => {
  assert.equal(line.resolveLine('primary'), 'primary');
  assert.equal(line.resolveLine('zul'), 'zul');
  // The default is load-bearing: an un-stamped call is a 0082 call, and every
  // row that predates the line column was Zul's.
  assert.equal(line.resolveLine(undefined), 'zul');
  assert.equal(line.resolveLine(''), 'zul');
  assert.equal(line.resolveLine('PRIMARY'), 'zul', 'exact match only, no case folding');
  assert.equal(line.resolveLine('../primary'), 'zul');
  assert.equal(line.resolveLine({}), 'zul');
});

test('escalationTargetFor crosses the lines', () => {
  process.env.VM_PRIMARY_DIAL_TARGET = '+13125889401';
  // A caller on Dallas's line who presses 1 reaches Zul, and vice versa.
  assert.equal(line.escalationTargetFor('primary'), '+639171234567');
  assert.equal(line.escalationTargetFor('zul'), '+13125889401');
});

test('escalationTargetFor returns null for a missing or malformed target', () => {
  delete process.env.VM_PRIMARY_DIAL_TARGET;
  assert.equal(line.escalationTargetFor('zul'), null, 'unset target must not dial');
  process.env.VM_PRIMARY_DIAL_TARGET = '3125889401';
  assert.equal(line.escalationTargetFor('zul'), null, 'not strict E.164');
  process.env.VM_PRIMARY_DIAL_TARGET = '+1312588940"><Dial>evil</Dial>';
  assert.equal(line.escalationTargetFor('zul'), null, 'a quote must never reach an attribute');
});

test('quietWindowFor parses HH:MM-HH:MM and rejects junk', () => {
  process.env.VM_ESCALATION_QUIET_ZUL = '22:00-08:00';
  assert.deepEqual(line.quietWindowFor('primary'), { start: 1320, end: 480, tz: 'Asia/Manila' },
    'the primary line escalates TO Zul, so Zul\'s window applies');
  process.env.VM_ESCALATION_QUIET_ZUL = 'banana';
  assert.equal(line.quietWindowFor('primary'), null, 'unparseable means no quiet window');
  process.env.VM_ESCALATION_QUIET_ZUL = '';
  assert.equal(line.quietWindowFor('primary'), null, 'empty string disables it');
});

test('inQuietWindow honors a window that wraps midnight', () => {
  process.env.VM_ESCALATION_QUIET_ZUL = '22:00-08:00';
  // 03:00 Asia/Manila is 19:00 UTC the previous day.
  const threeAmManila = new Date('2026-07-27T19:00:00Z');
  assert.equal(line.inQuietWindow('primary', threeAmManila), true);
  // 14:00 Asia/Manila is 06:00 UTC.
  const twoPmManila = new Date('2026-07-27T06:00:00Z');
  assert.equal(line.inQuietWindow('primary', twoPmManila), false);
});

test('inQuietWindow is false when no window is configured', () => {
  delete process.env.VM_ESCALATION_QUIET_ZUL;
  assert.equal(line.inQuietWindow('primary', new Date('2026-07-27T19:00:00Z')), false);
});

test('primaryRingSec defaults to 18 and clamps to 5..30', () => {
  delete process.env.VM_PRIMARY_RING_SEC;
  assert.equal(line.primaryRingSec(), 18);
  process.env.VM_PRIMARY_RING_SEC = '1';
  assert.equal(line.primaryRingSec(), 5);
  process.env.VM_PRIMARY_RING_SEC = '600';
  assert.equal(line.primaryRingSec(), 30, 'must stay under a carrier voicemail pickup');
  delete process.env.VM_PRIMARY_RING_SEC;
});

test('interceptionSuspicion fires only on an instant answer on the primary line', () => {
  const s = (o) => line.interceptionSuspicion(o).suspect;
  assert.equal(s({ line: 'primary', status: 'completed', dialCallDuration: '1' }), true);
  assert.equal(s({ line: 'primary', status: 'completed', dialCallDuration: '45' }), false,
    'a real conversation is not an anomaly');
  assert.equal(s({ line: 'zul', status: 'completed', dialCallDuration: '1' }), false,
    'Zul dials her cell directly; the canary is for the forwarded hop');
  assert.equal(s({ line: 'primary', status: 'no-answer', dialCallDuration: '0' }), false);
  assert.equal(s({ line: 'primary', status: 'completed', dialCallDuration: '0' }), false,
    'zero means never connected, not instantly answered');
  assert.equal(s({ line: 'primary', status: 'completed', dialCallDuration: undefined }), false);
  assert.equal(line.interceptionSuspicion({
    line: 'primary', status: 'completed', dialCallDuration: '7',
  }).dialSec, 7, 'the parsed duration comes back for the log line');
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `node -r dotenv/config --test server/utils/voicemailLine.test.js`
Expected: FAIL, `Cannot find module './voicemailLine'`.

- [ ] **Step 7: Write `server/utils/voicemailLine.js`**

```js
// server/utils/voicemailLine.js
//
// Which LINE a call arrived on, and the routing policy that follows from it.
//
// Phase 1a (spec 2026-07-26) made the phone system two-line: +12242221922 is
// Dallas (the primary business number) and +12242220082 is Zul. One shared
// missed-call handler serves both, so `line` is the single input that decides
// which greeting plays, who a press-1 escalation rings, and (in voicemail.js)
// which channel the voicemail is delivered on.
//
// Pure except for env reads, so it is unit-testable with no DB and no network.

const LINES = Object.freeze(['primary', 'zul']);

// Strict E.164. Deliberately the same shape the rest of the voice code demands:
// escalation targets are interpolated into a TwiML ATTRIBUTE, and xmlEscape does
// not escape quotes, so anything that is not bare +digits is refused outright
// rather than escaped and hoped for.
const E164_RE = /^\+[1-9]\d{6,14}$/;

// Default quiet-hour timezones. Zul is a PH VA; Dallas is Chicago.
const DEFAULT_TZ = Object.freeze({ zul: 'Asia/Manila', primary: 'America/Chicago' });

/**
 * Coerce an untrusted line value (it arrives in a webhook query string) to a
 * member of the enum. Anything unrecognized becomes 'zul', which is both the
 * safe default and the correct answer: the 0082 line is the one that predates
 * this column, and an un-stamped <Dial action> is a 0082 call.
 * @param {*} raw
 * @returns {'primary'|'zul'}
 */
function resolveLine(raw) {
  return raw === 'primary' ? 'primary' : 'zul';
}

/** The person a press-1 on `line` should ring: the OTHER one. */
function otherLine(line) {
  return resolveLine(line) === 'primary' ? 'zul' : 'primary';
}

/**
 * The strict-E.164 number a press-1 on `line` dials, or null when it is unset or
 * malformed (in which case the caller skips the dial and goes to voicemail).
 * Env only. A caller-supplied value must never reach a <Dial>.
 */
function escalationTargetFor(line) {
  const target = otherLine(line);
  const raw = String(
    (target === 'zul' ? process.env.VA_CELL : process.env.VM_PRIMARY_DIAL_TARGET) || ''
  ).trim();
  return E164_RE.test(raw) ? raw : null;
}

/** "HH:MM" to minutes past midnight, or null. */
function parseHhMm(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * The quiet window for the person `line` escalates TO, in that person's local
 * time. Format `HH:MM-HH:MM`; unset, empty, or unparseable means no window.
 * @returns {{start:number,end:number,tz:string}|null} minutes past midnight
 */
function quietWindowFor(line) {
  const target = otherLine(line);
  const raw = target === 'zul'
    ? process.env.VM_ESCALATION_QUIET_ZUL
    : process.env.VM_ESCALATION_QUIET_PRIMARY;
  const parts = String(raw || '').trim().split('-');
  if (parts.length !== 2) return null;
  const start = parseHhMm(parts[0]);
  const end = parseHhMm(parts[1]);
  if (start === null || end === null) return null;
  const tzEnv = target === 'zul'
    ? process.env.VM_ESCALATION_TZ_ZUL
    : process.env.VM_ESCALATION_TZ_PRIMARY;
  return { start, end, tz: String(tzEnv || DEFAULT_TZ[target]) };
}

/** Minutes past midnight for `d` in IANA zone `tz`. */
function minutesInZone(d, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  // hour can format as 24 at midnight in some ICU versions; fold it to 0.
  return (get('hour') % 24) * 60 + get('minute');
}

/**
 * True when escalating on `line` right now would ring the other person during
 * their quiet hours. A window whose end is before its start wraps midnight
 * (22:00-08:00 is the normal case).
 */
function inQuietWindow(line, now = new Date()) {
  const w = quietWindowFor(line);
  if (!w) return false;
  let mins;
  try {
    mins = minutesInZone(now, w.tz);
  } catch (err) {
    // A bad IANA zone must not break a live call. Treat it as no quiet window.
    console.warn(`[voicemailLine] bad quiet-window timezone "${w.tz}": ${err.message}`);
    return false;
  }
  return w.start <= w.end
    ? (mins >= w.start && mins < w.end)
    : (mins >= w.start || mins < w.end);
}

/**
 * Ring seconds on the primary line before Twilio calls it a miss.
 *
 * Deliberately SHORTER than a typical carrier or Google Voice voicemail pickup
 * (around 25 seconds). If the target's own voicemail answers first, Twilio
 * reports DialCallStatus=completed, our missed handler correctly does nothing,
 * and the caller lands in a dumb voicemail we cannot transcribe or route. Ringing
 * out first is the primary mitigation for that; disabling voicemail on the target
 * is the other, and it is a manual console setting we cannot enforce from here.
 */
function primaryRingSec() {
  const n = parseInt(process.env.VM_PRIMARY_RING_SEC, 10);
  return Math.min(30, Math.max(5, Number.isFinite(n) ? n : 18));
}

// An answer this fast is not a person picking up a phone, it is an auto-attendant.
const PRIMARY_INSTANT_ANSWER_SEC = 3;

/**
 * Interception canary for the primary line (spec section 2 mitigation c).
 *
 * Honest about its limits: a machine and a human both answering at 25 seconds are
 * indistinguishable in this callback, so there is no reliable detector. What IS
 * detectable is an answer far too fast for a person to have reached the phone,
 * which is the signature of carrier or Google Voice voicemail re-enabling on the
 * dial target and quietly stealing every caller from our own voicemail. Nothing
 * branches on the result; it exists so the regression cannot be invisible.
 *
 * Only meaningful on the primary line, which forwards through a third party. Zul's
 * line dials her cell directly and has always behaved this way.
 */
function interceptionSuspicion({ line, status, dialCallDuration }) {
  const parsed = parseInt(dialCallDuration, 10);
  const dialSec = Number.isFinite(parsed) ? parsed : null;
  const suspect = resolveLine(line) === 'primary'
    && status === 'completed'
    && dialSec !== null && dialSec > 0 && dialSec <= PRIMARY_INSTANT_ANSWER_SEC;
  return { suspect, dialSec };
}

module.exports = {
  LINES, resolveLine, otherLine, escalationTargetFor, quietWindowFor, inQuietWindow,
  primaryRingSec, interceptionSuspicion, PRIMARY_INSTANT_ANSWER_SEC,
};
```

- [ ] **Step 8: Run the test to confirm it passes**

Run: `node -r dotenv/config --test server/utils/voicemailLine.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 9: Write the failing test for `voicemailTwiml.js`**

Create `server/utils/voicemailTwiml.test.js`:

```js
require('dotenv').config();
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const twiml = require('./voicemailTwiml');

const SAVED = { ...process.env };
beforeEach(() => {
  delete process.env.VM_GREETING_URL;
  delete process.env.VM_GREETING_URL_PRIMARY;
  delete process.env.VM_ESCALATION_ENABLED;
  delete process.env.VM_ESCALATION_PROMPT;
  process.env.VM_MAX_LENGTH_SEC = '120';
});
after(() => { process.env = { ...SAVED }; });

test('zul greeting default is the bundled recording, unchanged from production', () => {
  const out = twiml.greetingVerbForLine('zul');
  assert.match(out, /^<Play>[^<]*\/api\/voice\/greeting\.mp3<\/Play>$/);
  assert.doesNotMatch(out, /<Say/);
});

test('zul greeting honors the existing VM_GREETING_URL override and say kill switch', () => {
  process.env.VM_GREETING_URL = 'https://cdn.example.com/z.mp3';
  assert.match(twiml.greetingVerbForLine('zul'), /<Play>https:\/\/cdn\.example\.com\/z\.mp3<\/Play>/);
  process.env.VM_GREETING_URL = 'say';
  const said = twiml.greetingVerbForLine('zul');
  assert.match(said, /<Say voice="Polly\.Joanna-Neural">/);
  assert.match(said, /This is Zul/);
});

test('primary greeting defaults to the synthetic Dallas text until a recording exists', () => {
  // Dallas has not recorded his greeting yet, and Zul's recording says "This is
  // Zul", so the primary line must NOT fall back to it.
  const out = twiml.greetingVerbForLine('primary');
  assert.match(out, /<Say voice="Polly\.Joanna-Neural">/);
  assert.match(out, /Dallas/);
  assert.doesNotMatch(out, /This is Zul/);
});

test('primary greeting switches to Play when VM_GREETING_URL_PRIMARY is a url', () => {
  process.env.VM_GREETING_URL_PRIMARY = 'https://cdn.example.com/d.mp3';
  assert.match(twiml.greetingVerbForLine('primary'), /<Play>https:\/\/cdn\.example\.com\/d\.mp3<\/Play>/);
  assert.doesNotMatch(twiml.greetingVerbForLine('primary'), /<Say/);
});

test('the two lines never share a greeting', () => {
  assert.notEqual(twiml.greetingVerbForLine('primary'), twiml.greetingVerbForLine('zul'));
});

test('recordVerb carries the clamped maxLength, the status callback, and no action', () => {
  const out = twiml.recordVerb();
  assert.match(out, /<Record[^>]*maxLength="120"/);
  assert.match(out, /recordingStatusCallback="[^"]*\/api\/voice\/inbound\/voicemail"/);
  assert.match(out, /recordingStatusCallbackEvent="completed"/);
  // No action attribute: Twilio skips it when the caller hangs up, which is the
  // normal way a voicemail ends. Delivery hangs off recordingStatusCallback.
  assert.doesNotMatch(out, /\saction=/);
});

test('vmMaxLengthSec clamps to 30..300 and defaults to 120', () => {
  process.env.VM_MAX_LENGTH_SEC = '5';
  assert.equal(twiml.vmMaxLengthSec(), 30);
  process.env.VM_MAX_LENGTH_SEC = '9000';
  assert.equal(twiml.vmMaxLengthSec(), 300);
  delete process.env.VM_MAX_LENGTH_SEC;
  assert.equal(twiml.vmMaxLengthSec(), 120);
});

test('escalationEnabled defaults OFF and only true enables it', () => {
  assert.equal(twiml.escalationEnabled(), false);
  process.env.VM_ESCALATION_ENABLED = 'yes';
  assert.equal(twiml.escalationEnabled(), false);
  process.env.VM_ESCALATION_ENABLED = 'true';
  assert.equal(twiml.escalationEnabled(), true);
});

test('escalationPromptVerb speaks the option by default and is suppressible', () => {
  // The greetings currently in production do NOT mention press 1, so the option
  // has to be announced or no caller will ever know it exists.
  assert.match(twiml.escalationPromptVerb(), /<Say[^>]*>[^<]*press 1[^<]*<\/Say>/);
  process.env.VM_ESCALATION_PROMPT = 'none';
  assert.equal(twiml.escalationPromptVerb(), '', 'none means the recording already says it');
});

test('no greeting or prompt copy contains an em dash', () => {
  const all = [
    twiml.GREETING_TEXT_ZUL, twiml.GREETING_TEXT_PRIMARY, twiml.ESCALATION_PROMPT_TEXT,
  ].join(' ');
  assert.doesNotMatch(all, /—/);
});
```

- [ ] **Step 10: Run it to confirm it fails**

Run: `node -r dotenv/config --test server/utils/voicemailTwiml.test.js`
Expected: FAIL, `Cannot find module './voicemailTwiml'`.

- [ ] **Step 11: Write `server/utils/voicemailTwiml.js`**

This module is where `greetingVerb`, `GREETING_TEXT`, and `vmMaxLengthSec` MOVE TO from `server/routes/voice.js`. Two route files now emit the same fragments (`voice.js` and the `voiceEscalate.js` added in Task 5), and a drifted `<Record>` between them would silently change recording length or break delivery. One owner, no drift. Extracting them also buys back the lines the primary handler in Task 3 needs.

```js
// server/utils/voicemailTwiml.js
//
// The TwiML fragments the voicemail flow is built from, in one place because
// TWO route files emit them: server/routes/voice.js (the missed-call handler)
// and server/routes/voiceEscalate.js (the press-1 fallback back to voicemail).
// A <Record> that drifted between the two would change recording length or aim
// the delivery callback somewhere else on one path only, which is exactly the
// kind of bug that hides until a real client leaves a real voicemail.
//
// Moved here from server/routes/voice.js in Phase 1a (greetingVerb, GREETING_TEXT,
// vmMaxLengthSec), which also keeps that file under the 700-line soft cap.

const { xmlEscape } = require('./xmlEscape');
const { API_URL } = require('./urls');
const { resolveLine } = require('./voicemailLine');

// Zul's greeting copy, unchanged from what shipped 2026-07-24. Fixed text: it is
// what her recorded mp3 says, and the synthetic fallback must match the voice
// clients already hear.
const GREETING_TEXT_ZUL = "Thanks for calling Dr. Bartender. This is Zul. I'm not available right now. Please leave your name, your number, and the date of your event, and I'll call you right back.";

// Dallas's line. Synthetic until he records his own (then set
// VM_GREETING_URL_PRIMARY, no code change). Deliberately NOT Zul's copy: the
// primary line falling back to "This is Zul" would be worse than a robot voice.
const GREETING_TEXT_PRIMARY = "Hey, it's Dallas at Dr. Bartender. I can't pick up right now. Please leave your name, your number, and the date of your event, and I'll call you right back.";

// Spoken only when escalation is enabled. The greetings recorded so far do not
// mention press 1, so without this the option is invisible to callers. Once a
// greeting is re-recorded to include the line, set VM_ESCALATION_PROMPT=none.
const ESCALATION_PROMPT_TEXT = 'Or, press 1 and I will try to get someone else on the line for you.';

const SAY_OPEN = '<Say voice="Polly.Joanna-Neural">';

function vmMaxLengthSec() {
  const n = parseInt(process.env.VM_MAX_LENGTH_SEC, 10);
  return Math.min(300, Math.max(30, Number.isFinite(n) ? n : 120));
}

/** Press-1 escalation master switch. Default OFF (ships dark). */
function escalationEnabled() {
  return process.env.VM_ESCALATION_ENABLED === 'true';
}

/**
 * The greeting the caller hears, per line.
 *
 * zul:     VM_GREETING_URL         (unset -> the bundled recording; 'say' -> synthetic)
 * primary: VM_GREETING_URL_PRIMARY (unset -> synthetic; a url -> <Play> it)
 *
 * The zul branch is byte-identical to what production emits today.
 */
function greetingVerbForLine(rawLine) {
  const line = resolveLine(rawLine);
  if (line === 'primary') {
    const override = String(process.env.VM_GREETING_URL_PRIMARY || '').trim();
    if (!override || override.toLowerCase() === 'say') {
      return `${SAY_OPEN}${xmlEscape(GREETING_TEXT_PRIMARY)}</Say>`;
    }
    return `<Play>${xmlEscape(override)}</Play>`;
  }
  const override = String(process.env.VM_GREETING_URL || '').trim();
  if (override.toLowerCase() === 'say') {
    return `${SAY_OPEN}${xmlEscape(GREETING_TEXT_ZUL)}</Say>`;
  }
  const url = override || `${API_URL}/api/voice/greeting.mp3`;
  return `<Play>${xmlEscape(url)}</Play>`;
}

/** The spoken press-1 offer, or '' when the greeting already announces it. */
function escalationPromptVerb() {
  if (String(process.env.VM_ESCALATION_PROMPT || '').trim().toLowerCase() === 'none') return '';
  return `${SAY_OPEN}${xmlEscape(ESCALATION_PROMPT_TEXT)}</Say>`;
}

/**
 * The <Record> verb. Deliberately carries NO action attribute: when a caller
 * ends a voicemail by hanging up, which is the normal case, Twilio does not
 * request the record verb's action URL, so delivery hangs off
 * recordingStatusCallback instead.
 */
function recordVerb() {
  return `<Record maxLength="${vmMaxLengthSec()}" playBeep="true" trim="trim-silence" finishOnKey="#"`
    + ` recordingStatusCallback="${xmlEscape(API_URL)}/api/voice/inbound/voicemail"`
    + ' recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>';
}

module.exports = {
  GREETING_TEXT_ZUL, GREETING_TEXT_PRIMARY, ESCALATION_PROMPT_TEXT,
  vmMaxLengthSec, escalationEnabled, greetingVerbForLine, escalationPromptVerb, recordVerb,
};
```

- [ ] **Step 12: Run the test to confirm it passes**

Run: `node -r dotenv/config --test server/utils/voicemailTwiml.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 13: Commit, as TWO commits**

Two logical features live in this task (a schema migration and two new pure
modules) and they share nothing: they verify differently and they want different
reviewers. Split them so each checkpoint reads a focused diff.

```bash
git add server/db/schema.sql server/db/schema.vaCalling.test.js
git commit -m "feat(phone): voicemail_delivery line + escalation columns"
```

Run the `database-review` checkpoint here, then:

```bash
git add server/utils/voicemailLine.js server/utils/voicemailLine.test.js \
        server/utils/voicemailTwiml.js server/utils/voicemailTwiml.test.js \
        scripts/sensitive-paths.txt
git commit -m "feat(phone): per-line routing policy and shared TwiML fragments"
```

---

### Task 2: Stamp `line` through the missed-call path

`voice.js` starts using the new helpers, the `<Dial action>` on the existing `/inbound` gains `?line=zul`, and `claimMissedCall` persists the line. Behavior on the 0082 line must not change at all.

**Files:**
- Modify: `server/routes/voice.js`
- Modify: `server/routes/voice.test.js`
- Modify: `server/utils/voicemail.js`
- Modify: `server/utils/voicemail.test.js`

**Interfaces:**
- Consumes: `resolveLine` (Task 1); `greetingVerbForLine`, `recordVerb`, `vmMaxLengthSec` (Task 1).
- Produces: `claimMissedCall({ callSid, fromE164, line }) => Promise<boolean>` (the `line` parameter is now REQUIRED by every caller; the function validates it and stores it).

- [ ] **Step 1: Write the failing tests**

In `server/routes/voice.test.js`, extend the greeting/action assertions and add line coverage. The existing `beforeEach` already sets `VOICEMAIL_ENABLED`, `VM_MAX_LENGTH_SEC`, `VM_DAILY_CAP`, and deletes `VM_GREETING_URL`; add one line to it so the primary greeting override never leaks between tests:

```js
  delete process.env.VM_GREETING_URL_PRIMARY;
```

Then replace the existing `'/inbound Dial carries the missed-call action URL'` test with the stricter version below, and add the rest:

```js
test('/inbound Dial action stamps line=zul', async () => {
  const res = await post('/api/voice/inbound', { From: '+13125550147', CallSid: cs('CA1') });
  assert.match(res.text, /action="[^"]*\/api\/voice\/inbound\/missed\?line=zul"/);
  assert.match(res.text, /method="POST"/);
});

test('/inbound/missed defaults to the zul line and claims it', async () => {
  const res = await post('/api/voice/inbound/missed', {
    DialCallStatus: 'no-answer', CallSid: cs('CAline1'), From: '+13125550147',
  });
  await settle();
  assert.match(res.text, /<Play>[^<]*\/api\/voice\/greeting\.mp3<\/Play>/, 'Zul recording');
  assert.equal(calls.claims[0].line, 'zul');
});

test('/inbound/missed?line=primary claims primary and plays the Dallas greeting', async () => {
  const res = await post('/api/voice/inbound/missed?line=primary', {
    DialCallStatus: 'no-answer', CallSid: cs('CAline2'), From: '+13125550147',
  });
  await settle();
  assert.equal(calls.claims[0].line, 'primary');
  assert.match(res.text, /Dallas/);
  assert.doesNotMatch(res.text, /This is Zul/);
  assert.doesNotMatch(res.text, /greeting\.mp3/, 'Zul\'s recording must never play on Dallas\'s line');
});

test('/inbound/missed coerces an unknown line to zul', async () => {
  await post('/api/voice/inbound/missed?line=bogus', {
    DialCallStatus: 'no-answer', CallSid: cs('CAline3'), From: '+13125550147',
  });
  await settle();
  assert.equal(calls.claims[0].line, 'zul');
});
```

In `server/utils/voicemail.test.js`, add persistence coverage next to the existing `claimMissedCall` tests (reuse that file's `sid()` helper and `PREFIX` cleanup):

```js
test('claimMissedCall persists the line it is given', async () => {
  await vm.claimMissedCall({ callSid: sid(40), fromE164: '+13125550147', line: 'primary' });
  const { rows } = await pool.query('SELECT line FROM voicemail_delivery WHERE call_sid = $1', [sid(40)]);
  assert.equal(rows[0].line, 'primary');
});

test('claimMissedCall coerces a missing or unknown line to zul rather than throwing', async () => {
  // A live caller must never lose voicemail to a coding slip, and every row that
  // predates the line column was Zul's, so zul is the correct coercion.
  await vm.claimMissedCall({ callSid: sid(41), fromE164: null });
  await vm.claimMissedCall({ callSid: sid(42), fromE164: null, line: 'nope' });
  const { rows } = await pool.query(
    'SELECT call_sid, line FROM voicemail_delivery WHERE call_sid = ANY($1) ORDER BY call_sid',
    [[sid(41), sid(42)]]
  );
  assert.deepEqual(rows.map((r) => r.line), ['zul', 'zul']);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node -r dotenv/config --test server/routes/voice.test.js`
Expected: FAIL on the `?line=zul` action assertion and on `calls.claims[0].line` being undefined.

Run: `node -r dotenv/config --test server/utils/voicemail.test.js`
Expected: FAIL, `line` column comes back `'zul'` for the primary case (the default) rather than `'primary'`.

- [ ] **Step 3: Persist `line` in `server/utils/voicemail.js`**

Replace `claimMissedCall` (currently `voicemail.js:54-63`):

```js
/**
 * Register a missed inbound call. The INSERT is also the missed-call ping's
 * dedup claim: Twilio delivers <Dial action> at least once, so only the request
 * that wins the PK may ping and offer a recording.
 *
 * `line` decides who this voicemail is eventually DELIVERED to, so it is written
 * explicitly on every insert rather than left to the column default. An absent
 * or unrecognized value is coerced to 'zul' (never thrown): a live caller must
 * not lose their voicemail to a coding slip, and 'zul' is both the safe default
 * and the correct value for the line that predates this column.
 *
 * @param {{callSid: string, fromE164: string|null, line?: 'primary'|'zul'}} args
 * @returns {Promise<boolean>} true iff this caller won the claim.
 */
async function claimMissedCall({ callSid, fromE164, line }) {
  const safeLine = resolveLine(line);
  const { rows } = await _deps.pool.query(
    `INSERT INTO voicemail_delivery (call_sid, from_e164, line)
     VALUES ($1, $2, $3)
     ON CONFLICT (call_sid) DO NOTHING
     RETURNING call_sid`,
    [callSid, fromE164 ?? null, safeLine]
  );
  return rows.length > 0;
}
```

Add the import near the top of the file, beside the existing requires:

```js
const { resolveLine } = require('./voicemailLine');
```

- [ ] **Step 4: Use the helpers in `server/routes/voice.js`**

Four edits.

**(a)** Replace the greeting/length block (`voice.js:113-140`, the `vmMaxLengthSec`, `GREETING_TEXT`, and `greetingVerb` definitions) with imports. Keep `voicemailEnabled()` and `vmDailyCap()` where they are. Add near the other requires at the top:

```js
const { resolveLine } = require('../utils/voicemailLine');
const { greetingVerbForLine, recordVerb } = require('../utils/voicemailTwiml');
```

Import ONLY what this task uses. `escalationEnabled` and `escalationPromptVerb` are
added to this same import in Task 5, where they are first called. Tasks 2 and 5 are
sequential commits on one branch, not parallel lanes, so there is no collision to
pre-empt, and importing them early would leave one commit carrying dead imports.

**(b0) Make `/inbound` fail closed.** Spec section 8 says ALL voice webhooks fail
closed in every environment, and `/inbound` is the one still on `passesSignature`
(`voice.js:248`), which warns and allows whenever `NODE_ENV !== 'production'`. It
places the billed international `<Dial>` to `VA_CELL`, which is the exact risk class
that rule exists for, and its two downstream handlers already fail closed. Swap it:

```js
router.post('/inbound', inboundForwardLimiter, (req, res) => {
  if (!requireSignature(req, res, 'inbound')) return;
```

Consequence to accept knowingly: a local or curl request to `/inbound` without a
valid Twilio signature now gets a 403 instead of a warned-but-served dial. Every
existing test stubs `isValidTwilioRequest`, so the suite is unaffected. `passesSignature`
stays in the file for `/bridge` and `/status`, which do not place a new billed leg.

Add a test alongside the other signature tests:

```js
test('/inbound fails CLOSED on a bad signature with NODE_ENV unset', async () => {
  const saved = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  router.__setVoiceDeps({ isValidTwilioRequest: () => false });
  const res = await post('/api/voice/inbound', { From: '+13125550147', CallSid: cs('CAsig0') });
  assert.equal(res.status, 403, 'a dev signature skip must not dial a PH cell');
  if (saved !== undefined) process.env.NODE_ENV = saved;
});
```

**(b)** Add `?line=zul` to the existing `/inbound` `<Dial action>` (`voice.js:254`). The query string is covered by the webhook HMAC (`server/utils/twilioSignature.js:20` builds the signed URL from `req.originalUrl`), so a forged `line` cannot pass the signature gate:

```js
    `<Response><Dial timeout="20" action="${xmlEscape(API_URL)}/api/voice/inbound/missed?line=zul" method="POST" callerId="${xmlEscape(caller)}" timeLimit="${timeLimitSec()}"><Number>${xmlEscape(vaCell)}</Number></Dial></Response>`
```

**(c)** In `/inbound/missed`, resolve the line and pass it to the claim. After the existing `const fromE164 = callerE164(req.body.From);` line, add:

```js
  const line = resolveLine(req.query.line);
```

and change the claim call to carry it:

```js
    claimed = await _deps.claimMissedCall({ callSid, fromE164, line });
```

**(d)** Replace the TwiML the handler returns (currently the `sendTwiml(res, '<Response>' + greetingVerb() + ... )` block) with the per-line version. The `<Gather>` wrapper is added in Task 5; this step only swaps in the helpers so the emitted document is unchanged for `zul`:

```js
  sendTwiml(
    res,
    '<Response>'
    + greetingVerbForLine(line)
    + recordVerb()
    + '<Hangup/>'
    + '</Response>'
  );
  console.log(`[voice/missed] offering voicemail ${tail} line=${line} status=${status}`);
```

- [ ] **Step 5: Run both suites to confirm they pass**

Run: `node -r dotenv/config --test server/utils/voicemail.test.js`
Expected: PASS, including the two new tests.

Run: `node -r dotenv/config --test server/routes/voice.test.js`
Expected: PASS, including the four new/updated tests. The greeting assertions from the 2026-07-24 lane still pass, which is the proof the zul path did not change.

- [ ] **Step 6: Run every other suite that reaches `claimMissedCall`**

`claimMissedCall` gained a required-in-practice parameter, so grep its callers and run those suites (per the run-suites-a-change-reaches rule):

Run: `grep -rn "claimMissedCall" server --include=*.js | grep -v node_modules`
Then run each test file that appears, one at a time. At minimum:

Run: `node -r dotenv/config --test server/utils/vaCallingScheduler.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/routes/voice.js server/routes/voice.test.js \
        server/utils/voicemail.js server/utils/voicemail.test.js
git commit -m "feat(phone): stamp line through the missed-call path, per-line greeting"
```

---

### Task 3: The 1922 primary inbound handler

A new public webhook that rings Dallas and hands a miss to the shared handler.

**Files:**
- Modify: `server/routes/voice.js`
- Modify: `server/routes/voice.test.js`

**Interfaces:**
- Consumes: `requireSignature`, `sendTwiml`, `timeLimitSec` (existing in `voice.js`); `API_URL`, `xmlEscape`.
- Produces: `POST /api/voice/inbound/primary`, whose `<Dial action>` carries `?line=primary`.

- [ ] **Step 1: Write the failing tests**

Add to `server/routes/voice.test.js`. Extend the `beforeEach` env block with:

```js
  process.env.VM_PRIMARY_DIAL_TARGET = '+13125889401';
  process.env.VM_PRIMARY_RING_SEC = '18';
```

then:

```js
test('/inbound/primary dials the primary target and stamps line=primary', async () => {
  const res = await post('/api/voice/inbound/primary', { From: '+13125550147', CallSid: cs('CAp1') });
  assert.match(res.text, /<Dial[^>]*timeout="18"/);
  assert.match(res.text, /action="[^"]*\/api\/voice\/inbound\/missed\?line=primary"/);
  assert.match(res.text, /<Number>\+13125889401<\/Number>/);
  assert.match(res.text, /timeLimit="1800"/);
});

test('/inbound/primary passes the caller through as caller ID', async () => {
  const res = await post('/api/voice/inbound/primary', { From: '+13125550147', CallSid: cs('CAp2') });
  assert.match(res.text, /callerId="\+13125550147"/);
});

test('/inbound/primary falls back to VOICE_CALLER_ID for a junk From', async () => {
  // Same rule as /inbound: the From lands in an ATTRIBUTE and xmlEscape does not
  // escape quotes, so anything not bare +digits is replaced, never escaped.
  const res = await post('/api/voice/inbound/primary', {
    From: '+1312"><Say>pwned</Say>', CallSid: cs('CAp3'),
  });
  assert.doesNotMatch(res.text, /pwned/);
  assert.match(res.text, /callerId="\+12242220082"/);
});

test('/inbound/primary fails CLOSED on a bad signature even with NODE_ENV unset', async () => {
  const saved = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  router.__setVoiceDeps({ isValidTwilioRequest: () => false });
  const res = await post('/api/voice/inbound/primary', { From: '+13125550147', CallSid: cs('CAp4') });
  assert.equal(res.status, 403);
  if (saved !== undefined) process.env.NODE_ENV = saved;
});

test('/inbound/primary apologizes instead of dialing when the target is unset', async () => {
  delete process.env.VM_PRIMARY_DIAL_TARGET;
  const res = await post('/api/voice/inbound/primary', { From: '+13125550147', CallSid: cs('CAp5') });
  assert.doesNotMatch(res.text, /<Dial/);
  assert.match(res.text, /<Say/);
  assert.match(res.text, /<Hangup\/>/);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node -r dotenv/config --test server/routes/voice.test.js`
Expected: FAIL, 404s on `/api/voice/inbound/primary`.

- [ ] **Step 3: Implement in `server/routes/voice.js`**

Add the limiter after the existing `inboundForwardLimiter`, which closes at `voice.js:45`:

```js
// The primary (1922) line gets its OWN global bucket. Sharing
// inboundForwardLimiter's 'global' key would let a robocall storm on one number
// silence the other, and these are two different businesses' worth of calls: one
// rings Dallas, one rings Zul. Same cap value, separate accounting.
const primaryForwardLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.VA_INBOUND_PER_MIN_CAP, 10) || 30,
  keyGenerator: () => 'primary',
  handler: (req, res) => {
    res.set('Content-Type', 'text/xml').send(
      `${XML_DECL}<Response><Say>All lines are busy. Please try again shortly.</Say><Hangup/></Response>`
    );
  },
});
```

`primaryRingSec` and `interceptionSuspicion` are IMPORTED from
`server/utils/voicemailLine.js` (Task 1), not defined here. Extend the existing
import added in Task 2:

```js
const { resolveLine, primaryRingSec, interceptionSuspicion } = require('../utils/voicemailLine');
```

Keeping them in the util is what buys `voice.js` its line budget (see Step 8) and
it makes the canary's threshold logic unit-testable without an HTTP harness.

Then the handler, directly after the existing `/inbound` route (after `voice.js:256`):

```js
/**
 * POST /api/voice/inbound/primary. a client calls the 1922, the primary business
 * number. Dial Dallas (VM_PRIMARY_DIAL_TARGET, normally the 312 that rings his
 * phone and keeps his personal cell private), passing the client's number through
 * as caller ID, and hand a miss to the shared voicemail handler with line=primary.
 *
 * Fails CLOSED on signature, unlike the older /inbound above: this route places a
 * billed outbound leg, and a press-1 escalation downstream can place a billed
 * INTERNATIONAL leg, so there is no dev warn-and-allow path.
 */
router.post('/inbound/primary', primaryForwardLimiter, (req, res) => {
  if (!requireSignature(req, res, 'inbound/primary')) return;

  // Env only, strict E.164. An unset or malformed target must apologize rather
  // than emit a <Dial> with an empty or unsafe <Number>.
  const target = String(process.env.VM_PRIMARY_DIAL_TARGET || '').trim();
  if (!/^\+[1-9]\d{6,14}$/.test(target)) {
    console.error('[voice/primary] VM_PRIMARY_DIAL_TARGET unset or malformed; cannot dial');
    sendTwiml(res, '<Response><Say>Sorry, we cannot take your call right now. Please try again shortly.</Say><Hangup/></Response>');
    return;
  }

  // Same attribute-safety rule as /inbound: From lands in the callerId ATTRIBUTE
  // and xmlEscape does not escape quotes, so constrain it to bare +digits by
  // construction and otherwise fall back to our own line.
  const rawFrom = req.body.From || '';
  const caller = /^\+?[0-9]{7,15}$/.test(rawFrom) ? rawFrom : (process.env.VOICE_CALLER_ID || '');

  sendTwiml(
    res,
    `<Response><Dial timeout="${primaryRingSec()}" action="${xmlEscape(API_URL)}/api/voice/inbound/missed?line=primary" method="POST" callerId="${xmlEscape(caller)}" timeLimit="${timeLimitSec()}"><Number>${xmlEscape(target)}</Number></Dial></Response>`
  );
});
```

- [ ] **Step 4: Run to confirm pass**

Run: `node -r dotenv/config --test server/routes/voice.test.js`
Expected: PASS, including the five new tests.

- [ ] **Step 5: Write the failing test for the interception canary**

Spec section 2 asks for a canary on the one mitigation we cannot enforce from
code: voicemail being disabled on the dial target is a manual console setting, and
if it silently re-enables, the target's own voicemail answers, Twilio reports
`completed`, our missed handler correctly does nothing, and callers quietly land
in a dumb voicemail we cannot route.

Be honest about the limits: a machine answering at 25 seconds and a human
answering at 25 seconds are indistinguishable in the callback, so there is no
reliable automatic detector. What IS detectable is an answer that arrives far too
fast to be a person reaching for a phone, which is the signature of an
auto-attendant picking up. That plus a log line carrying the real numbers (so the
Twilio console can be reconciled later) is the useful, non-overclaiming version.

Add to `server/routes/voice.test.js`:

The canary's threshold logic is already unit-tested in
`server/utils/voicemailLine.test.js` (Task 1). These tests cover only the WIRING:
that the handler consults it, reports through the `captureMessage` seam, and still
takes the cheap branch.

`SENTRY_DSN_SERVER` is load-bearing here and the harness does NOT set it (the
suite's `beforeEach` at `voice.test.js:62-107` never does, the local `.env` has no
such key, and two existing tests `delete` it in their `finally` at `:547` and
`:693`). Set it explicitly in a try/finally, the same shape `voice.test.js:534-549`
already uses, or the assertion can never pass.

```js
test('a suspiciously instant answer on the primary line raises the interception canary', async () => {
  const savedDsn = process.env.SENTRY_DSN_SERVER;
  process.env.SENTRY_DSN_SERVER = 'https://example.invalid/1';
  try {
    const res = await post('/api/voice/inbound/missed?line=primary', {
      DialCallStatus: 'completed', DialCallDuration: '1', CallSid: cs('CAcan1'), From: '+13125550147',
    });
    await settle();
    // Still the cheap branch: an answered call must never record or ping.
    assert.match(res.text, /<Hangup\/>/);
    assert.doesNotMatch(res.text, /<Record/);
    assert.equal(calls.telegram.length, 0);
    // But it must be VISIBLE, because this is what a re-enabled carrier voicemail
    // quietly eating our callers looks like.
    assert.ok(
      calls.sentry.some((m) => /interception/i.test(String(m))),
      'an instant answer on the primary line must be reported'
    );
  } finally {
    if (savedDsn === undefined) delete process.env.SENTRY_DSN_SERVER;
    else process.env.SENTRY_DSN_SERVER = savedDsn;
  }
});

test('a normal answered call on the primary line raises no canary', async () => {
  const savedDsn = process.env.SENTRY_DSN_SERVER;
  process.env.SENTRY_DSN_SERVER = 'https://example.invalid/1';
  try {
    const res = await post('/api/voice/inbound/missed?line=primary', {
      DialCallStatus: 'completed', DialCallDuration: '45', CallSid: cs('CAcan2'), From: '+13125550147',
    });
    await settle();
    assert.match(res.text, /<Hangup\/>/);
    assert.equal(calls.sentry.length, 0, 'a real conversation is not an anomaly');
  } finally {
    if (savedDsn === undefined) delete process.env.SENTRY_DSN_SERVER;
    else process.env.SENTRY_DSN_SERVER = savedDsn;
  }
});

test('an instant answer on the zul line raises no canary', async () => {
  const savedDsn = process.env.SENTRY_DSN_SERVER;
  process.env.SENTRY_DSN_SERVER = 'https://example.invalid/1';
  try {
    const res = await post('/api/voice/inbound/missed?line=zul', {
      DialCallStatus: 'completed', DialCallDuration: '1', CallSid: cs('CAcan3'), From: '+13125550147',
    });
    await settle();
    assert.match(res.text, /<Hangup\/>/);
    assert.equal(calls.sentry.length, 0);
  } finally {
    if (savedDsn === undefined) delete process.env.SENTRY_DSN_SERVER;
    else process.env.SENTRY_DSN_SERVER = savedDsn;
  }
});
```

Run: `node -r dotenv/config --test server/routes/voice.test.js`
Expected: FAIL, no Sentry report is emitted.

- [ ] **Step 6: Implement the canary in `server/routes/voice.js`**

**Ordering is the whole trick here.** As of Task 2 the handler reads:

```
const status = req.body.DialCallStatus;      // :379
const callSid = req.body.CallSid || null;    // :380
if (!voicemailEnabled() || !MISSED_STATUSES.has(status) || !callSid) { ... return; }  // :383-386
const fromE164 = callerE164(req.body.From);  // :388
const line = resolveLine(req.query.line);    // added by Task 2
const tail = ...;                            // :389
```

`'completed'` is NOT in `MISSED_STATUSES`, so the handler returns at `:383-386` on
exactly the calls the canary needs to see. Both `line` and `tail` must therefore
move ABOVE that early return, and the canary block goes between them and the
return. Restructure the top of the handler to:

```js
  const status = req.body.DialCallStatus;
  const callSid = req.body.CallSid || null;
  const line = resolveLine(req.query.line);
  const tail = `sid=...${String(callSid).slice(-4)}`;

  // Interception canary (spec section 2 mitigation c). Runs BEFORE the cheap
  // branch because the case it watches for, DialCallStatus=completed, is exactly
  // what that branch returns on. Observation only: it never changes the outcome.
  const canary = interceptionSuspicion({
    line, status, dialCallDuration: req.body.DialCallDuration,
  });
  if (line === 'primary' && status === 'completed') {
    console.log(`[voice/missed] primary answered ${tail} dialSec=${canary.dialSec === null ? 'unknown' : canary.dialSec}`);
  }
  if (canary.suspect && process.env.SENTRY_DSN_SERVER) {
    _deps.captureMessage('primary line possible voicemail interception', {
      level: 'warning',
      tags: { webhook: 'twilio-voice', route: 'inbound/missed', line: 'primary' },
      extra: {
        dialSec: canary.dialSec,
        hint: 'check that voicemail is still disabled on VM_PRIMARY_DIAL_TARGET',
      },
    });
  }

  // Cheap branch is the default: only an explicitly recognized miss costs money.
  if (!voicemailEnabled() || !MISSED_STATUSES.has(status) || !callSid) {
    sendTwiml(res, HANGUP_TWIML);
    return;
  }

  const fromE164 = callerE164(req.body.From);
```

Delete the now-duplicated `const tail = ...` and `const line = ...` lines further
down, and leave everything below `fromE164` untouched.

Note this also makes `tail` safe on a NULL `callSid` (it becomes `sid=...null`),
which is only reachable on the canary path since the cheap branch rejects a missing
`callSid` immediately.

- [ ] **Step 7: Run to confirm pass**

Run: `node -r dotenv/config --test server/routes/voice.test.js`
Expected: PASS, including the three canary tests. The pre-existing
`'/inbound/missed on an answered call pings nobody and returns no Record'` test
must still pass: the canary observes, it never changes the branch.

- [ ] **Step 8: Confirm the file-size budget**

`server/routes/voice.js` starts at 624 lines. YELLOW is strictly `> 700`
(`scripts/check-file-size.js` `bucket()`), so the budget is real but not generous.
Running arithmetic against this plan's own code blocks:

| After | Change | Lines |
|---|---|---|
| start | | 624 |
| Task 1 + 2 | remove `greetingVerb` + `GREETING_TEXT` + `vmMaxLengthSec` (about 21), add about 6 import lines | about 609 |
| Task 3 | primary limiter (15) + handler (34) + canary block (13). `primaryRingSec` and the threshold live in `voicemailLine.js`, which is what keeps this off the coin flip | about 671 |
| Task 5 | `<Gather>` wrapper | about 677 |
| Task 6 | `line` threading (3 hops) + the line-aware failure tail | about 697 |

Run: `npm run check:filesize`
Expected: `server/routes/voice.js` is NOT in the RED list, and reports about 671 at
this point in the lane.

If it reads above 700 here, the Task 1 extraction did not land: verify
`greetingVerb`, `GREETING_TEXT`, and `vmMaxLengthSec` are gone from `voice.js` and
that `primaryRingSec` was imported rather than redefined. Do not proceed past
Task 3 over the cap, because Tasks 5 and 6 both add to this file and the only
extraction left large enough to matter is the `/inbound/voicemail` claim-and-deliver
pair (`voice.js:540-622`), which Task 6 needs to edit anyway.

- [ ] **Step 9: Commit**

```bash
git add server/routes/voice.js server/routes/voice.test.js
git commit -m "feat(phone): 1922 primary inbound handler, fail-closed, own ring cap"
```

---

### Task 4: The escalation claim, cap, and outcome ledger

The DB half of the press-1 escalation, kept out of `voicemail.js` so that file stays single-owner for the delivery pipeline.

**Files:**
- Create: `server/utils/voicemailEscalation.js`
- Create: `server/utils/voicemailEscalation.test.js`

**Interfaces:**
- Consumes: `pool` from `server/db`.
- Produces:
  - `claimEscalation(callSid) => Promise<{line: 'primary'|'zul'}|null>` (null means already claimed or unknown call)
  - `countEscalationsSince(hours) => Promise<number>`
  - `markEscalationAccepted(callSid) => Promise<void>`
  - `wasEscalationAccepted(callSid) => Promise<boolean>`
  - `recordEscalationOutcome({ callSid, outcome }) => Promise<void>`
  - `escalationDailyCap() => number`
  - `isCallSid(value) => boolean`
  - `__setEscalationDeps(overrides) => void`

**Why acceptance needs its own state.** `DialCallStatus` cannot answer "did a human
take this call?". A carrier voicemail that answers and is then hung up by the
whisper's screen is still an answered child leg, so Twilio reports `completed` for
BOTH "they talked" and "a machine grabbed it and we rejected it". Branching on that
status hangs up on a caller who never reached a person, which is the exact outcome
the screen exists to prevent. So a keypress writes `escalation_accepted_at` and
`escalate/done` reads it.

- [ ] **Step 1: Write the failing test**

Create `server/utils/voicemailEscalation.test.js`:

```js
require('dotenv').config();
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');

const esc = require('./voicemailEscalation');

// Every row this suite writes uses a recognizable CallSid prefix so cleanup can
// never touch a real row in the shared dev DB.
const PREFIX = 'CAtestesc';
const sid = (n) => `${PREFIX}${String(n).padStart(23, '0')}`;

async function cleanup() {
  await pool.query('DELETE FROM voicemail_delivery WHERE call_sid LIKE $1', [`${PREFIX}%`]);
}
async function seed(n, line) {
  await pool.query(
    'INSERT INTO voicemail_delivery (call_sid, from_e164, line) VALUES ($1, $2, $3)',
    [sid(n), '+13125550147', line]
  );
}

beforeEach(cleanup);
after(async () => { await cleanup(); await pool.end(); });

test('claimEscalation wins once and returns the line, then loses', async () => {
  await seed(1, 'primary');
  const first = await esc.claimEscalation(sid(1));
  const second = await esc.claimEscalation(sid(1));
  assert.deepEqual(first, { line: 'primary' });
  // Twilio delivers a <Gather action> at least once. The second claim losing is
  // what stops a redelivered callback from placing a SECOND billed leg.
  assert.equal(second, null);
});

test('claimEscalation stamps escalated_at', async () => {
  await seed(2, 'zul');
  await esc.claimEscalation(sid(2));
  const { rows } = await pool.query('SELECT escalated_at FROM voicemail_delivery WHERE call_sid = $1', [sid(2)]);
  assert.ok(rows[0].escalated_at instanceof Date);
});

test('claimEscalation returns null for a call that was never registered', async () => {
  assert.equal(await esc.claimEscalation(sid(3)), null);
});

test('countEscalationsSince counts only escalated rows in the window', async () => {
  const before = await esc.countEscalationsSince(24);
  await seed(4, 'zul');
  assert.equal(await esc.countEscalationsSince(24), before, 'a missed call is not an escalation');
  await esc.claimEscalation(sid(4));
  assert.equal(await esc.countEscalationsSince(24), before + 1);
});

test('markEscalationAccepted then wasEscalationAccepted is the accept gate', async () => {
  await seed(7, 'zul');
  await esc.claimEscalation(sid(7));
  assert.equal(await esc.wasEscalationAccepted(sid(7)), false, 'not accepted until a keypress');
  await esc.markEscalationAccepted(sid(7));
  assert.equal(await esc.wasEscalationAccepted(sid(7)), true);
});

test('wasEscalationAccepted is false for an unknown call and a bad sid', async () => {
  // escalate/done must never mistake "row missing" for "a human took the call",
  // because that would hang up on a caller instead of recording them.
  assert.equal(await esc.wasEscalationAccepted(sid(8)), false);
  assert.equal(await esc.wasEscalationAccepted('not-a-sid'), false);
  assert.equal(await esc.wasEscalationAccepted(null), false);
});

test('markEscalationAccepted is idempotent and keeps the first timestamp', async () => {
  await seed(9, 'zul');
  await esc.claimEscalation(sid(9));
  await esc.markEscalationAccepted(sid(9));
  const { rows: first } = await pool.query('SELECT escalation_accepted_at FROM voicemail_delivery WHERE call_sid = $1', [sid(9)]);
  await esc.markEscalationAccepted(sid(9));
  const { rows: second } = await pool.query('SELECT escalation_accepted_at FROM voicemail_delivery WHERE call_sid = $1', [sid(9)]);
  assert.deepEqual(second[0].escalation_accepted_at, first[0].escalation_accepted_at);
});

test('isCallSid gates what may be echoed back through a query string', () => {
  assert.equal(esc.isCallSid('CA' + 'a'.repeat(32)), true);
  assert.equal(esc.isCallSid('CA' + 'A'.repeat(32)), false, 'lowercase hex only');
  assert.equal(esc.isCallSid('CA' + 'a'.repeat(31)), false);
  assert.equal(esc.isCallSid('../../etc/passwd'), false);
  assert.equal(esc.isCallSid(''), false);
  assert.equal(esc.isCallSid(undefined), false);
});

test('recordEscalationOutcome writes an allowed outcome', async () => {
  await seed(5, 'zul');
  await esc.claimEscalation(sid(5));
  await esc.recordEscalationOutcome({ callSid: sid(5), outcome: 'no_answer' });
  const { rows } = await pool.query('SELECT escalation_outcome FROM voicemail_delivery WHERE call_sid = $1', [sid(5)]);
  assert.equal(rows[0].escalation_outcome, 'no_answer');
});

test('recordEscalationOutcome refuses an off-list outcome instead of failing the row', async () => {
  await seed(6, 'zul');
  await esc.claimEscalation(sid(6));
  await esc.recordEscalationOutcome({ callSid: sid(6), outcome: 'banana' });
  const { rows } = await pool.query('SELECT escalation_outcome FROM voicemail_delivery WHERE call_sid = $1', [sid(6)]);
  assert.equal(rows[0].escalation_outcome, null, 'clamped to no write, never a CHECK violation');
});

test('escalationDailyCap defaults to 25 and honors a positive override', () => {
  delete process.env.VM_ESCALATION_DAILY_CAP;
  assert.equal(esc.escalationDailyCap(), 25);
  process.env.VM_ESCALATION_DAILY_CAP = '5';
  assert.equal(esc.escalationDailyCap(), 5);
  process.env.VM_ESCALATION_DAILY_CAP = '0';
  assert.equal(esc.escalationDailyCap(), 25, 'a nonsense value falls back to the default');
  delete process.env.VM_ESCALATION_DAILY_CAP;
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node -r dotenv/config --test server/utils/voicemailEscalation.test.js`
Expected: FAIL, `Cannot find module './voicemailEscalation'`.

- [ ] **Step 3: Write `server/utils/voicemailEscalation.js`**

```js
// server/utils/voicemailEscalation.js
//
// The DB half of the press-1 escalation (spec 2026-07-26 section 3): the claim
// that stops a duplicate billed leg, the rolling spend window, and the outcome
// write.
//
// Kept out of server/utils/voicemail.js on purpose. That module owns the
// delivery pipeline (fetch, upload, the destructive Twilio delete); escalation is
// a different concern on the same table, and separating them keeps each file
// small enough to reason about and lets them be reviewed independently.

const { pool } = require('../db');

const OUTCOMES = new Set([
  'answered', 'no_answer', 'declined', 'skipped_cap', 'skipped_quiet', 'skipped_no_target',
]);

let _deps = { pool };
function __setEscalationDeps(d) { _deps = { ..._deps, ...d }; }

/** Max escalation legs per rolling 24h. Toll-fraud bound on a new billed leg. */
function escalationDailyCap() {
  const n = parseInt(process.env.VM_ESCALATION_DAILY_CAP, 10);
  return Number.isFinite(n) && n > 0 ? n : 25;
}

/**
 * Claim the right to place ONE escalation leg for this call, and read back the
 * line in the same round trip (the <Gather action> body does not carry it in a
 * form we trust more than the row).
 *
 * The guard is `escalated_at IS NULL`, which makes this the same
 * claim-before-you-spend shape as the missed-call ping's PK insert and the
 * lead-call bridge's status transition (voiceLeadCall.js:173-180). Twilio
 * delivers a <Gather action> at least once, so without it a redelivered callback
 * places a second billed leg, and on the primary line that leg is international.
 *
 * @returns {Promise<{line: 'primary'|'zul'}|null>} null iff already claimed or
 *   the call was never registered as a miss.
 */
async function claimEscalation(callSid) {
  if (!callSid) return null;
  const { rows } = await _deps.pool.query(
    `UPDATE voicemail_delivery
        SET escalated_at = NOW()
      WHERE call_sid = $1
        AND escalated_at IS NULL
      RETURNING line`,
    [callSid]
  );
  return rows.length > 0 ? { line: rows[0].line } : null;
}

/**
 * Rolling-window count of escalation legs, backing VM_ESCALATION_DAILY_CAP.
 * Counts the CLAIM, not the outcome: the spend is committed at dial time.
 */
async function countEscalationsSince(hours) {
  const { rows } = await _deps.pool.query(
    `SELECT COUNT(*)::int AS n FROM voicemail_delivery
      WHERE escalated_at > NOW() - ($1 || ' hours')::interval`,
    [String(hours)]
  );
  return rows[0].n;
}

/**
 * Twilio CallSid shape. Gates the parent sid we echo through the whisper and
 * accept URLs, so nothing arbitrary is ever carried in a query string or handed
 * to a query, even though the query is also parameterized and HMAC-covered.
 */
function isCallSid(value) {
  return typeof value === 'string' && /^CA[0-9a-f]{32}$/.test(value);
}

/**
 * Record that a HUMAN accepted the escalation by pressing a key on the whisper.
 *
 * This is the only signal escalate/done can trust. See the header note: an
 * auto-answering carrier voicemail produces DialCallStatus=completed just like a
 * real conversation does, so without this the fallback hangs up on a caller who
 * never reached a person. The COALESCE keeps the first acceptance if Twilio
 * redelivers the accept callback.
 */
async function markEscalationAccepted(callSid) {
  if (!isCallSid(callSid)) return;
  await _deps.pool.query(
    `UPDATE voicemail_delivery
        SET escalation_accepted_at = COALESCE(escalation_accepted_at, NOW())
      WHERE call_sid = $1`,
    [callSid]
  );
}

/**
 * Did a human accept this escalation? Fails CLOSED (false) on a bad sid, a missing
 * row, or a read error: "not accepted" sends the caller to voicemail, which is
 * always recoverable, while a false "accepted" hangs up on them, which is not.
 */
async function wasEscalationAccepted(callSid) {
  if (!isCallSid(callSid)) return false;
  const { rows } = await _deps.pool.query(
    'SELECT escalation_accepted_at FROM voicemail_delivery WHERE call_sid = $1',
    [callSid]
  );
  return Boolean(rows[0] && rows[0].escalation_accepted_at);
}

/**
 * Record why the escalation ended. Observability only; nothing branches on it.
 * An off-list outcome is DROPPED rather than written, so a future caller passing
 * a typo logs a warning instead of violating the CHECK and failing the write on a
 * row that matters.
 */
async function recordEscalationOutcome({ callSid, outcome }) {
  if (!callSid) return;
  if (!OUTCOMES.has(outcome)) {
    console.warn(`[vm-escalate] refusing off-list outcome "${outcome}" sid=...${String(callSid).slice(-4)}`);
    return;
  }
  await _deps.pool.query(
    'UPDATE voicemail_delivery SET escalation_outcome = $1 WHERE call_sid = $2',
    [outcome, callSid]
  );
}

module.exports = {
  OUTCOMES, isCallSid, escalationDailyCap, claimEscalation, countEscalationsSince,
  markEscalationAccepted, wasEscalationAccepted, recordEscalationOutcome,
  __setEscalationDeps,
};
```

- [ ] **Step 4: Run to confirm pass**

Run: `node -r dotenv/config --test server/utils/voicemailEscalation.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/voicemailEscalation.js server/utils/voicemailEscalation.test.js
git commit -m "feat(phone): escalation claim guard, rolling cap, outcome ledger"
```

---

### Task 5: The press-1 escalation routes and the `<Gather>` wrapper

The behavior the whole feature is for. New route file, mounted before `/api/voice`, plus the one change to the live missed handler that offers the option.

**Files:**
- Create: `server/routes/voiceEscalate.js`
- Create: `server/routes/voiceEscalate.test.js`
- Modify: `server/routes/voice.js`
- Modify: `server/routes/voice.test.js`
- Modify: `server/index.js`

**Interfaces:**
- Consumes: `claimEscalation`, `countEscalationsSince`, `escalationDailyCap`, `recordEscalationOutcome` (Task 4); `resolveLine`, `escalationTargetFor`, `inQuietWindow` (Task 1); `recordVerb`, `escalationEnabled`, `escalationPromptVerb` (Task 1); `isValidTwilioRequest`.
- Produces: `POST /api/voice/escalate`, `POST /api/voice/escalate/done`, `POST /api/voice/escalate/whisper`, `POST /api/voice/escalate/accept`, and `router.__setEscalateDeps` for tests.

**How the four routes fit together.** Twilio's `<Gather>` requests its `action` URL
only when a digit arrives; on timeout with no input it falls through to the NEXT
verb in the same document. That is why the missed handler can put `<Record>` after
the `</Gather>` and get the correct default (no keypress means leave a message)
with no extra route. `escalate` is the digit handler. It dials the other person with
a `<Number url=...>` whisper: that URL's TwiML plays to the ANSWERING party only,
and a `<Gather>` there followed by `<Hangup/>` screens the leg, so an unattended
carrier voicemail that never presses a key gets hung up on. `escalate/done` is the
outer `<Dial action>`, which fires when that leg ends for any reason.

**Two things rev 1 got wrong here, and they are the reason this task is shaped the
way it is.**

1. **`escalate/done` must NOT branch on `DialCallStatus`.** Hanging up on the
   screened leg still counts as an ANSWERED child leg, so Twilio reports
   `completed` for both "a human talked to the client" and "a machine grabbed it
   and we rejected it". Branching on that status strands the caller in silence in
   exactly the case the screen was built for. `done` therefore branches on
   `wasEscalationAccepted(parentSid)`, which is only ever true after a real
   keypress.
2. **The whisper and accept callbacks run on the CHILD leg, so `req.body.CallSid`
   there is the child's sid, not the parent's.** The acceptance flag lives on the
   parent's `voicemail_delivery` row, so the parent sid is threaded explicitly
   through the whisper and accept URLs as `?sid=`, validated with `isCallSid` on the
   way in and on the way out. It is our own value round-tripping, the query string
   is inside the webhook HMAC (`twilioSignature.js:20` signs `req.originalUrl`), and
   the shape check means nothing arbitrary can reach the query even so. Do not rely
   on `ParentCallSid`; the explicit round-trip is deterministic.

- [ ] **Step 1: Write the failing tests for the routes**

Create `server/routes/voiceEscalate.test.js`:

```js
require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const router = require('./voiceEscalate');

let _server = null;
let _baseUrl = null;

before(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/voice/escalate', router);
  await new Promise((resolve) => {
    _server = app.listen(0, () => {
      _baseUrl = `http://127.0.0.1:${_server.address().port}`;
      resolve();
    });
  });
});
after(async () => { if (_server) await new Promise((r) => _server.close(r)); });

function post(path, form) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = http.request(`${_baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const crypto = require('node:crypto');
const cs = (label) => 'CA' + crypto.createHash('md5').update(String(label)).digest('hex');

let calls;
beforeEach(() => {
  calls = { claims: [], counts: 0, outcomes: [], accepted: [], wasAccepted: false };
  process.env.VM_ESCALATION_ENABLED = 'true';
  process.env.VM_MAX_LENGTH_SEC = '120';
  process.env.VA_CELL = '+639171234567';
  process.env.VM_PRIMARY_DIAL_TARGET = '+13125889401';
  process.env.VA_CALL_TIME_LIMIT_SEC = '1800';
  delete process.env.VM_ESCALATION_QUIET_ZUL;
  delete process.env.VM_ESCALATION_QUIET_PRIMARY;
  delete process.env.VM_ESCALATION_DAILY_CAP;
  router.__setEscalateDeps({
    isValidTwilioRequest: () => true,
    claimEscalation: async (sid) => { calls.claims.push(sid); return { line: 'zul' }; },
    countEscalationsSince: async () => calls.counts,
    recordEscalationOutcome: async (a) => { calls.outcomes.push(a); },
    markEscalationAccepted: async (sid) => { calls.accepted.push(sid); },
    wasEscalationAccepted: async () => calls.wasAccepted,
  });
});

test('a digit other than 1 goes straight to the recording, no dial', async () => {
  const res = await post('/api/voice/escalate?line=zul', { Digits: '7', CallSid: cs('E2') });
  assert.doesNotMatch(res.text, /<Dial/);
  assert.match(res.text, /<Record[^>]*maxLength="120"/);
  assert.equal(calls.claims.length, 0, 'no claim means no spend committed');
});

test('a lost claim (Twilio redelivery) records but never dials twice', async () => {
  router.__setEscalateDeps({ claimEscalation: async () => null });
  const res = await post('/api/voice/escalate?line=zul', { Digits: '1', CallSid: cs('E3') });
  assert.doesNotMatch(res.text, /<Dial/);
  assert.match(res.text, /<Record/);
});

test('over the daily cap it records instead of dialing', async () => {
  calls.counts = 99;
  process.env.VM_ESCALATION_DAILY_CAP = '25';
  const res = await post('/api/voice/escalate?line=zul', { Digits: '1', CallSid: cs('E4') });
  assert.doesNotMatch(res.text, /<Dial/);
  assert.match(res.text, /<Record/);
  assert.deepEqual(calls.outcomes.at(-1).outcome, 'skipped_cap');
});

test('inside the quiet window it records instead of ringing a cell at 3am', async () => {
  // line=primary escalates TO Zul, so Zul's window applies.
  process.env.VM_ESCALATION_QUIET_ZUL = '00:00-23:59';
  const res = await post('/api/voice/escalate?line=primary', { Digits: '1', CallSid: cs('E5') });
  assert.doesNotMatch(res.text, /<Dial/);
  assert.match(res.text, /<Record/);
  assert.deepEqual(calls.outcomes.at(-1).outcome, 'skipped_quiet');
});

test('an unset target records instead of emitting an empty Dial', async () => {
  delete process.env.VM_PRIMARY_DIAL_TARGET;
  const res = await post('/api/voice/escalate?line=zul', { Digits: '1', CallSid: cs('E6') });
  assert.doesNotMatch(res.text, /<Dial/);
  assert.match(res.text, /<Record/);
  assert.deepEqual(calls.outcomes.at(-1).outcome, 'skipped_no_target');
});

test('VM_ESCALATION_ENABLED=false makes the digit handler a plain recording', async () => {
  process.env.VM_ESCALATION_ENABLED = 'false';
  const res = await post('/api/voice/escalate?line=zul', { Digits: '1', CallSid: cs('E7') });
  assert.doesNotMatch(res.text, /<Dial/);
  assert.match(res.text, /<Record/);
  assert.equal(calls.claims.length, 0);
});

test('press 1 dials the other person and threads the parent sid to the whisper', async () => {
  const parent = cs('E1');
  const res = await post('/api/voice/escalate?line=zul', { Digits: '1', CallSid: parent });
  assert.match(res.text, new RegExp(`action="[^"]*/api/voice/escalate/done\\?line=zul&amp;sid=${parent}"`));
  assert.match(res.text, /timeLimit="1800"/);
  assert.match(res.text, new RegExp(`<Number[^>]*url="[^"]*/api/voice/escalate/whisper\\?sid=${parent}"[^>]*>\\+13125889401</Number>`));
});

test('the whisper screens with a Gather, hangs up on no keypress, and carries the sid', async () => {
  const parent = cs('E8');
  const res = await post(`/api/voice/escalate/whisper?sid=${parent}`, { CallSid: cs('child8') });
  assert.match(res.text, /<Gather[^>]*numDigits="1"/);
  assert.match(res.text, new RegExp(`action="[^"]*/api/voice/escalate/accept\\?sid=${parent}"`));
  assert.match(res.text, /Dr\. Bartender/);
  // The trailing Hangup is the whole point: an unattended carrier voicemail that
  // never presses a key must NOT be bridged to the client.
  assert.match(res.text, /<\/Gather><Hangup\/>/);
});

test('accept marks the PARENT accepted and returns an empty response so they bridge', async () => {
  const parent = cs('E9');
  // The whisper and accept callbacks run on the CHILD leg, so CallSid here is the
  // child's. The acceptance flag belongs to the parent row.
  const res = await post(`/api/voice/escalate/accept?sid=${parent}`, { Digits: '5', CallSid: cs('child9') });
  assert.match(res.text, /<Response><\/Response>|<Response\/>/);
  assert.deepEqual(calls.accepted, [parent], 'the parent sid, not the child sid');
});

test('accept with no digits hangs up and marks nothing accepted', async () => {
  const res = await post(`/api/voice/escalate/accept?sid=${cs('E10')}`, { Digits: '', CallSid: cs('child10') });
  assert.match(res.text, /<Hangup\/>/);
  assert.equal(calls.accepted.length, 0);
});

test('accept with a malformed sid hangs up rather than bridging blind', async () => {
  const res = await post('/api/voice/escalate/accept?sid=nope', { Digits: '5', CallSid: cs('child10b') });
  assert.match(res.text, /<Hangup\/>/);
  assert.equal(calls.accepted.length, 0);
});

test('escalate/done returns the recording when nobody accepted', async () => {
  calls.wasAccepted = false;
  const res = await post(`/api/voice/escalate/done?line=zul&sid=${cs('E11')}`, {
    DialCallStatus: 'no-answer', CallSid: cs('E11'),
  });
  assert.match(res.text, /<Record[^>]*maxLength="120"/);
  assert.match(res.text, /<Hangup\/>/);
  assert.deepEqual(calls.outcomes.at(-1).outcome, 'no_answer');
});

test('escalate/done RECORDS a screened-out machine even though Twilio says completed', async () => {
  // THE REGRESSION TEST. Hanging up the screened leg still reports completed, so
  // trusting DialCallStatus here would hang up on a caller who never reached a
  // person. Acceptance state is the only thing that may decide this.
  calls.wasAccepted = false;
  const res = await post(`/api/voice/escalate/done?line=zul&sid=${cs('E12')}`, {
    DialCallStatus: 'completed', CallSid: cs('E12'),
  });
  assert.match(res.text, /<Record[^>]*maxLength="120"/, 'completed without acceptance is NOT a conversation');
  assert.deepEqual(calls.outcomes.at(-1).outcome, 'no_answer');
});

test('escalate/done hangs up with no second recording once a human accepted', async () => {
  calls.wasAccepted = true;
  const res = await post(`/api/voice/escalate/done?line=zul&sid=${cs('E13')}`, {
    DialCallStatus: 'completed', CallSid: cs('E13'),
  });
  assert.doesNotMatch(res.text, /<Record/);
  assert.match(res.text, /<Hangup\/>/);
  assert.deepEqual(calls.outcomes.at(-1).outcome, 'answered');
});

test('escalate/done falls back to recording when the acceptance read throws', async () => {
  // Fail closed toward the caller: voicemail is recoverable, silence is not.
  router.__setEscalateDeps({ wasEscalationAccepted: async () => { throw new Error('db down'); } });
  const res = await post(`/api/voice/escalate/done?line=zul&sid=${cs('E14')}`, {
    DialCallStatus: 'completed', CallSid: cs('E14'),
  });
  assert.match(res.text, /<Record/);
});

test('every escalate route fails CLOSED on a bad signature with NODE_ENV unset', async () => {
  const saved = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  router.__setEscalateDeps({ isValidTwilioRequest: () => false });
  for (const path of ['', '/done', '/whisper', '/accept']) {
    const res = await post(`/api/voice/escalate${path}`, { Digits: '1', CallSid: cs('Esig') });
    assert.equal(res.status, 403, `${path || '/'} must fail closed`);
  }
  if (saved !== undefined) process.env.NODE_ENV = saved;
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node -r dotenv/config --test server/routes/voiceEscalate.test.js`
Expected: FAIL, `Cannot find module './voiceEscalate'`.

- [ ] **Step 3: Write `server/routes/voiceEscalate.js`**

```js
// server/routes/voiceEscalate.js
//
// The press-1 escalation (spec 2026-07-26 section 3). A caller who reaches
// either line's voicemail may press 1 to try the OTHER person before leaving a
// message; if that person does not pick up, the caller lands back in voicemail.
//
// Its own router file, mounted at /api/voice/escalate ahead of /api/voice, the
// same shape voiceLeadCall.js already uses for the lead-call voice concern. That
// keeps server/routes/voice.js under the file-size cap and keeps this new billed
// path reviewable on its own.
//
// TOLL-FRAUD NOTE: every press-1 places a billed outbound leg, and on the
// primary line that leg is INTERNATIONAL (Zul's PH cell). It is reachable by
// anyone who can call a public number and press a key. So the dial is guarded
// four ways before it happens: a kill switch, a single-use claim, a rolling daily
// cap, and a quiet window. Targets come only from env, never from the request.

const express = require('express');
const Sentry = require('@sentry/node');
const rateLimit = require('express-rate-limit');
const { xmlEscape } = require('../utils/xmlEscape');
const { isValidTwilioRequest } = require('../utils/twilioSignature');
const { API_URL } = require('../utils/urls');
const { resolveLine, escalationTargetFor, inQuietWindow } = require('../utils/voicemailLine');
const { recordVerb, escalationEnabled } = require('../utils/voicemailTwiml');
const escalation = require('../utils/voicemailEscalation');

const router = express.Router();

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';
const WHISPER_TEXT = 'Dr. Bartender client on the line. Press any key to take the call.';

let _deps = {
  isValidTwilioRequest,
  claimEscalation: (...a) => escalation.claimEscalation(...a),
  countEscalationsSince: (...a) => escalation.countEscalationsSince(...a),
  markEscalationAccepted: (...a) => escalation.markEscalationAccepted(...a),
  wasEscalationAccepted: (...a) => escalation.wasEscalationAccepted(...a),
  recordEscalationOutcome: (...a) => escalation.recordEscalationOutcome(...a),
};
function __setEscalateDeps(d) { _deps = { ..._deps, ...d }; }
router.__setEscalateDeps = __setEscalateDeps;

// Same per-CallSid limiter shape as the voicemail webhooks in voice.js: the key
// is shape-validated so a flood of junk SIDs collapses into one bucket instead
// of minting unbounded keys, and these routes are only reachable as a
// consequence of a call that already passed the inbound cap.
const CALL_SID_RE = /^CA[0-9a-f]{32}$/;
const escalateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => {
    const sid = (req.body && req.body.CallSid) || '';
    return CALL_SID_RE.test(sid) ? sid : 'unvalidated';
  },
  // Every route here is on a LIVE caller's path, so a bare 429 would make Twilio
  // play "an application error has occurred" at a real client. Give them the
  // recording instead.
  handler: (req, res) => sendTwiml(res, `<Response>${recordVerb()}<Hangup/></Response>`),
});

function sendTwiml(res, body) {
  res.set('Content-Type', 'text/xml').send(`${XML_DECL}${body}`);
}

/** Fail-closed signature gate. No dev skip: these routes place billed legs. */
function requireSignature(req, res, tag) {
  if (_deps.isValidTwilioRequest(req)) return true;
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage('Twilio escalation webhook signature failure', {
      level: 'warning',
      tags: { webhook: 'twilio-voice-escalate', route: tag, reason: 'invalid_signature' },
    });
  }
  res.status(403).send('Invalid signature');
  return false;
}

function timeLimitSec() {
  return parseInt(process.env.VA_CALL_TIME_LIMIT_SEC, 10) || 1800;
}

/** The fallback every declined or blocked escalation takes: leave a message. */
function recordTwiml(res) {
  sendTwiml(res, `<Response>${recordVerb()}<Hangup/></Response>`);
}

/**
 * POST /api/voice/escalate. the <Gather action> from the missed-call greeting.
 * Only reached when the caller actually pressed a key; a timeout with no input
 * falls through to the <Record> that follows </Gather> in that document.
 */
router.post('/', escalateLimiter, async (req, res) => {
  if (!requireSignature(req, res, 'escalate')) return;

  const line = resolveLine(req.query.line);
  const callSid = req.body.CallSid || null;
  const tail = `sid=...${String(callSid).slice(-4)}`;

  // Anything but 1 is "just let me leave a message". No claim, so no spend. The
  // sid shape is checked here because it is about to be echoed into two URLs.
  if (req.body.Digits !== '1' || !escalationEnabled() || !escalation.isCallSid(callSid)) {
    return recordTwiml(res);
  }

  const target = escalationTargetFor(line);
  if (!target) {
    console.error(`[vm-escalate] no valid target for line=${line} ${tail}`);
    await _deps.recordEscalationOutcome({ callSid, outcome: 'skipped_no_target' }).catch(() => {});
    return recordTwiml(res);
  }

  if (inQuietWindow(line)) {
    console.log(`[vm-escalate] quiet window, not dialing line=${line} ${tail}`);
    await _deps.recordEscalationOutcome({ callSid, outcome: 'skipped_quiet' }).catch(() => {});
    return recordTwiml(res);
  }

  // Cap BEFORE the claim, so a rejected escalation does not consume the claim
  // (and therefore does not count against the window it was rejected by).
  // Fails CLOSED: an unreadable count means no dial.
  let recent = Infinity;
  try {
    recent = await _deps.countEscalationsSince(24);
  } catch (err) {
    console.error(`[vm-escalate] cap read failed: ${err.message}`);
  }
  if (recent >= escalation.escalationDailyCap()) {
    console.warn(`[vm-escalate] VM_ESCALATION_DAILY_CAP tripped (${recent}) ${tail}`);
    await _deps.recordEscalationOutcome({ callSid, outcome: 'skipped_cap' }).catch(() => {});
    return recordTwiml(res);
  }

  // The claim is the last gate and the one that commits the spend. A redelivered
  // <Gather action> loses it and takes the recording path instead of dialing again.
  let claim = null;
  try {
    claim = await _deps.claimEscalation(callSid);
  } catch (err) {
    console.error(`[vm-escalate] claim failed: ${err.message}`);
  }
  if (!claim) {
    console.log(`[vm-escalate] claim lost or unknown call ${tail}`);
    return recordTwiml(res);
  }

  // Attribute-value invariant: xmlEscape covers & < > but NOT quotes, so every
  // attribute below is a validated integer, a fixed enum, an env E.164, or a
  // shape-validated CallSid. The parent sid rides along because the whisper and
  // accept callbacks run on the CHILD leg, where req.body.CallSid is the child's,
  // while the acceptance flag belongs to this parent's ledger row.
  const doneUrl = `${API_URL}/api/voice/escalate/done?line=${line}&sid=${callSid}`;
  const whisperUrl = `${API_URL}/api/voice/escalate/whisper?sid=${callSid}`;
  console.log(`[vm-escalate] dialing line=${line} target=...${target.slice(-4)} ${tail}`);
  sendTwiml(res,
    '<Response>'
    + `<Dial timeout="20" action="${xmlEscape(doneUrl)}" method="POST" timeLimit="${timeLimitSec()}">`
    + `<Number url="${xmlEscape(whisperUrl)}" method="POST">${xmlEscape(target)}</Number>`
    + '</Dial>'
    + '</Response>'
  );
});

/**
 * POST /api/voice/escalate/whisper. TwiML played to the ANSWERING party only,
 * before the two legs are bridged.
 *
 * The <Gather> plus trailing <Hangup/> is a screening gate, not decoration: a
 * bare <Say> whisper would let the target's carrier voicemail "answer", report
 * completed, and swallow the client. Requiring a keypress means only a human can
 * accept; an unattended voicemail falls through to the Hangup, the leg ends, and
 * the outer <Dial action> returns the caller to our voicemail.
 */
router.post('/whisper', escalateLimiter, (req, res) => {
  if (!requireSignature(req, res, 'escalate/whisper')) return;
  // The parent sid round-trips so /accept can flag the right ledger row. Validated
  // on the way in as well as the way out: it is our own value, but it arrives over
  // the wire.
  const parentSid = escalation.isCallSid(req.query.sid) ? req.query.sid : '';
  const acceptUrl = `${API_URL}/api/voice/escalate/accept?sid=${parentSid}`;
  sendTwiml(res,
    '<Response>'
    + `<Gather numDigits="1" timeout="8" action="${xmlEscape(acceptUrl)}" method="POST">`
    + `<Say voice="Polly.Joanna-Neural">${xmlEscape(WHISPER_TEXT)}</Say>`
    + '</Gather>'
    + '<Hangup/>'
    + '</Response>'
  );
});

/**
 * POST /api/voice/escalate/accept. The whisper's <Gather action>, so it fires ONLY
 * on a real keypress. Records acceptance against the PARENT call, then returns an
 * empty response, which ends the whisper document and bridges the two parties.
 *
 * This runs on the child leg, so req.body.CallSid here is the DIALED party's sid,
 * not the caller's. The acceptance flag belongs to the parent, hence ?sid=.
 */
router.post('/accept', escalateLimiter, async (req, res) => {
  if (!requireSignature(req, res, 'escalate/accept')) return;
  const parentSid = req.query.sid;
  if (!req.body.Digits || !escalation.isCallSid(parentSid)) {
    // Gather normally falls through to <Hangup/> on a timeout rather than calling
    // this URL with no digits, but never bridge without a keypress, and never
    // bridge a leg that cannot be attributed to a parent call.
    return sendTwiml(res, '<Response><Hangup/></Response>');
  }
  try {
    await _deps.markEscalationAccepted(parentSid);
  } catch (err) {
    // A human IS on the line expecting to be connected, so failing the bridge over
    // a bookkeeping error would be worse than a mis-recorded outcome. The cost is
    // that /done may offer voicemail after they hang up.
    console.error(`[vm-escalate] accept write failed sid=...${String(parentSid).slice(-4)}: ${err.message}`);
  }
  console.log(`[vm-escalate] accepted by keypress sid=...${String(parentSid).slice(-4)}`);
  sendTwiml(res, '<Response></Response>');
});

/**
 * POST /api/voice/escalate/done. The outer <Dial action>, requested when the
 * escalation leg ends for any reason.
 *
 * Branches on ACCEPTANCE, never on DialCallStatus. Hanging up the screened leg
 * still counts as an answered child leg, so Twilio reports 'completed' both when a
 * human talked to the client and when a carrier voicemail grabbed the call and the
 * whisper rejected it. Only an explicit keypress separates them, and getting this
 * wrong hangs up on a caller who never reached a person.
 */
router.post('/done', escalateLimiter, async (req, res) => {
  if (!requireSignature(req, res, 'escalate/done')) return;

  const parentSid = escalation.isCallSid(req.query.sid) ? req.query.sid : (req.body.CallSid || null);
  const status = req.body.DialCallStatus;

  // Fails CLOSED toward the caller: on any doubt, offer voicemail. A wrong
  // "voicemail" is recoverable; a wrong "hang up" loses the lead in silence.
  let accepted = false;
  try {
    accepted = await _deps.wasEscalationAccepted(parentSid);
  } catch (err) {
    console.error(`[vm-escalate] acceptance read failed: ${err.message}`);
  }

  if (parentSid) {
    await _deps.recordEscalationOutcome({
      callSid: parentSid, outcome: accepted ? 'answered' : 'no_answer',
    }).catch((err) => console.error(`[vm-escalate] outcome write failed: ${err.message}`));
  }

  if (accepted) {
    // They talked. Nothing left to record.
    sendTwiml(res, '<Response><Hangup/></Response>');
    return;
  }
  console.log(`[vm-escalate] not accepted (status=${status}), back to voicemail sid=...${String(parentSid).slice(-4)}`);
  recordTwiml(res);
});

module.exports = router;
```

- [ ] **Step 4: Run to confirm the route tests pass**

Run: `node -r dotenv/config --test server/routes/voiceEscalate.test.js`
Expected: PASS, 16 tests.

- [ ] **Step 5: Mount the router in `server/index.js`**

Order matters, exactly like the lead-call mount. Change the two existing voice lines (`server/index.js:311-312`) to:

```js
app.use('/api/voice/lead', require('./routes/voiceLeadCall')); // more specific mount first
app.use('/api/voice/escalate', require('./routes/voiceEscalate')); // ditto, before /api/voice
app.use('/api/voice', require('./routes/voice'));
```

- [ ] **Step 6: Write the failing test for the `<Gather>` wrapper**

Add to `server/routes/voice.test.js`:

```js
test('/inbound/missed wraps the greeting in a Gather when escalation is enabled', async () => {
  process.env.VM_ESCALATION_ENABLED = 'true';
  const res = await post('/api/voice/inbound/missed?line=zul', {
    DialCallStatus: 'no-answer', CallSid: cs('CAg1'), From: '+13125550147',
  });
  await settle();
  assert.match(res.text, /<Gather[^>]*numDigits="1"[^>]*timeout="4"/);
  assert.match(res.text, /action="[^"]*\/api\/voice\/escalate\?line=zul"/);
  assert.match(res.text, /press 1/);
  // The Record must sit AFTER </Gather>: a caller who presses nothing falls
  // through to it, which is how "just leave a message" stays the default.
  assert.match(res.text, /<\/Gather><Record/);
});

test('/inbound/missed with escalation OFF emits exactly today\'s document', async () => {
  process.env.VM_ESCALATION_ENABLED = 'false';
  const res = await post('/api/voice/inbound/missed?line=zul', {
    DialCallStatus: 'no-answer', CallSid: cs('CAg2'), From: '+13125550147',
  });
  await settle();
  // Byte-for-byte the shipped behavior: greeting, Record, Hangup. No Gather.
  assert.doesNotMatch(res.text, /<Gather/);
  assert.doesNotMatch(res.text, /press 1/);
  assert.match(res.text, /<Play>[^<]*greeting\.mp3<\/Play><Record/);
});

test('/inbound/missed Gather targets the right line', async () => {
  process.env.VM_ESCALATION_ENABLED = 'true';
  const res = await post('/api/voice/inbound/missed?line=primary', {
    DialCallStatus: 'no-answer', CallSid: cs('CAg3'), From: '+13125550147',
  });
  await settle();
  assert.match(res.text, /action="[^"]*\/api\/voice\/escalate\?line=primary"/);
});
```

Add `delete process.env.VM_ESCALATION_ENABLED;` to the suite's `beforeEach` so the flag never leaks between tests (default OFF is what the older tests assert against).

- [ ] **Step 7: Run to confirm failure**

Run: `node -r dotenv/config --test server/routes/voice.test.js`
Expected: FAIL on the three new tests (no `<Gather>` is emitted yet).

- [ ] **Step 8: Add the `<Gather>` wrapper in `server/routes/voice.js`**

Extend the Task 2 import with the two helpers this step is the first to call:

```js
const {
  greetingVerbForLine, recordVerb, escalationEnabled, escalationPromptVerb,
} = require('../utils/voicemailTwiml');
```

Then replace the TwiML block in `/inbound/missed` (the one Task 2 step 4d installed):

```js
  // The greeting goes INSIDE a <Gather> only when escalation is on. Twilio
  // requests a <Gather action> only when a digit arrives; a timeout with no
  // input falls through to the next verb, so the <Record> after </Gather> is
  // what a caller who just wants to leave a message gets, with no extra route.
  //
  // With escalation off this emits the exact document production emits today.
  const greeting = greetingVerbForLine(line);
  const body = escalationEnabled()
    ? `<Gather numDigits="1" timeout="4" action="${xmlEscape(API_URL)}/api/voice/escalate?line=${line}" method="POST">`
      + greeting + escalationPromptVerb()
      + '</Gather>'
    : greeting;

  sendTwiml(res, `<Response>${body}${recordVerb()}<Hangup/></Response>`);
  console.log(`[voice/missed] offering voicemail ${tail} line=${line} status=${status}`);
```

`line` is a fixed enum from `resolveLine`, so interpolating it into the `action` attribute is safe by construction.

- [ ] **Step 9: Run to confirm pass**

Run: `node -r dotenv/config --test server/routes/voice.test.js`
Expected: PASS, all tests including the three new ones.

- [ ] **Step 10: Verify the mount resolves and lint is clean**

Run: `node -e "require('./server/routes/voiceEscalate'); console.log('router loads')"`
Expected: prints `router loads`.

Run: `npx eslint server/routes/voiceEscalate.js server/routes/voice.js server/utils/voicemailLine.js server/utils/voicemailTwiml.js server/utils/voicemailEscalation.js`
Expected: 0 errors.

- [ ] **Step 11: Commit**

```bash
git add server/routes/voiceEscalate.js server/routes/voiceEscalate.test.js \
        server/routes/voice.js server/routes/voice.test.js server/index.js
git commit -m "feat(phone): press-1 escalation with claim guard, cap, quiet window, screened whisper"
```

---

### Task 6: Per-line voicemail delivery

Zul's line keeps delivering to her Telegram exactly as today. Dallas's line delivers to his phone as a text, from a sender that is not the client message ledger and is not subject to client consent suppression.

**Files:**
- Modify: `server/utils/voicemail.js`
- Modify: `server/utils/voicemail.test.js`
- Modify: `server/routes/voice.js`
- Modify: `server/routes/voice.test.js`
- Modify: `server/utils/vaCallingScheduler.js`
- Modify: `server/utils/vaCallingScheduler.test.js`

**Interfaces:**
- Consumes: `sendSMS` from `server/utils/sms.js`; `sendTelegramAudio`/`sendTelegramMessage` from `server/utils/telegram.js`.
- Produces:
  - `claimDelivery({callSid, recordingSid, durationSec}) => Promise<{fromE164, line}|null>` (gains `line`)
  - `deliverVoicemail({ callSid, recordingSid, durationSec, fromE164, chatId, line, redelivered })` (gains `line`)

**Read this before writing the tests.** `deliverVoicemail` (`server/utils/voicemail.js:226`) **destructures** its argument; it does not take a `job` object, so the new field is added to the destructure and used as a bare `line`. And `markDelivery` (`voicemail.js:234,245,258`) and `deleteRecording` (`:246`) are called as **module functions, not through `_deps`**, so they CANNOT be stubbed via `__setVoicemailDeps`. Tests therefore seed a real row and assert the resulting DB `status`, which is how the rest of `voicemail.test.js` already works. `deleteRecording` is observable because it internally uses `_deps.client`: stub `client` with a `recordings().remove()` spy to prove a delete did or did not happen.

**Why `sendSMS` and not `sendAndLogSms`.** This is an internal operations alert about a client, not a message TO a client. `sendAndLogSms` files every send into the `sms_messages` client thread, which would put internal alerts in a client's conversation history. `sendSMS` with `meta: { skipLog: true }` is the existing mechanism for exactly this: `buildSmsLogEntry` (`server/utils/messageLog.js:28-30`) returns `{skipLog:true}` and `logClientMessage` returns immediately, so no ledger row and no client-resolution lookup happens. Neither primitive applies consent or STOP suppression (that lives in callers via `shouldSendImmediate`), so a stray STOP on the 312 can never silence Dallas's own voicemail alerts.

- [ ] **Step 1: Write the failing tests**

Add to `server/utils/voicemail.test.js`. These use the REAL seams: rows are seeded
through `claimMissedCall` and the resulting `status` is read back from the DB,
because `markDelivery` is not injectable. Reuse the file's existing `sid()` helper
and `PREFIX` cleanup.

```js
// A recordings().remove() spy, so "did we delete the recording?" is observable.
// deleteRecording is called as a module function but reaches Twilio through
// _deps.client, which IS injectable.
function removeSpy() {
  const removed = [];
  return {
    removed,
    client: { recordings: (s) => ({ remove: async () => { removed.push(s); return true; } }) },
  };
}
async function statusOf(callSid) {
  const { rows } = await pool.query('SELECT status FROM voicemail_delivery WHERE call_sid = $1', [callSid]);
  return rows[0] && rows[0].status;
}

test('deliverVoicemail on the zul line uploads audio to Telegram, never SMS', async () => {
  const spy = removeSpy();
  const sent = { audio: [], sms: [] };
  await vm.claimMissedCall({ callSid: sid(50), fromE164: '+13125550147', line: 'zul' });
  vm.__setVoicemailDeps({
    notificationsEnabled: () => true,
    client: spy.client,
    fetchRecordingMp3: async () => Buffer.from('ID3zul'),
    sendTelegramAudio: async (chatId, buf, opts) => { sent.audio.push({ chatId, opts }); return { ok: true }; },
    sendSMS: async (args) => { sent.sms.push(args); return { sid: 'SM1' }; },
  });
  const out = await vm.deliverVoicemail({
    callSid: sid(50), recordingSid: 'RE' + 'a'.repeat(32), durationSec: 9,
    fromE164: '+13125550147', chatId: '5550001', line: 'zul',
  });
  assert.equal(out, 'delivered');
  assert.equal(await statusOf(sid(50)), 'delivered');
  assert.equal(sent.audio.length, 1);
  assert.equal(sent.sms.length, 0, 'Zul gets Telegram, never the SMS path');
  assert.equal(spy.removed.length, 1, 'a delivered recording is deleted from Twilio');
});

test('deliverVoicemail on the primary line texts the destination, no Telegram audio', async () => {
  const spy = removeSpy();
  const sent = { audio: [], sms: [] };
  process.env.VM_TEXT_DESTINATION = '+13125889401';
  await vm.claimMissedCall({ callSid: sid(51), fromE164: '+13125550147', line: 'primary' });
  vm.__setVoicemailDeps({
    notificationsEnabled: () => true,
    client: spy.client,
    fetchRecordingMp3: async () => Buffer.from('ID3dallas'),
    sendTelegramAudio: async (chatId, buf, opts) => { sent.audio.push({ chatId, opts }); return { ok: true }; },
    sendSMS: async (args) => { sent.sms.push(args); return { sid: 'SM2' }; },
  });
  const out = await vm.deliverVoicemail({
    callSid: sid(51), recordingSid: 'RE' + 'b'.repeat(32), durationSec: 12,
    fromE164: '+13125550147', chatId: '5550001', line: 'primary',
  });
  assert.equal(out, 'delivered');
  assert.equal(await statusOf(sid(51)), 'delivered');
  assert.equal(sent.audio.length, 0, "Dallas does not get Zul's Telegram");
  assert.equal(sent.sms.length, 1);
  assert.equal(sent.sms[0].to, '+13125889401');
  assert.match(sent.sms[0].body, /\+13125550147/, 'the caller number must be in the text');
  assert.equal(sent.sms[0].meta.skipLog, true, 'an internal alert never files into a client thread');
  assert.equal(spy.removed.length, 1);
});

test('primary delivery with no destination is a skip that writes no status (gate 1 of 2)', async () => {
  const spy = removeSpy();
  delete process.env.VM_TEXT_DESTINATION;
  await vm.claimMissedCall({ callSid: sid(52), fromE164: '+13125550147', line: 'primary' });
  vm.__setVoicemailDeps({
    notificationsEnabled: () => true,
    client: spy.client,
    fetchRecordingMp3: async () => Buffer.from('ID3'),
    sendSMS: async () => { throw new Error('must not be called'); },
  });
  const out = await vm.deliverVoicemail({
    callSid: sid(52), recordingSid: 'RE' + 'c'.repeat(32), durationSec: 8,
    fromE164: '+13125550147', chatId: null, line: 'primary',
  });
  // Gated, not failed: keep the recording and leave the row 'recorded' so it
  // stays inside the sweep's retry window and a fixed config still delivers.
  assert.equal(out, 'skipped');
  assert.equal(await statusOf(sid(52)), 'missed', 'no status write on a gated send');
  assert.equal(spy.removed.length, 0, 'never delete a recording we did not deliver');
});

test('a GATED primary send is a skip, not a delivery (gate 2 of 2)', async () => {
  // sendSMS does NOT throw when notifications are off or creds are missing: it
  // returns a dev-skipped-* sid. Treating that as delivered would mark the row
  // 'delivered' and DELETE the recording, and since delivered_at is a one-way door
  // and the sweep only reaps 'recorded'/'failed', the voicemail would be parked
  // outside both retry and delivery forever.
  const spy = removeSpy();
  process.env.VM_TEXT_DESTINATION = '+13125889401';
  await vm.claimMissedCall({ callSid: sid(55), fromE164: '+13125550147', line: 'primary' });
  vm.__setVoicemailDeps({
    notificationsEnabled: () => true,
    client: spy.client,
    fetchRecordingMp3: async () => Buffer.from('ID3'),
    sendSMS: async () => ({ sid: 'dev-skipped-1753-abcd1234' }),
  });
  const out = await vm.deliverVoicemail({
    callSid: sid(55), recordingSid: 'RE' + 'f'.repeat(32), durationSec: 8,
    fromE164: '+13125550147', chatId: null, line: 'primary',
  });
  assert.equal(out, 'skipped');
  assert.equal(await statusOf(sid(55)), 'missed', 'no status write on a gated send');
  assert.equal(spy.removed.length, 0, 'a gated send must never delete the recording');
});

test('a failed primary SMS marks failed, keeps the recording, and alerts the backstop', async () => {
  const spy = removeSpy();
  const alerts = [];
  process.env.VM_TEXT_DESTINATION = '+13125889401';
  process.env.TELEGRAM_ALLOWED_USER_ID = '5550001';
  await vm.claimMissedCall({ callSid: sid(53), fromE164: '+13125550147', line: 'primary' });
  vm.__setVoicemailDeps({
    notificationsEnabled: () => true,
    client: spy.client,
    fetchRecordingMp3: async () => Buffer.from('ID3'),
    sendSMS: async () => { throw new Error('twilio 500'); },
    sendTelegramMessage: async (chatId, text) => { alerts.push({ chatId, text }); return { ok: true }; },
  });
  const out = await vm.deliverVoicemail({
    callSid: sid(53), recordingSid: 'RE' + 'd'.repeat(32), durationSec: 8,
    fromE164: '+13125550147', chatId: null, line: 'primary',
  });
  assert.equal(out, 'failed');
  assert.equal(await statusOf(sid(53)), 'failed');
  assert.equal(spy.removed.length, 0, 'never delete a recording we did not deliver');
  // The 312 is a Google Voice inbox and the SMS is the ONLY delivery channel on
  // this line, so a silent drop would lose the lead with no signal.
  assert.equal(alerts.length, 1, 'a failed primary SMS must raise a second-channel alert');
  assert.match(alerts[0].text, /\+13125550147/);
});

test('a backstop alert that itself fails does not change the outcome', async () => {
  process.env.VM_TEXT_DESTINATION = '+13125889401';
  await vm.claimMissedCall({ callSid: sid(54), fromE164: null, line: 'primary' });
  vm.__setVoicemailDeps({
    notificationsEnabled: () => true,
    client: removeSpy().client,
    fetchRecordingMp3: async () => Buffer.from('ID3'),
    sendSMS: async () => { throw new Error('twilio 500'); },
    sendTelegramMessage: async () => { throw new Error('telegram down too'); },
  });
  const out = await vm.deliverVoicemail({
    callSid: sid(54), recordingSid: 'RE' + 'e'.repeat(32), durationSec: 8,
    fromE164: null, chatId: null, line: 'primary',
  });
  assert.equal(out, 'failed', 'the backstop is best-effort, never the thing that throws');
});
```

Add to `server/routes/voice.test.js`. The last three are the tests that catch the
route-level half of per-line delivery, which is invisible if you only stub
`deliverVoicemail`:

```js
test('/inbound/voicemail passes the row line into the delivery job', async () => {
  const jobs = [];
  router.__setVoiceDeps({
    claimDelivery: async () => ({ fromE164: '+13125550147', line: 'primary' }),
    deliverVoicemail: async (job) => { jobs.push(job); return 'delivered'; },
  });
  await post('/api/voice/inbound/voicemail', {
    CallSid: cs('CAdel1'), RecordingSid: GOOD_RE, RecordingStatus: 'completed', RecordingDuration: '11',
  });
  await settle();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].line, 'primary', 'delivery must follow the line the call arrived on');
});

test('a primary voicemail still delivers with TELEGRAM_ALLOWED_USER_ID unset', async () => {
  // The bootstrap gate is Zul-specific. If it also gated the primary line, every
  // one of Dallas's voicemails would be silently undelivered whenever her chat id
  // was unset, which is a documented production configuration.
  const saved = process.env.TELEGRAM_ALLOWED_USER_ID;
  delete process.env.TELEGRAM_ALLOWED_USER_ID;
  const jobs = [];
  try {
    router.__setVoiceDeps({
      claimDelivery: async () => ({ fromE164: '+13125550147', line: 'primary' }),
      deliverVoicemail: async (job) => { jobs.push(job); return 'delivered'; },
    });
    await post('/api/voice/inbound/voicemail', {
      CallSid: cs('CAdel2'), RecordingSid: GOOD_RE, RecordingStatus: 'completed', RecordingDuration: '11',
    });
    await settle();
    assert.equal(jobs.length, 1, 'the primary line must not be gated on Zul\'s chat id');
  } finally {
    if (saved === undefined) delete process.env.TELEGRAM_ALLOWED_USER_ID;
    else process.env.TELEGRAM_ALLOWED_USER_ID = saved;
  }
});

test('a zul voicemail is still gated on TELEGRAM_ALLOWED_USER_ID', async () => {
  const saved = process.env.TELEGRAM_ALLOWED_USER_ID;
  delete process.env.TELEGRAM_ALLOWED_USER_ID;
  const jobs = [];
  try {
    router.__setVoiceDeps({
      claimDelivery: async () => ({ fromE164: '+13125550147', line: 'zul' }),
      deliverVoicemail: async (job) => { jobs.push(job); return 'delivered'; },
    });
    await post('/api/voice/inbound/voicemail', {
      CallSid: cs('CAdel3'), RecordingSid: GOOD_RE, RecordingStatus: 'completed', RecordingDuration: '11',
    });
    await settle();
    assert.equal(jobs.length, 0, 'her line has no channel without a chat id; stay retryable');
  } finally {
    if (saved === undefined) delete process.env.TELEGRAM_ALLOWED_USER_ID;
    else process.env.TELEGRAM_ALLOWED_USER_ID = saved;
  }
});

test('a failed primary delivery alerts Dallas by SMS, never Zul by Telegram', async () => {
  const sms = [];
  router.__setVoiceDeps({
    claimDelivery: async () => ({ fromE164: '+13125550147', line: 'primary' }),
    deliverVoicemail: async () => 'failed',
    sendSMS: async (args) => { sms.push(args); return { sid: 'SMalert' }; },
  });
  await post('/api/voice/inbound/voicemail', {
    CallSid: cs('CAdel4'), RecordingSid: GOOD_RE, RecordingStatus: 'completed', RecordingDuration: '11',
  });
  await settle();
  assert.equal(calls.telegram.length, 0, 'a primary failure must not be reported to Zul');
  assert.equal(sms.length, 1);
  assert.match(sms[0].body, /\+13125550147/);
  assert.equal(sms[0].meta.skipLog, true);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node -r dotenv/config --test server/utils/voicemail.test.js`
Expected: FAIL, the primary-line tests still take the Telegram path.

Run: `node -r dotenv/config --test server/routes/voice.test.js`
Expected: FAIL, `jobs[0].line` is undefined.

- [ ] **Step 3: Return `line` from `claimDelivery` in `server/utils/voicemail.js`**

The recording callback does not carry the line, so read it back with the claim (one round trip, the same way `from_e164` already is). Change the `RETURNING` clause and the return value of `claimDelivery`:

```js
      RETURNING from_e164, line`,
```

```js
  return rows.length > 0 ? { fromE164: rows[0].from_e164, line: rows[0].line } : null;
```

Update its JSDoc `@returns` to `Promise<{fromE164: string|null, line: 'primary'|'zul'}|null>`.

- [ ] **Step 4: Route delivery by line in `server/utils/voicemail.js`**

Add to the requires at the top:

```js
const { sendSMS } = require('./sms');
const { sendTelegramMessage } = require('./telegram');
```

Add both to the `_deps` object so tests can stub them (`sendTelegramAudio` is
already there; `sendTelegramMessage` is new here and backs the failure backstop):

```js
  sendSMS: (...a) => sendSMS(...a),
  sendTelegramMessage: (...a) => sendTelegramMessage(...a),
```

Add the message builder above `deliverVoicemail`:

```js
/**
 * The internal alert text for a voicemail on the primary line.
 *
 * Kept short on purpose: it lands in a Google Voice inbox as a normal SMS, and a
 * long body would split into multiple billed segments and may be truncated. The
 * caller number is the payload that matters, and it sits on its own line so it
 * stays tappable and copy-pasteable on a phone.
 */
function primaryAlertText({ fromE164, durationSec }) {
  const who = fromE164 || 'a withheld number';
  const secs = Number.isFinite(durationSec) ? `${durationSec}s` : 'unknown length';
  return `New voicemail on the business line (${secs}), ${chicagoStamp()}.\n${who}`;
}

/** Short Chicago timestamp for the alert body. */
function chicagoStamp(d = new Date()) {
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
```

First, add `line` to the existing destructure (`voicemail.js:226`), defaulting it so
an older caller cannot land a primary voicemail in Zul's Telegram by omission:

```js
async function deliverVoicemail({ callSid, recordingSid, durationSec, fromE164, chatId, line = 'zul', redelivered = false }) {
```

Then, immediately AFTER the existing media-fetch block (the one that returns
`'unfetchable'`) and BEFORE the `secs`/`mmss`/`caption` lines, insert the primary
branch. Fetching first is deliberate: an unfetchable recording is the same failure
on both lines, so that path stays shared.

Note `markDelivery` and `deleteRecording` are called BARE here, matching the
surrounding code, and `tail` is the existing last-4 local from line 2 of the
function. The three-outcome contract is unchanged: `'delivered'` deletes the
recording, `'skipped'` writes no status and keeps it, anything else writes
`'failed'` and keeps it.

```js
  // Delivery is per line. Zul's voicemails go to her Telegram (audio inline, as
  // shipped 2026-07-24); Dallas's go to his phone as a text, because that is
  // where he actually looks.
  if (line === 'primary') {
    const to = String(process.env.VM_TEXT_DESTINATION || '').trim();
    if (!/^\+[1-9]\d{6,14}$/.test(to)) {
      // Gated, not failed: the same contract as a tokenless Telegram send. Keep
      // the recording and write NO status, so the row stays inside the sweep's
      // retry window and a corrected config still delivers.
      console.log(`[voicemail] primary delivery skipped (VM_TEXT_DESTINATION unset) ${tail}`);
      return 'skipped';
    }
    let sms;
    try {
      // sendSMS, NOT sendAndLogSms: this is an internal ops alert about a client,
      // not a message TO a client. skipLog keeps it out of the sms_messages
      // client thread (messageLog.buildSmsLogEntry honors it), so internal alerts
      // never show up in a client's conversation history. Neither primitive
      // applies consent or STOP suppression, so a stray STOP on the destination
      // can never silence Dallas's own voicemail alerts.
      sms = await _deps.sendSMS({
        to,
        body: primaryAlertText({ fromE164, durationSec }),
        meta: { skipLog: true, messageType: 'voicemail_alert' },
      });
    } catch (err) {
      console.error(`[voicemail] primary SMS failed ${tail}: ${err.message}`);
      await markDelivery({ callSid, status: 'failed' });
      // Second-channel backstop. The SMS is the ONLY delivery channel on this
      // line and it lands in a Google Voice inbox, so a silent drop would lose
      // the lead with no signal at all. Best-effort by construction: this must
      // never be the thing that throws, and it never changes the outcome.
      const allowed = process.env.TELEGRAM_ALLOWED_USER_ID;
      if (allowed) {
        try {
          await _deps.sendTelegramMessage(
            allowed,
            `A voicemail on the business line could not be texted through. Caller: ${fromE164 || 'withheld'}. It is still in the Twilio console.`
          );
        } catch (alertErr) {
          console.error(`[voicemail] primary backstop alert failed ${tail}: ${alertErr.message}`);
        }
      }
      return 'failed';
    }

    // A GATED send is not a delivery. sendSMS does not throw when notifications
    // are off or Twilio creds are missing; it returns a `dev-skipped-*` sid
    // (sms.js:20-29). Treating that as delivered would mark the row 'delivered'
    // and DELETE the recording, and because delivered_at is a one-way door and the
    // sweep only reaps 'recorded'/'failed', the voicemail would be parked outside
    // both retry and delivery forever. Same contract as the Telegram path's
    // {ok:false, skipped:true}: write NO status, keep the recording, stay retryable.
    if (!sms || String(sms.sid || '').startsWith('dev-skipped')) {
      console.log(`[voicemail] primary delivery gated off, recording retained and still retryable ${tail}`);
      return 'skipped';
    }

    await markDelivery({ callSid, status: 'delivered' });
    await deleteRecording(recordingSid);
    console.log(`[voicemail] delivered to the primary line ${tail} duration=${durationSec}s`);
    return 'delivered';
  }
```

Leave the existing Zul/Telegram path below this block exactly as it is.

- [ ] **Step 5: Thread `line` through `server/routes/voice.js` (THREE hops, not one)**

There is no `claimed.fromE164` anywhere; the local is `claim`. `line` has to be
added at three points, and the route's Zul-specific tail has to become line-aware or
the whole primary-SMS branch is unreachable and its failures alert the wrong person.

**(a) `claimVoicemail`'s return (`voice.js:565`):**

```js
  return { callSid, recordingSid, durationSec, fromE164: claim.fromE164, line: claim.line, tail };
```

**(b) `deliverClaimedVoicemail`'s destructure (`voice.js:568`):**

```js
async function deliverClaimedVoicemail({ callSid, recordingSid, durationSec, fromE164, line, tail }) {
```

**(c) The bootstrap gate (`voice.js:581-592`).** Today it returns early whenever
`TELEGRAM_ALLOWED_USER_ID` is unset, which on the primary line would skip a delivery
that never needed Telegram at all. Gate it per line:

```js
  // Zul's line delivers over Telegram, so her chat id is a hard precondition
  // there. The primary line delivers by SMS and does not need it, so gating it on
  // her id would make Dallas's voicemails silently undeliverable.
  const allowed = process.env.TELEGRAM_ALLOWED_USER_ID;
  if (line !== 'primary' && !allowed) {
    // Documented bootstrap mode. Deliberately writes NO status: the row stays
    // 'recorded', which is what keeps it inside the sweep's retry window.
    console.warn(`[voice/voicemail] TELEGRAM_ALLOWED_USER_ID unset, recording retained and still retryable ${tail}`);
    return;
  }
```

**(d) The job literal (`voice.js:598-600`):**

```js
  const outcome = await _deps.deliverVoicemail({
    callSid, recordingSid, durationSec, fromE164, line, chatId: allowed,
  });
```

**(e) The operator alerts (`voice.js:602-619`).** Both `unfetchable` and `failed`
currently Telegram Zul, so a primary-line failure would tell her about a voicemail
that is not hers and tell Dallas nothing. Route the alert to the line's owner:

```js
  const who = fromE164 || 'a withheld number';
  const alertOperator = async (text) => {
    if (line === 'primary') {
      const to = String(process.env.VM_TEXT_DESTINATION || '').trim();
      if (!/^\+[1-9]\d{6,14}$/.test(to)) {
        console.error(`[voice/voicemail] no primary alert destination ${tail}`);
        return;
      }
      await _deps.sendSMS({ to, body: text, meta: { skipLog: true, messageType: 'voicemail_alert' } })
        .catch((err) => console.error(`[voice/voicemail] primary alert failed ${tail}: ${err.message}`));
      return;
    }
    if (!allowed) return;
    await _deps.sendTelegramMessage(allowed, text)
      .catch((err) => console.error(`[voice/voicemail] telegram alert failed ${tail}: ${err.message}`));
  };
```

Then replace the two `await _deps.sendTelegramMessage(allowed, ...)` calls in the
`unfetchable` and `failed` branches with `await alertOperator(...)`, leaving their
Sentry captures and their messages otherwise unchanged.

This requires `sendSMS` on the route's `_deps` too. Add it beside the existing
`sendTelegramMessage` entry in `voice.js`'s `_deps` object:

```js
  sendSMS: (...a) => require('../utils/sms').sendSMS(...a),
```

- [ ] **Step 6: Make the redelivery sweep line-aware**

In `server/utils/vaCallingScheduler.js`, the sweep's SELECT (`vaCallingScheduler.js:184-196`) must read `line`, and the job it builds must pass it. Without this, a stuck primary row would redeliver to Zul's Telegram: the wrong person gets a client's voicemail.

Add `line` to the selected columns:

```js
    `SELECT call_sid, from_e164, recording_sid, duration_sec, attempts, line
       FROM voicemail_delivery
```

and add it to the `deliverVoicemail` job:

```js
        line: row.line,
```

Add a test to `server/utils/vaCallingScheduler.test.js`. The module's injection
helper is `__setDeps` (`vaCallingScheduler.js:43`, exported at `:267`), and the
suite already stubs `pool` with a query matcher; follow whatever matcher shape it
uses rather than the illustrative one here:

```js
const sched = require('./vaCallingScheduler');

test("reapUndeliveredVoicemails redelivers on the row's own line", async () => {
  const jobs = [];
  process.env.TELEGRAM_ALLOWED_USER_ID = '5550001';
  sched.__setDeps({
    notificationsEnabled: () => true,
    pool: { query: async (sql) => (/SELECT call_sid/.test(sql)
      ? { rows: [{
          call_sid: 'CAsweep1', from_e164: '+13125550147',
          recording_sid: 'RE' + 'a'.repeat(32), duration_sec: 10, attempts: 0, line: 'primary',
        }] }
      : { rows: [{ attempts: 1 }] }) },
    deliverVoicemail: async (job) => { jobs.push(job); return 'delivered'; },
  });
  await sched.reapUndeliveredVoicemails();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].line, 'primary', 'a primary row must never redeliver to Zul');
});
```

- [ ] **Step 7: Run every touched suite, one at a time**

```bash
node -r dotenv/config --test server/utils/voicemail.test.js
node -r dotenv/config --test server/routes/voice.test.js
node -r dotenv/config --test server/utils/vaCallingScheduler.test.js
```
Expected: PASS on all three.

- [ ] **Step 8: Run the suites this change reaches**

`deliverVoicemail` and `claimDelivery` changed shape. Grep the callers and run their suites:

Run: `grep -rn "deliverVoicemail\|claimDelivery" server --include=*.js | grep -v node_modules`
Expected callers: `server/routes/voice.js`, `server/utils/vaCallingScheduler.js` (both covered above). Run any other suite that appears.

- [ ] **Step 9: Commit**

```bash
git add server/utils/voicemail.js server/utils/voicemail.test.js \
        server/routes/voice.js server/routes/voice.test.js \
        server/utils/vaCallingScheduler.js server/utils/vaCallingScheduler.test.js
git commit -m "feat(phone): per-line voicemail delivery, primary line texts the owner"
```

---

### Task 7: Split the public phone constants (voice to the 1922, text stays on the 888)

Spec Ops step 5 is a CODE change, not an owner checkbox: one constant currently
serves both "call us" and "text us", so repointing it at the 1922 would aim client
texting at a number with no SMS approval, and leaving it alone means no client ever
dials the new primary line.

**Files:**
- Modify: `client/src/utils/constants.js`
- Modify: `client/src/pages/Completion.js`
- Modify: `client/src/pages/ApplicationStatus.js`
- Modify: `client/src/pages/FieldGuide.js`
- Modify: `client/src/pages/PaydayProtocols.js`
- Modify: `client/src/pages/proposal/proposalView/ProposalView.js`

**Interfaces:**
- Produces: `COMPANY_PHONE` / `COMPANY_PHONE_TEL` (VOICE, the 1922) and
  `COMPANY_TEXT_PHONE` / `COMPANY_TEXT_PHONE_TEL` (SMS, the 888) in
  `client/src/utils/constants.js`.

There is no client test runner in this project, so verification is the CI build plus
a concrete manual read of each surface.

- [ ] **Step 1: Split the constants**

In `client/src/utils/constants.js`, replace the two existing lines
(`constants.js:4-5`) with four:

```js
// VOICE: the primary business line (+12242221922). This is the number to CALL.
export const COMPANY_PHONE = '(224) 222-1922';
export const COMPANY_PHONE_TEL = 'tel:+12242221922';
// SMS: still the toll-free 888 until the 224 numbers clear A2P 10DLC registration
// (spec Phase 2). Texting a number with no approved campaign does not deliver, so
// these MUST stay separate from the voice pair until that cutover.
export const COMPANY_TEXT_PHONE = '(888) 231-4320';
export const COMPANY_TEXT_PHONE_TEL = 'sms:+18882314320';
```

Confirm the 888's real digits against `TWILIO_PHONE_NUMBER` before committing; the
value above is from `reference-twilio-account` and must match what actually sends.

- [ ] **Step 2: Repoint the two "Text us" links to the text pair**

`client/src/pages/Completion.js:70` and `client/src/pages/ApplicationStatus.js:88`
both render `<a href={COMPANY_PHONE_TEL}>Text us at {COMPANY_PHONE}</a>`. Both become:

```jsx
<a href={COMPANY_TEXT_PHONE_TEL}>Text us at {COMPANY_TEXT_PHONE}</a>
```

and their imports change from `{ COMPANY_PHONE, COMPANY_PHONE_TEL }` to
`{ COMPANY_TEXT_PHONE, COMPANY_TEXT_PHONE_TEL }` (Completion.js also imports
`WHATSAPP_GROUP_URL`; leave that alone).

- [ ] **Step 3: Fix the three display-only surfaces**

These are staff-facing and say "call or text", which is now two different numbers.

`client/src/pages/FieldGuide.js:138` and `:226` currently read "Text or Call
{COMPANY_PHONE}" and "Call or text Dr. Bartender immediately: {COMPANY_PHONE}".
Make the channel explicit:

```jsx
<li>Day-of or urgent issues? Call {COMPANY_PHONE} or text {COMPANY_TEXT_PHONE}</li>
```
```jsx
<li>Call Dr. Bartender immediately: <strong>{COMPANY_PHONE}</strong></li>
```

and add `COMPANY_TEXT_PHONE` to its import.

`client/src/pages/PaydayProtocols.js:272` reads "Dr. Bartender Company Line:
{COMPANY_PHONE}". That is a voice line, so it needs no change beyond inheriting the
new value.

`client/src/pages/proposal/proposalView/ProposalView.js:652` renders
`contact@drbartender.com · {COMPANY_PHONE}` in the client-facing footer. A client
reading a proposal is most likely to CALL, so the voice pair is correct here and it
needs no change beyond the new value.

- [ ] **Step 4: Verify no consumer was missed**

Run: `grep -rn "COMPANY_PHONE\|COMPANY_TEXT_PHONE" client/src --include=*.js`
Expected: exactly seven files (the constants file plus the six above), every usage
is intentionally on the voice pair or the text pair, and NO remaining site links the
word "text" to `COMPANY_PHONE_TEL`.

- [ ] **Step 5: Verify the client compiles the way Vercel will**

There is no client test runner, so this build is the gate. It is also what
`.husky/pre-push` runs, so catching it here avoids a failed push.

Run: `CI=true npx react-scripts build` from `client/`
Expected: "Compiled successfully". A missed import surfaces here as a build error.

- [ ] **Step 6: Manual read of each surface**

The build proves it compiles, not that the right number is shown. Confirm each of
the five pages renders the intended number for the intended channel (the two "Text
us" links show the 888, everything else shows the 1922).

- [ ] **Step 7: Commit**

```bash
git add client/src/utils/constants.js client/src/pages/Completion.js \
        client/src/pages/ApplicationStatus.js client/src/pages/FieldGuide.js \
        client/src/pages/PaydayProtocols.js \
        client/src/pages/proposal/proposalView/ProposalView.js
git commit -m "feat(phone): split voice and text company constants, voice to the 1922"
```

---

### Task 8: Env registration and documentation

**Files:**
- Modify: `.env.example`
- Modify: `.claude/CLAUDE.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Add the new vars to `.env.example`**

Add to the voicemail block (after `VM_GREETING_URL`, at `.env.example:245`):

```bash
# ── Phone system Phase 1a (spec 2026-07-26) ─────────────────────────────────
# What the primary line (+12242221922) dials to reach Dallas. Strict E.164.
# Normally the 312 Google Voice number, which rings his phone and keeps his
# personal cell private. Unset means the primary line apologizes and hangs up
# rather than emitting an empty Dial.
VM_PRIMARY_DIAL_TARGET=+13125889401
# Ring seconds on the primary line before Twilio calls it a miss (default 18,
# clamped 5..30). Deliberately SHORTER than a typical carrier/Google Voice
# voicemail pickup (~25s): if their voicemail answers first, Twilio reports
# completed and the caller lands in a dumb voicemail we cannot route.
VM_PRIMARY_RING_SEC=18
# Where a voicemail on the primary line is texted (the 312). Strict E.164.
# Sent from TWILIO_PHONE_NUMBER (the 888 until Phase 2), with skipLog so this
# internal alert never lands in a client's sms_messages thread.
VM_TEXT_DESTINATION=+13125889401
# Dallas's greeting, same contract as VM_GREETING_URL but for the primary line.
# Unset => the synthetic Dallas text (his recording does not exist yet); a full
# https URL => <Play> it. Never falls back to Zul's recording.
# VM_GREETING_URL_PRIMARY=
# Press-1 escalation master switch, default OFF. Off means both lines emit
# exactly the pre-feature greeting + Record document, no Gather.
VM_ESCALATION_ENABLED=false
# Max escalation legs per rolling 24h (default 25). Toll-fraud bound: a press-1
# is a billed outbound leg, and on the primary line it is INTERNATIONAL.
VM_ESCALATION_DAILY_CAP=25
# Quiet hours for the person being escalated TO, local to them, HH:MM-HH:MM.
# Inside the window the escalation is skipped and the caller goes to voicemail.
# Empty or unparseable disables the window. Windows may wrap midnight.
VM_ESCALATION_QUIET_ZUL=22:00-08:00
VM_ESCALATION_QUIET_PRIMARY=22:00-08:00
# Optional IANA zone overrides for those windows (defaults Asia/Manila for Zul,
# America/Chicago for Dallas).
# VM_ESCALATION_TZ_ZUL=Asia/Manila
# VM_ESCALATION_TZ_PRIMARY=America/Chicago
# Set to 'none' once a greeting recording itself announces the press-1 option.
# Default speaks a short synthetic prompt after the greeting, because neither
# recording mentions it today and the option would otherwise be invisible.
# VM_ESCALATION_PROMPT=none
```

- [ ] **Step 2: Add the rows to the `.claude/CLAUDE.md` env table**

Insert after the `VM_GREETING_URL` row (CLAUDE.md:315), one row per variable, using the wording from `.env.example` above condensed to a sentence each: `VM_PRIMARY_DIAL_TARGET`, `VM_PRIMARY_RING_SEC`, `VM_TEXT_DESTINATION`, `VM_GREETING_URL_PRIMARY`, `VM_ESCALATION_ENABLED`, `VM_ESCALATION_DAILY_CAP`, `VM_ESCALATION_QUIET_ZUL` / `VM_ESCALATION_QUIET_PRIMARY`, `VM_ESCALATION_TZ_ZUL` / `VM_ESCALATION_TZ_PRIMARY`, `VM_ESCALATION_PROMPT`.

- [ ] **Step 3: Update `README.md`**

- Environment Variables table: the same rows as step 2.
- Folder tree: add `server/routes/voiceEscalate.js`, `server/utils/voicemailLine.js`, `server/utils/voicemailTwiml.js`, `server/utils/voicemailEscalation.js`, each with a one-line description.
- The `voice.js` tree entry (`README.md:259`) enumerates that router's endpoints; add `POST /inbound/primary`.

- [ ] **Step 4: Update `ARCHITECTURE.md`**

- API route table, the `/api/voice` section: add `POST /inbound/primary`. ALSO correct the two existing rows at `ARCHITECTURE.md:437-438`, which still describe the pre-1a `/inbound` action URL (no `?line=`) and a missed-call document with no `<Gather>`. Add a new `/api/voice/escalate` table (mounted before `/api/voice`) with `POST /`, `POST /done`, `POST /whisper`, `POST /accept`, each fail-closed on signature.
- Database Schema: add `line`, `escalated_at`, `escalation_outcome` to the `voicemail_delivery` entry, including that `line` is NOT NULL DEFAULT `'zul'` and that the default IS the backfill for pre-2026-07-26 rows.
- The inbound-flow prose (`ARCHITECTURE.md:1589-1590`; note `:1581` is the SMS section): describe the two lines, the shared missed handler keyed on `line`, and the press-1 escalation with its four guards (kill switch, claim, cap, quiet window) and the key-to-accept whisper.
- Helper modules list: add the three new utils. Toll-fraud guards list: add `VM_ESCALATION_DAILY_CAP` and the escalation claim.

- [ ] **Step 4b: Document the phone-constant split**

`README.md` and `ARCHITECTURE.md` both describe the public phone number. Record that
voice and text are now two different numbers (`COMPANY_PHONE*` = the 1922 for calls,
`COMPANY_TEXT_PHONE*` = the 888 for texts) and that they reunite in Phase 2 once the
224 numbers clear A2P. Without this, the next person to touch a "call or text us"
surface will helpfully collapse them back into one.

- [ ] **Step 5: Verify the docs against the code that landed**

`git diff --stat` proves files were touched, not that content is right. Grep for the specific facts:

```bash
grep -n "VM_ESCALATION_ENABLED\|VM_PRIMARY_DIAL_TARGET\|VM_TEXT_DESTINATION" .claude/CLAUDE.md README.md .env.example
grep -n "inbound/primary\|api/voice/escalate" ARCHITECTURE.md README.md
grep -n "escalated_at\|escalation_outcome" ARCHITECTURE.md
grep -n "voicemailLine.js\|voicemailTwiml.js\|voicemailEscalation.js\|voiceEscalate.js" README.md
```
Expected: every command prints hits in every named file.

- [ ] **Step 6: Commit**

```bash
git add .env.example .claude/CLAUDE.md README.md ARCHITECTURE.md
git commit -m "docs(phone): register Phase 1a env vars, routes, and schema columns"
```

---

## Before the lane merges

- [ ] Run every touched suite one at a time (they share the dev DB):
  `server/db/schema.vaCalling.test.js`, `server/utils/voicemailLine.test.js`,
  `server/utils/voicemailTwiml.test.js`, `server/utils/voicemailEscalation.test.js`,
  `server/utils/voicemail.test.js`, `server/routes/voice.test.js`,
  `server/routes/voiceEscalate.test.js`, `server/utils/vaCallingScheduler.test.js`.
- [ ] `npx eslint server/` clean (0 errors).
- [ ] `npm run check:filesize` shows `server/routes/voice.js` in neither the RED nor the YELLOW list.
- [ ] Full review fleet (`security-review`, `database-review`, `code-review`, `consistency-check`) plus `/second-opinion`, since this is a billed-voice path.
- [ ] `CI=true npx react-scripts build` from `client/` passes (Task 7 touches the client, so `.husky/pre-push` will run this anyway).
- [ ] Confirm in Render, BEFORE the deploy that carries this code: `VOICEMAIL_ENABLED=true` (the primary line shares this master switch with Zul's, and with it off a missed primary call just hangs up), `VM_ESCALATION_ENABLED=false` (ships dark), `VM_PRIMARY_DIAL_TARGET` set, `VM_TEXT_DESTINATION` set. The escalation ships dark; the primary line does not, so its target must exist before the 1922's webhook is pointed at us.
- [ ] Note that `VM_DAILY_CAP` is shared across BOTH lines (it counts `voicemail_delivery` rows, which now include primary-line calls). Consider raising it from 50 if two lines of real volume would crowd it.

## Ops and live verification (owner, after deploy)

Code alone does not finish this. In order:

- [ ] **Twilio console:** point `+12242221922`'s Voice webhook at `POST https://api.drbartender.com/api/voice/inbound/primary`. Leave `+12242220082` alone.
- [ ] **Twilio console, the 1922's MESSAGING webhook:** point it at the existing inbound-SMS route (`POST https://api.drbartender.com/api/sms/inbound`), the same target the 888 uses. This is NOT the Phase 2 item (that is moving OUTBOUND client texts off the 888): the 1922 is about to become the number on the website, so a client who texts it must land somewhere instead of vanishing into an unconfigured number.
- [ ] **Know the rollback before you need it.** The escalation is env-revertable (`VM_ESCALATION_ENABLED=false`). The primary line is NOT: backing it out means un-pointing `+12242221922`'s Voice webhook in the Twilio console, which instantly returns that number to doing nothing. The lane squash-merges to one commit, so a git revert takes the schema and Zul's per-line greeting with it; prefer the console and env switches.
- [ ] **Google Voice on the 312:** confirm it forwards to Dallas's phone, and DISABLE its voicemail. This is the un-monitored manual setting the whole primary-line miss detection depends on; if it re-enables, callers hit a dumb voicemail we cannot route.
- [ ] **Live test, primary line:** call the 1922, let it ring out, confirm Dallas's greeting plays (not Zul's) and a text arrives at the 312 with the caller number. This proves GV voicemail did not intercept.
- [ ] **Live test, escalation:** set `VM_ESCALATION_ENABLED=true`. Call each line, press 1, and confirm (a) the other person's phone rings, (b) the whisper plays and the call only connects after a keypress, (c) letting it ring out with nobody answering returns you to the voicemail beep, and (d) pressing nothing at the greeting still records normally.
- [ ] **Live test, the whisper screen:** call, press 1, and let the target's phone go to ITS carrier voicemail without touching it. The caller must land back in our voicemail, not in the target's voicemail. This is the case the key-to-accept gate exists for; if it fails, re-check the `<Gather>`/`<Hangup>` ordering in the whisper document.
- [ ] **Live test, quiet window:** temporarily set a window covering now, press 1, confirm no dial and a normal recording.
- [ ] **Record Dallas's greeting** and set `VM_GREETING_URL_PRIMARY` (or bundle it the way Zul's is), then consider `VM_ESCALATION_PROMPT=none` once a re-recorded greeting announces the press-1 option itself.
- [ ] **Website:** point the public voice "call us" at the 1922. Note that `COMPANY_PHONE_TEL` also backs client "Text us" links (`client/src/pages/Completion.js:70`, `client/src/pages/ApplicationStatus.js:88`) and `COMPANY_PHONE` is displayed in five more places (`FieldGuide.js`, `PaydayProtocols.js`, `ProposalView.js:652`); texting stays on the 888 until Phase 2, so split the constants rather than repointing one and breaking the other.

## Deferred to Phase 1b (its own plan)

Transcription, the AI summary and tag, R2 audio storage with R2 as the redelivery
source, the token-gated listen-link page with its soft delete, and the 14-day
audio purge ordered before the row prune. Phase 1a deliberately leaves the
existing Twilio-fetch delivery path untouched so the shipped redelivery sweep
keeps working exactly as it does today.

## Deferred to Phase 2 (gated on 224 A2P approval)

Moving client SMS off the 888 to the 1922 and retiring the 888. Not startable
until that registration is filed and APPROVED.
