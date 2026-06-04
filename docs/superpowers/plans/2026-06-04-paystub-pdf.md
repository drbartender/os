# Paystub PDF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a staffer download a PDF paystub for any paid pay period from the staff Pay page.

**Architecture:** The paystub is generated lazily on first download (never at `mark-paid`, to protect the money path), uploaded to R2 under a deterministic per-contractor key, the key is cached on `payouts.paystub_storage_key`, and the staffer is served a short-lived presigned URL. Already-paid payouts backfill for free on their first download.

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

No schema change (`paystub_storage_key TEXT` already exists). No new env vars. No new npm packages.

**Money is integer cents** throughout (`payouts`/`payout_events` use `_cents` columns). Format only at render.

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
// PDF only. Source data is unchanged. Mirrors agreementPdf.js.
function normalizeForPdf(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/[•–]/g, '-').replace(/—/g, '--').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
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

> Column x-positions are a starting point; do a visual check on a real generated PDF during execution and nudge `COL_A`/`COL_B`/widths if anything wraps. The test only asserts a valid `%PDF` buffer; the layout is verified by eye.

- [ ] **Step 4: Run the tests, verify they pass**

Run: `node --test server/utils/paystubPdf.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/utils/paystubPdf.js server/utils/paystubPdf.test.js
git commit -m "feat(paystub): pdfkit paystub renderer + cents formatter"
```

---

### Task 2: Paystub data assembly (+ YTD)

**Files:**
- Create: `server/utils/paystubData.js`
- Test: covered by Task 3's DB test (assembly + endpoint share one seed). This task ships the module; Task 3 asserts it end to end.

**Context:** `assemblePaystubData(contractorId, periodId)` returns the exact object shape `renderPaystubPdf` expects, or `null` if there is no payout for that (contractor, period). YTD = this contractor's `paid` payouts whose period `payday` is in the same calendar year and on or before this payday; net from `payouts.total_cents` (canonical), category breakdown summed from `payout_events`.

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
  // 1. Payout head + period + contractor display name (legal name preferred
  //    for a pay document; mirrors accountReads.js name resolution).
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

- [ ] **Step 2: Commit**

```bash
git add server/utils/paystubData.js
git commit -m "feat(paystub): assemble paystub render data incl. YTD"
```

---

### Task 3: Download endpoint + DB test

**Files:**
- Modify: `server/routes/staffPortal/payouts.js` (add the route + imports)
- Test: `server/routes/staffPortal/payouts.paystub.test.js`

- [ ] **Step 1: Write the failing test**

Mirror the seed pattern in `server/routes/staffPortal.test.js` / `server/utils/payrollProcessing.test.js` (they already insert `users` → `pay_periods` → `payouts` → `shifts` → `payout_events`). Seed **two** paid periods for one contractor in the same year (an April period and a May period) so YTD has something to sum, plus one **unpaid** period, plus a second contractor's paid period (for the IDOR case). **Mock the storage layer** so no real R2 call happens:

```javascript
// server/routes/staffPortal/payouts.paystub.test.js
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../../utils/storage');

// Mock R2 before requiring anything that calls it.
mock.method(storage, 'uploadFile', async () => {});
mock.method(storage, 'getSignedUrl', async (key) => `https://signed.example/${key}`);

const { pool } = require('../../db');
const { assemblePaystubData } = require('../../utils/paystubData');
// ... build an Express app mounting server/routes/staffPortal.js with a stub
// auth that sets req.user.id = <seeded contractor>, OR call the route handler
// directly. Follow the harness used by staffPortal.test.js.

