# Paystub PDF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a staffer download a PDF paystub for any paid pay period from the staff Pay page.

**Architecture:** The paystub is generated lazily on first download (never at `mark-paid`, to protect the money path), uploaded to R2 under a deterministic per-contractor key, the key is cached on `payouts.paystub_storage_key`, and the staffer is served a short-lived presigned URL (opened inline, `Content-Type: application/pdf`). Already-paid payouts backfill for free on their first download.

**Tech Stack:** Node/Express, raw SQL via `pg`, `pdfkit` (already a dep, see `server/utils/agreementPdf.js`), Cloudflare R2 via `server/utils/storage.js` (`uploadFile`/`getSignedUrl`), React (CRA) for the Pay page button. Spec: `docs/superpowers/specs/2026-06-04-paystub-pdf-design.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/utils/paystubPdf.js` (create) | Pure render: `renderPaystubPdf(data) => Promise<Buffer>` + `formatUsdCents(cents)`. No DB, no R2. |
| `server/utils/paystubData.js` (create) | `assemblePaystubData(contractorId, periodId) => Promise<object\|null>` — the queries (payout + name + events + this-period summary + YTD aggregates) shaped for the renderer. |
| `server/routes/staffPortal/payouts.js` (modify) | Add `GET /payouts/:periodId/paystub` (lazy-generate + serve signed URL). |
| `client/src/pages/staff/PayoutDetail.js` (modify) | Enable the Download PDF button (lazy fetch + open URL); remove the dead Email-a-copy stub. |
| `server/utils/paystubPdf.test.js` (create) | Unit test for the formatter + the render buffer. |
| `server/routes/staffPortal/payouts.paystub.test.js` (create) | DB-backed test for assembly (incl. YTD math) + the endpoint (mock storage). |
| `README.md`, `ARCHITECTURE.md` (modify) | Folder tree + route table + payroll-section mention. |

No schema change (`paystub_storage_key TEXT` already exists). No new env vars. No new npm packages. **Money is integer cents** throughout; format only at render.

## Review cadence (per the user's execution-review preference)

- After **Task 1** (pure renderer): `code-review`.
- After **Task 2** (backend: SQL, IDOR scope, lazy-write race, R2 upload): `database-review` + `security-review` + `code-review`.
- After **Task 3** (small client wiring): `code-review`.
- Task 4 (docs): none. No `consistency-check` (no schema change, no cross-cutting field rename).

---

### Task 1: Paystub PDF renderer (pure)

**Files:**
- Create: `server/utils/paystubPdf.js`
- Test: `server/utils/paystubPdf.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// server/utils/paystubPdf.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderPaystubPdf, formatUsdCents } = require('./paystubPdf');

test('formatUsdCents: integer cents to USD', () => {
  assert.equal(formatUsdCents(0), '$0.00');
  assert.equal(formatUsdCents(54740), '$547.40');
  assert.equal(formatUsdCents(382060), '$3,820.60');
  assert.equal(formatUsdCents(-1936), '-$19.36');
  assert.equal(formatUsdCents(null), '$0.00');
});

const FIXTURE = {
  contractorName: 'Jordan Blake',
  period: { start_date: '2026-05-16', end_date: '2026-05-31', payday: '2026-06-01' },
  paid: { at: '2026-06-01', method: 'venmo', handle: '@jblake' },
  events: [
    { event_date: '2026-05-17', client_name: 'Smith Family', event_type: 'wedding', event_type_custom: null, hours: 6, wage_cents: 24000, gratuity_share_cents: 5000, card_tip_net_cents: 3240, adjustment_cents: 0, adjustment_note: null, line_total_cents: 32240 },
    { event_date: '2026-05-24', client_name: 'Acme Co', event_type: 'corporate', event_type_custom: null, hours: 5, wage_cents: 20000, gratuity_share_cents: 1500, card_tip_net_cents: 0, adjustment_cents: 1000, adjustment_note: 'mileage', line_total_cents: 22500 },
  ],
  thisPeriod: { wages_cents: 44000, gratuity_cents: 6500, card_tips_net_cents: 3240, adjustments_cents: 1000, net_cents: 54740 },
  ytd: { wages_cents: 312000, gratuity_cents: 48000, card_tips_net_cents: 21060, adjustments_cents: 1000, net_cents: 382060 },
};

test('renderPaystubPdf: returns a PDF buffer', async () => {
  const buf = await renderPaystubPdf(FIXTURE);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(buf.length > 500);
});

test('renderPaystubPdf: tolerates empty events + missing paid handle', async () => {
  const buf = await renderPaystubPdf({ ...FIXTURE, events: [], paid: { at: '2026-06-01', method: 'check', handle: null } });
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --test server/utils/paystubPdf.test.js`
Expected: FAIL ("Cannot find module './paystubPdf'").