// SEED in before(), CLEAN UP in after() (delete child rows first to respect FKs).
// Assert:
//  1. assemblePaystubData(contractorId, mayPeriodId): thisPeriod.net_cents ===
//     the May payout total; ytd.net_cents === April total + May total;
//     ytd.wages_cents === sum of both periods' event wage_cents.
//  2. GET /api/me/payouts/:mayPeriodId/paystub (paid, key null):
//     200 { url }, uploadFile called exactly once, payouts.paystub_storage_key
//     now === 'paystubs/<contractor>/<mayPeriodId>.pdf'.
//  3. GET same again: 200 { url }, uploadFile NOT called a second time (cached).
//  4. GET an UNPAID period's paystub: 409.
//  5. GET the other contractor's period as this contractor: 404.
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --test server/routes/staffPortal/payouts.paystub.test.js`
Expected: FAIL (route returns 404 — `/paystub` not defined yet).

- [ ] **Step 3: Add imports + the route to `server/routes/staffPortal/payouts.js`**

At the top of the file, alongside the existing imports (`pool`, `asyncHandler`, `ValidationError`, `NotFoundError`, `ymd`), add:

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

> Confirm the exact `errors.js` class name is `ConflictError` (it is, per CLAUDE.md's AppError hierarchy) and that `payouts.js` does not already import it.

- [ ] **Step 4: Run the tests, verify they pass**

Run: `node --test server/routes/staffPortal/payouts.paystub.test.js`
Expected: PASS (assembly + 5 endpoint assertions). Run this suite **in isolation** (shared dev DB; see `reference_server_test_db_shared`).

- [ ] **Step 5: Commit**

```bash
git add server/routes/staffPortal/payouts.js server/routes/staffPortal/payouts.paystub.test.js
git commit -m "feat(paystub): lazy-generate + serve paystub download endpoint"
```

---

### Task 4: Wire the Pay page Download button

**Files:**
- Modify: `client/src/pages/staff/PayoutDetail.js`

- [ ] **Step 1: Add download state + handler**

Near the other `useState` hooks (around line 64), add:

```javascript
  const [downloading, setDownloading] = useState(false);
  const [downloadErr, setDownloadErr] = useState(null);
```

Near `fetchDetail` (around line 90), add:

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
      setDownloadErr(err?.message || 'Could not prepare the paystub. Try again.');
    } finally {
      setDownloading(false);
    }
  }, [periodId]);
```

- [ ] **Step 2: Enable the Download button + remove the dead Email stub**

Replace the existing Download button block (currently `disabled={!hasPaystub}` with the "coming soon" title, ~lines 299-307) with:

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

Delete the entire "Email a copy" button block (the `<button ... title="Email-a-copy coming soon">` and its leading TODO comment, ~lines 309-318). Email is out of scope; a staffer emails their own downloaded file.

Immediately after the actions `<div>` that holds the button, add the inline error:

```jsx
        {downloadErr && (
          <div className="sp-error-card-sub" style={{ marginTop: '0.4rem' }}>{downloadErr}</div>
        )}
```

The now-unused `hasPaystub` const (line 168) can stay or be removed; if eslint flags it as unused under `CI=true`, remove it.

- [ ] **Step 3: Verify the client build (authoritative gate)**

Run: `CI=true npm --prefix client run build`
Expected: "Compiled" / "The build folder is ready to be deployed." with only the pre-existing html2pdf source-map warning. (Local eslint skips `client/`, so this build is the real check.)

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/staff/PayoutDetail.js
git commit -m "feat(paystub): enable Pay page download, drop email-a-copy stub"
```

---

### Task 5: Documentation

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

**Spec coverage:** §2 lazy-on-download → Task 3. §3 layout + §4 YTD → Tasks 1 (render) + 2 (YTD queries). §5.1 renderer → Task 1. §5.2 assembly → Task 2. §5.3 endpoint → Task 3. §5.4 frontend → Task 4. §7 errors (unpaid 409, IDOR 404, race guard, generation failure via `ExternalServiceError` from `storage.js`) → Task 3. §8 security (user-scope, signed URLs, key never returned) → Task 3. §9 testing → Tasks 1 + 3. §10 out-of-scope (email removed, admin flagged) → Task 4 (email removed); admin remains a documented follow-up, no task. §11 docs → Task 5. No gaps.

**Placeholder scan:** Task 3's test is specified by intent + assertions + a concrete seed-source to mirror (rather than a guessed 100-line FK seed), because the seed must match `payout_events`/`shifts` NOT-NULL columns exactly; the implementer mirrors `staffPortal.test.js`. All implementation code is complete.

**Type consistency:** `renderPaystubPdf(data)` consumes exactly the object `assemblePaystubData` returns (`contractorName`, `period.{start_date,end_date,payday}`, `paid.{at,method,handle}`, `events[]`, `thisPeriod.{wages_cents,gratuity_cents,card_tips_net_cents,adjustments_cents,net_cents}`, `ytd.{same}`). `storageKey` is produced in `paystubData` and consumed in the endpoint. `formatUsdCents` exported from `paystubPdf` and used only there. Endpoint returns `{ url }`; the client reads `res.data.url`. Consistent.

---

## Notes for execution
- Money stays integer cents until `formatUsdCents` at render.
- Run server suites **one at a time** (shared dev DB).
- This is the `beo` worktree; do not push (the user controls deploy). The Phase 11 push work also sits unpushed on this branch.