- [ ] **Step 3: Implement `server/utils/paystubPdf.js`**

```javascript
// server/utils/paystubPdf.js
const PDFDocument = require('pdfkit');

// Helvetica (pdfkit default) lacks some Unicode glyphs; fold to ASCII for the
// PDF only. Source data is unchanged. \u escapes (not literal glyphs) for
// encoding-safety, matching agreementPdf.js's style.
function normalizeForPdf(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/[\u2022\u2013]/g, '-')   // bullet, en dash
    .replace(/\u2014/g, '--')          // em dash
    .replace(/[\u2018\u2019]/g, "'")   // curly single quotes
    .replace(/[\u201C\u201D]/g, '"');  // curly double quotes
}

// Integer cents -> "$1,234.56" ("-$19.36" for negatives). Mirrors client formatMoney.
function formatUsdCents(cents) {
  const n = Math.round(Number(cents) || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  const rem = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}$${dollars}.${rem}`;
}

function eventLabel(ev) {
  const t = ev.event_type_custom || ev.event_type || 'event';
  return ev.client_name ? `${ev.client_name} / ${t}` : t;
}

/**
 * @param {object} data { contractorName, period:{start_date,end_date,payday},
 *   paid:{at,method,handle}, events:[...], thisPeriod:{..._cents}, ytd:{..._cents} }
 * @returns {Promise<Buffer>}
 */
function renderPaystubPdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const M = 54;            // left margin
      const COL_A = 320;       // "this period" column x
      const COL_B = 430;       // "year to date" column x
      const COL_W = 110;       // numeric column width

      // ── Header ──────────────────────────────────────────────
      doc.fontSize(18).font('Helvetica-Bold').text('Dr. Bartender', M, M, { continued: false });
      doc.fontSize(12).font('Helvetica').text('PAYSTUB', M, M + 2, { align: 'right' });
      doc.moveDown(0.6);
      doc.fontSize(12).font('Helvetica-Bold').text(normalizeForPdf(data.contractorName || 'Contractor'));
      doc.fontSize(9).font('Helvetica').fillColor('#555');
      doc.text(`Pay period: ${data.period.start_date} to ${data.period.end_date}`);
      doc.text(`Payday: ${data.period.payday}`);
      if (data.paid && data.paid.at) {
        const via = data.paid.method
          ? ` via ${data.paid.method}${data.paid.handle ? ` (${data.paid.handle})` : ''}` : '';
        doc.text(`Paid: ${data.paid.at}${via}`);
      }
      doc.fillColor('black').moveDown(1);

      // ── Line items ──────────────────────────────────────────
      doc.fontSize(11).font('Helvetica-Bold').text('Shifts this period');
      doc.moveDown(0.3);
      doc.fontSize(9).font('Helvetica');
      (data.events || []).forEach((ev) => {
        const y = doc.y;
        doc.text(`${ev.event_date || ''}  ${normalizeForPdf(eventLabel(ev))}`, M, y, { width: 250 });
        doc.text(`${ev.hours}h`, 300, y, { width: 40, align: 'right' });
        doc.text(formatUsdCents(ev.line_total_cents), 460, y, { width: 80, align: 'right' });
        if (Number(ev.adjustment_cents) !== 0) {
          doc.fillColor('#555').fontSize(8).text(
            `   ${formatUsdCents(ev.adjustment_cents)} adjustment${ev.adjustment_note ? `: ${normalizeForPdf(ev.adjustment_note)}` : ''}`,
            M, doc.y, { width: 480 }
          );
          doc.fillColor('black').fontSize(9);
        }
        doc.moveDown(0.15);
      });
      doc.moveDown(0.6);

      // ── Totals: this period | year to date ──────────────────
      const tp = data.thisPeriod, ytd = data.ytd;
      const headY = doc.y;
      doc.fontSize(8).fillColor('#555');
      doc.text('This period', COL_A, headY, { width: COL_W, align: 'right' });
      doc.text('Year to date', COL_B, headY, { width: COL_W, align: 'right' });
      doc.fillColor('black').moveDown(0.2);
      const totalsRow = (label, a, b, bold) => {
        const y = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5);
        doc.text(label, M, y, { width: 200 });
        doc.text(formatUsdCents(a), COL_A, y, { width: COL_W, align: 'right' });
        doc.text(formatUsdCents(b), COL_B, y, { width: COL_W, align: 'right' });
        doc.moveDown(0.25);
      };
      totalsRow('Wages', tp.wages_cents, ytd.wages_cents);
      totalsRow('Gratuity', tp.gratuity_cents, ytd.gratuity_cents);
      totalsRow('Card tips', tp.card_tips_net_cents, ytd.card_tips_net_cents);
      totalsRow('Adjustments', tp.adjustments_cents, ytd.adjustments_cents);
      doc.moveDown(0.15);
      totalsRow('NET PAID', tp.net_cents, ytd.net_cents, true);
      doc.moveDown(1);

      doc.fontSize(8).font('Helvetica').fillColor('#777')
        .text('Independent contractor payment, no taxes withheld (1099).', M, doc.y);
      doc.fillColor('black');

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderPaystubPdf, formatUsdCents };
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `node --test server/utils/paystubPdf.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Visual spot-check (the layout has no automated assertion)**

Run a throwaway script that writes the fixture buffer to a temp file and open it:
```bash
node -e "const {renderPaystubPdf}=require('./server/utils/paystubPdf'); const fs=require('fs'); const d=require('./server/utils/paystubPdf.test.js'); /* or inline the FIXTURE */" 2>/dev/null
# Simpler: in a node REPL, render the Task-1 FIXTURE and fs.writeFileSync('/tmp/paystub.pdf', buf), then open /tmp/paystub.pdf.
```
Eyeball: columns line up, the two-column "This period / Year to date" totals are aligned, NET PAID is bold, the adjustment footnote sits under its row, nothing wraps. Nudge `COL_A`/`COL_B`/widths in Step 3 if needed.

- [ ] **Step 6: Commit**

```bash
git add server/utils/paystubPdf.js server/utils/paystubPdf.test.js
git commit -m "feat(paystub): pdfkit paystub renderer + cents formatter"
```

---

### Task 2: Paystub backend (assembly + endpoint + DB test)

Assembly (`paystubData.js`) and the endpoint ship in **one commit**: `paystubData.js` has no unit test of its own, so it is verified by this task's DB test (which exercises assembly + the endpoint together) and never lands unverified.

**Files:**
- Create: `server/utils/paystubData.js`
- Modify: `server/routes/staffPortal/payouts.js`
- Test: `server/routes/staffPortal/payouts.paystub.test.js`

- [ ] **Step 1: Implement `server/utils/paystubData.js`**

```javascript
// server/utils/paystubData.js
const { pool } = require('../db');

function ymd(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

// Window predicate reused for both YTD aggregates: paid payouts for this
// contractor whose payday is in [Jan 1 of payday's year, this payday].
const YTD_WHERE = `
  po.contractor_id = $1
  AND po.status = 'paid'
  AND pp.payday >= date_trunc('year', $2::date)::date
  AND pp.payday <= $2::date`;

async function assemblePaystubData(contractorId, periodId) {
  // 1. Payout head + period + contractor display name. Legal name preferred for
  //    a pay document; then preferred_name, then email. (Same join sources as
  //    accountReads.js; precedence is deliberately legal-name-first here.)
  const head = await pool.query(
    `SELECT po.id AS payout_id, po.status, po.total_cents,
            po.paid_at, po.payment_method, po.payment_handle,
            pp.start_date, pp.end_date, pp.payday,
            COALESCE(ag.full_name, ap.full_name, cp.preferred_name, u.email) AS contractor_name
       FROM payouts po
       JOIN pay_periods pp ON pp.id = po.pay_period_id
       JOIN users u ON u.id = po.contractor_id
  LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
  LEFT JOIN agreements ag ON ag.user_id = u.id
  LEFT JOIN applications ap ON ap.user_id = u.id
      WHERE po.contractor_id = $1 AND po.pay_period_id = $2`,
    [contractorId, periodId]
  );
  if (!head.rows[0]) return null;
  const h = head.rows[0];

  // 2. This period's events (mirror the SELECT in staffPortal/payouts.js detail).
  const ev = await pool.query(
    `SELECT pe.shift_id, pe.hours, pe.wage_cents, pe.gratuity_share_cents,
            pe.card_tip_net_cents, pe.adjustment_cents, pe.adjustment_note,
            pe.line_total_cents,
            pr.event_date, pr.event_type, pr.event_type_custom,
            c.name AS client_name
       FROM payout_events pe
       JOIN shifts s ON s.id = pe.shift_id
  LEFT JOIN proposals pr ON pr.id = s.proposal_id
  LEFT JOIN clients c ON c.id = pr.client_id
      WHERE pe.payout_id = $1
      ORDER BY pr.event_date ASC, pe.id ASC`,
    [h.payout_id]
  );
  const sum = (k) => ev.rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  const thisPeriod = {
    wages_cents: sum('wage_cents'),
    gratuity_cents: sum('gratuity_share_cents'),
    card_tips_net_cents: sum('card_tip_net_cents'),
    adjustments_cents: sum('adjustment_cents'),
    net_cents: Number(h.total_cents), // canonical payout total, not a re-sum
  };

  // 3. YTD net (canonical) + category breakdown.
  const ytdNet = await pool.query(
    `SELECT COALESCE(SUM(po.total_cents), 0) AS net
       FROM payouts po JOIN pay_periods pp ON pp.id = po.pay_period_id
      WHERE ${YTD_WHERE}`,
    [contractorId, h.payday]
  );
  const ytdCat = await pool.query(
    `SELECT COALESCE(SUM(pe.wage_cents),0) AS wages,
            COALESCE(SUM(pe.gratuity_share_cents),0) AS gratuity,
            COALESCE(SUM(pe.card_tip_net_cents),0) AS card_tips,
            COALESCE(SUM(pe.adjustment_cents),0) AS adjustments
       FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id
       JOIN pay_periods pp ON pp.id = po.pay_period_id
      WHERE ${YTD_WHERE}`,
    [contractorId, h.payday]
  );

  return {
    status: h.status,
    storageKey: `paystubs/${contractorId}/${periodId}.pdf`,
    contractorName: h.contractor_name,
    period: { start_date: ymd(h.start_date), end_date: ymd(h.end_date), payday: ymd(h.payday) },
    paid: { at: ymd(h.paid_at), method: h.payment_method, handle: h.payment_handle },
    events: ev.rows.map((r) => ({
      event_date: ymd(r.event_date),
      client_name: r.client_name || null,
      event_type: r.event_type || null,
      event_type_custom: r.event_type_custom || null,
      hours: r.hours,
      wage_cents: r.wage_cents,
      gratuity_share_cents: r.gratuity_share_cents,
      card_tip_net_cents: r.card_tip_net_cents,
      adjustment_cents: r.adjustment_cents,
      adjustment_note: r.adjustment_note,
      line_total_cents: r.line_total_cents,
    })),
    thisPeriod,
    ytd: {
      wages_cents: Number(ytdCat.rows[0].wages),
      gratuity_cents: Number(ytdCat.rows[0].gratuity),
      card_tips_net_cents: Number(ytdCat.rows[0].card_tips),
      adjustments_cents: Number(ytdCat.rows[0].adjustments),
      net_cents: Number(ytdNet.rows[0].net),
    },
  };
}

module.exports = { assemblePaystubData };
```

> **Edge (expected):** a paid period with zero `payout_events` (e.g. the `staffPortal.test.js` seed at ~line 198) renders NET PAID from the canonical `total_cents` with zeroed category lines. The renderer handles `events: []` (Task 1 covers it). No special-casing needed.

- [ ] **Step 2: Add imports + the route to `server/routes/staffPortal/payouts.js`**

At the top, alongside the existing imports (`pool`, `asyncHandler`, `ValidationError`, `NotFoundError`, `ymd`), add (`ConflictError` is exported from `server/utils/errors.js` and is not yet imported in this file):

```javascript
const { ConflictError } = require('../../utils/errors');
const { uploadFile, getSignedUrl } = require('../../utils/storage');
const { assemblePaystubData } = require('../../utils/paystubData');
const { renderPaystubPdf } = require('../../utils/paystubPdf');
```

Inside `register(router)`, after the existing `router.get('/payouts/:periodId', ...)`, add:

```javascript
  // ─── GET /api/me/payouts/:periodId/paystub ───────────────────────────────
  // Lazy-generate the paystub PDF on first download, then serve a short-lived
  // signed URL. Never touches mark-paid. IDOR-scoped to req.user.id.
  router.get('/payouts/:periodId/paystub', asyncHandler(async (req, res) => {
    const periodId = Number(req.params.periodId);
    if (!Number.isInteger(periodId) || periodId <= 0) {
      throw new ValidationError({ periodId: 'must be a positive integer' }, 'Invalid period id');
    }

    const lookup = await pool.query(
      `SELECT id, status, paystub_storage_key
         FROM payouts WHERE contractor_id = $1 AND pay_period_id = $2`,
      [req.user.id, periodId]
    );
    if (!lookup.rows[0]) throw new NotFoundError('Payout not found');
    const payout = lookup.rows[0];

    if (payout.status !== 'paid') {
      throw new ConflictError('Your paystub is available once the period is paid.');
    }

    // Already generated -> serve it.
    if (payout.paystub_storage_key) {
      return res.json({ url: await getSignedUrl(payout.paystub_storage_key) });
    }

    // Lazy generation. Assemble -> render -> upload -> persist (race-guarded).
    const data = await assemblePaystubData(req.user.id, periodId);
    if (!data) throw new NotFoundError('Payout not found');
    const buffer = await renderPaystubPdf(data);
    await uploadFile(buffer, data.storageKey);

    const upd = await pool.query(
      `UPDATE payouts SET paystub_storage_key = $1
        WHERE id = $2 AND paystub_storage_key IS NULL
        RETURNING paystub_storage_key`,
      [data.storageKey, payout.id]
    );
    // Deterministic key, so a lost race just reuses the stored value.
    let key = upd.rows[0] && upd.rows[0].paystub_storage_key;
    if (!key) {
      const re = await pool.query('SELECT paystub_storage_key FROM payouts WHERE id = $1', [payout.id]);
      key = (re.rows[0] && re.rows[0].paystub_storage_key) || data.storageKey;
    }
    res.json({ url: await getSignedUrl(key) });
  }));
```

- [ ] **Step 3: Write the failing DB test**

`server/routes/staffPortal/payouts.paystub.test.js`. Mirror the seed in `server/routes/staffPortal.test.js` / `server/utils/payrollProcessing.test.js` (they insert `users` → `pay_periods` → `payouts` → `shifts` → `payout_events`). Seed, for ONE contractor: an **April** paid period and a **May** paid period in the same calendar year (so YTD sums two), each with `payout_events`; plus one **unpaid** period; plus a **second contractor's** paid period (for IDOR). Mock the storage layer so no real R2 call happens:

```javascript
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../../utils/storage');
mock.method(storage, 'uploadFile', async () => {});
mock.method(storage, 'getSignedUrl', async (key) => `https://signed.example/${key}`);

const { pool } = require('../../db');
const { assemblePaystubData } = require('../../utils/paystubData');
// Mount staffPortal.js on an Express app with a stub auth setting
// req.user.id = <seeded contractor>, OR call the route handler directly —
// follow the harness staffPortal.test.js already uses.
```

Assertions:
1. `assemblePaystubData(contractor, mayPeriodId)`: `thisPeriod.net_cents === mayPayout.total_cents`; `ytd.net_cents === aprilTotal + mayTotal`; `ytd.wages_cents === sum of both periods' event wage_cents`.
2. `GET /api/me/payouts/:mayPeriodId/paystub` (paid, key null): 200 `{ url }`; `uploadFile` called exactly once; `payouts.paystub_storage_key` now `=== 'paystubs/<contractor>/<mayPeriodId>.pdf'`.
3. Same GET again: 200 `{ url }`; `uploadFile` NOT called a second time (cached).
4. GET the unpaid period's paystub: 409.
5. GET the second contractor's period as this contractor: 404.

In `after()`, delete in FK order (children first): `payout_events` → `shifts` → `payouts` → `pay_periods` → `proposals` → `clients` → `users`.

- [ ] **Step 4: Run it, verify it fails**

Run: `node --test server/routes/staffPortal/payouts.paystub.test.js`
Expected: FAIL (route 404 — `/paystub` not added until Step 2 is saved; if you wrote Step 2 first, the test fails on the assertions instead). Run **in isolation** (shared dev DB; see `reference_server_test_db_shared`).

- [ ] **Step 5: Make it pass**

With Steps 1-2 implemented, run again:
Run: `node --test server/routes/staffPortal/payouts.paystub.test.js`
Expected: PASS (assembly + 5 endpoint assertions).

- [ ] **Step 6: Commit (assembly + endpoint + test together)**

```bash
git add server/utils/paystubData.js server/routes/staffPortal/payouts.js server/routes/staffPortal/payouts.paystub.test.js
git commit -m "feat(paystub): assembly + lazy-generate download endpoint"
```

---

### Task 3: Wire the Pay page Download button

**Files:**
- Modify: `client/src/pages/staff/PayoutDetail.js`

- [ ] **Step 1: Add download state + handler**

Near the other `useState` hooks (around line 64), add:

```javascript
  const [downloading, setDownloading] = useState(false);
  const [downloadErr, setDownloadErr] = useState(null);
```

Near `fetchDetail` (around line 90), add (`useCallback` is already imported):

```javascript
  const handleDownload = useCallback(async () => {
    setDownloading(true);
    setDownloadErr(null);
    try {
      const res = await api.get(`/me/payouts/${periodId}/paystub`);
      if (res.data && res.data.url) {
        window.open(res.data.url, '_blank', 'noopener');
      } else {
        setDownloadErr('Could not prepare the paystub. Try again.');
      }
    } catch (err) {
      // Covers both the network/500 case and a 409 (unpaid) defense-in-depth,
      // though the button only renders for paid periods.
      setDownloadErr(err?.message || 'Could not prepare the paystub. Try again.');
    } finally {
      setDownloading(false);
    }
  }, [periodId]);
```

- [ ] **Step 2: Enable the Download button + remove the dead Email stub + drop `hasPaystub`**

The Download button sits inside the existing `{isPaid && ( ... )}` wrapper (~line 294) — **keep that wrapper**. Replace only the inner button (currently `disabled={!hasPaystub}` with the "coming soon" title, ~lines 299-307) with:

```jsx
          <button
            type="button"
            className="sp-btn"
            onClick={handleDownload}
            disabled={downloading}
          >
            <DownloadIcon size={13} />
            {downloading ? 'Preparing…' : 'Download PDF'}
          </button>
```

Delete the entire "Email a copy" button block (the `<button ... title="Email-a-copy coming soon">` plus its leading TODO comment, ~lines 309-318). Email is out of scope.

Immediately after the actions `<div>` that holds the button, add the inline error:

```jsx
        {downloadErr && (
          <div className="sp-error-card-sub" style={{ marginTop: '0.4rem' }}>{downloadErr}</div>
        )}
```

**Remove** the now-unused `const hasPaystub = !!payout.paystub_storage_key;` (line 168) and its leading comment — it has no consumer once the button no longer reads it, and `CI=true` flags unused vars.

- [ ] **Step 3: Verify the client build (authoritative gate)**

Run: `CI=true npm --prefix client run build`
Expected: "The build folder is ready to be deployed." with only the pre-existing html2pdf source-map warning. No `no-unused-vars` error for `hasPaystub`.

- [ ] **Step 4: Manual verification (dev)**

With the dev server running (see `reference_staff_portal_local_review` for the staff-host setup) and a paid period seeded for the logged-in staffer: open `/pay`, tap the period, click **Download PDF** → expect a new tab showing the PDF. Confirm the button shows "Preparing…" briefly. Force a failure (e.g. stop the server mid-click) → expect the inline error under the button. Unpaid periods: the button is not rendered (gated by `isPaid`).

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/staff/PayoutDetail.js
git commit -m "feat(paystub): enable Pay page download, drop email-a-copy stub"
```

---

### Task 4: Documentation

**Files:**
- Modify: `README.md` (folder tree), `ARCHITECTURE.md` (route table + payroll mention)

- [ ] **Step 1: README folder tree** — add `paystubPdf.js` and `paystubData.js` to the `server/utils/` listing (near `agreementPdf.js`), one line each.

- [ ] **Step 2: ARCHITECTURE route table** — add a row: `GET /api/me/payouts/:periodId/paystub` — "Lazy-generates (first call) + serves a signed-URL paystub PDF for a paid period; user-scoped."

- [ ] **Step 3: ARCHITECTURE payroll/staff-portal section** — one sentence: paystub PDFs render via `paystubPdf.js` (pdfkit) from `paystubData.js`, are stored in R2 under `paystubs/<contractor_id>/<period_id>.pdf`, generated lazily on first download, and never touch `mark-paid`.

- [ ] **Step 4: Commit**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs(paystub): document the paystub PDF route + utils"
```

---

## Self-Review

**Spec coverage:** §2 lazy-on-download → Task 2. §3 layout + §4 YTD → Task 1 (render) + Task 2 (YTD queries). §5.1 renderer → Task 1. §5.2 assembly + §5.3 endpoint → Task 2 (one commit). §5.4 frontend (inline error, `isPaid` gate) → Task 3. §7 errors (unpaid 409, IDOR 404, race guard, generation failure via `ExternalServiceError` from `storage.js`) → Task 2. §8 security → Task 2. §9 testing → Tasks 1 + 2. §10 (email removed; admin a documented follow-up; pre-gen rejected) → Task 3 removes email; no admin task. §11 docs → Task 4. The spec's `ResponseContentDisposition` line was reconciled to inline-open (no plan step needed). No gaps.

**Placeholder scan:** Task 2 Step 3's test is specified by intent + assertions + a concrete seed-source to mirror (the FK seed must match `payout_events`/`shifts` NOT-NULL columns exactly; the implementer mirrors `staffPortal.test.js`). All implementation + the pure unit test are complete code.

**Type consistency:** `renderPaystubPdf(data)` consumes exactly what `assemblePaystubData` returns (`contractorName`, `period.{start_date,end_date,payday}`, `paid.{at,method,handle}`, `events[]`, `thisPeriod.{wages_cents,gratuity_cents,card_tips_net_cents,adjustments_cents,net_cents}`, `ytd.{same}`). `storageKey` produced in `paystubData`, consumed in the endpoint. `formatUsdCents` exported from `paystubPdf`, used only there. Endpoint returns `{ url }`; client reads `res.data.url`. Consistent.

---

## Notes for execution
- Money stays integer cents until `formatUsdCents` at render.
- Run server suites **one at a time** (shared dev DB).
- This is the `beo` worktree; do not push (the user controls deploy). The Phase 11 push work also sits unpushed on this branch.
