#!/usr/bin/env node
/**
 * One-time CheckCherry LEDGER import (phase 2 of the lean cc-import reboot).
 *
 * Loads the frozen CC-era numbers into the legacy_cc_* sidecar tables so the
 * metrics layer can blend them. Feeds metrics ONLY — never workflows, never
 * money movement (payroll/invoices/Stripe untouched by design).
 *
 *   --payments "<path>/report (1).csv"   payments + refunds (353 rows)
 *   --expenses "<path>/report (4).csv"   staff payouts + other expenses (116 rows)
 *   --events   "<path>/report.csv"       ALL events incl. dead quotes (1,244 rows)
 *   --replace                            TRUNCATE the three ledger tables first
 *   --apply                              actually write; default = dry run
 *
 * Semantics: replace, not upsert. The archived exports are the source of
 * truth; recovery = reload from files. Without --replace, --apply aborts if
 * any target table is non-empty (dupe guard). Verification gates (row counts
 * and P&L ties to the penny) run in BOTH modes and a failed gate aborts the
 * apply before any write.
 *
 * Prod run order: deploy first (schema.sql relaxes raw_import_id + adds the
 * funnel columns via initDb), then dry-run, then --replace --apply on
 * Dallas's explicit go.
 */

const fs = require('fs');
const { parse } = require('csv-parse/sync');

// ── expected values (frozen historical facts, from CC's own P&L exports) ──
const EXPECT = {
  payments: 353,
  paymentsAppliedCents: 13678135,   // $136,781.35 all-time Sales
  payments2024Cents: 319000,        // $3,190.00   (P&L 03-01-2024..12-31-2024)
  payments2025Cents: 10282885,      // $102,828.85 (P&L 2025)
  tipsCents: 263600,                // $2,636.00
  expenses: 116,
  staffPaymentsCents: 1757509,      // $17,575.09
  events: 1244,
  booked: 214,                      // Confirmed (204) + Canceled Booking (10)
};

const STATUS_MAP = {
  'Confirmed': 'booked',
  'Canceled Booking': 'cancelled_booking',
  'Proposal (Date Open)': 'quote_open',
  'Canceled Proposal': 'quote_cancelled',
  'Expired Proposal': 'quote_expired',
  'Postponed Proposal': 'quote_postponed',
};

// ── pure helpers (exported for tests) ─────────────────────────────

function decodeExport(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

function loadCsv(absPath) {
  const text = decodeExport(fs.readFileSync(absPath));
  return parse(text, { columns: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true, bom: true });
}

/**
 * Money string -> integer cents via decimal-string math (no float drift).
 * Handles "$1,085", "$-385", "($385)", "$999.35", "1,085.5". Blank -> null.
 */
function parseCents(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return null;
  const [intPart = '0', fracPart = ''] = s.split('.');
  const frac2 = (fracPart + '00').slice(0, 2);
  const extra = fracPart.length > 2 && Number(fracPart[2]) >= 5 ? 1 : 0; // round half-up on sub-cent
  const cents = Number(intPart) * 100 + Number(frac2) + extra;
  return neg ? -cents : cents;
}

/** "0.0%" / "10.25%" -> 0.0 / 10.25; blank -> null. */
function parsePct(raw) {
  const s = String(raw ?? '').replace('%', '').trim();
  if (!s) return null;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

/** First MM-DD-YYYY in the string -> "YYYY-MM-DD" (multi-day events keep day one). */
function firstIsoDate(raw) {
  const m = String(raw || '').match(/(\d{2})-(\d{2})-(\d{4})/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

/** "03-16-2026  7:49 PM" -> "2026-03-16 19:49:00"; bare date -> midnight; blank -> null. */
function parseTimestamp(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM))?$/i);
  if (!m) return null;
  let hh = 0, mm = 0;
  if (m[4]) {
    hh = Number(m[4]) % 12;
    if (/pm/i.test(m[6])) hh += 12;
    mm = Number(m[5]);
  }
  const p = (n) => String(n).padStart(2, '0');
  return `${m[3]}-${m[1]}-${m[2]} ${p(hh)}:${p(mm)}:00`;
}

function normalizeStatus(raw) {
  const mapped = STATUS_MAP[String(raw || '').trim()];
  if (!mapped) throw new Error(`unknown CC event status: "${raw}"`);
  return mapped;
}

function normalizeName(raw) {
  return String(raw || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeEmail(raw) {
  if (raw == null) return null;
  const lower = String(raw).trim().toLowerCase();
  if (!lower || !lower.includes('@')) return null;
  return lower;
}

/** First email out of a "a@x.com; b@y.com" style list; Contact wins over User. */
function firstEmail(row) {
  for (const col of ['Contact Email(s)', 'User Email(s)']) {
    for (const piece of String(row[col] || '').split(/[,;]/)) {
      const e = normalizeEmail(piece);
      if (e) return e;
    }
  }
  return null;
}

function intOrNull(raw) {
  const v = parseInt(String(raw ?? '').replace(/,/g, '').trim(), 10);
  return Number.isFinite(v) ? v : null;
}

const trim = (raw) => String(raw ?? '').trim() || null;

// ── row builders ───────────────────────────────────────────────────

function buildPayments(rows) {
  return rows.map((r) => ({
    cc_event_title: trim(r['Event Title']),
    cc_type: String(r.Type || '').trim(), // 'Payment' | 'Refund' verbatim (table CHECK)
    paid_on: firstIsoDate(r['Paid On']),
    event_date: firstIsoDate(r['Event Date']),
    payment_applied_cents: parseCents(r['Payment Applied']) ?? 0,
    tip_cents: parseCents(r['Tip Amount']) ?? 0,
    processing_fee_cents: parseCents(r['Processing Fees']) ?? 0,
    net_cents: parseCents(r['Net Amount']) ?? 0,
    event_total_cents: parseCents(r['Event Total']),
    taxable_cents: parseCents(r['Taxable Amount']),
    total_adjustment_cents: parseCents(r['Total Adjustment Amount']),
    tax_rate_pct: parsePct(r['Tax Rate']),
    tax_collected_cents: parseCents(r['Tax Collected']),
    payment_method: trim(r['Payment Method']),
    processor: trim(r.Processor),
    receipt_number: trim(r['Receipt Number']),
    invoice_number: trim(r['Invoice Number']),
    reference_code: trim(r['Reference Code']),
    paid_by: trim(r['Paid By']),
    assigned_staff: trim(r['Assigned Staff']),
    public_notes: trim(r['Public Notes']),
    private_notes: trim(r['Private Notes']),
  }));
}

function buildPayouts(rows, userIdByName = new Map()) {
  return rows.map((r) => {
    const payee = String(r.Payee || '').trim();
    const norm = normalizeName(payee);
    return {
      payee_name: payee,
      payee_name_normalized: norm,
      payee_user_id: userIdByName.get(norm) ?? null,
      paid_on: firstIsoDate(r.Date),
      amount_cents: parseCents(r.Amount) ?? 0,
      reference_role: trim(r.Reference),
      category: trim(r.Category),
    };
  });
}

function buildEvents(rows, clientIdByEmail = new Map()) {
  return rows.map((r) => {
    const email = firstEmail(r);
    return {
      cc_id: String(r.ID || '').trim(),
      status: normalizeStatus(r.Status),
      client_id: (email && clientIdByEmail.get(email)) ?? null,
      client_email_normalized: email,
      client_name: trim(r['Contact Name(s)']) || trim(r['User Name(s)']),
      event_date: firstIsoDate(r['Event Date']),
      event_type: trim(r['Event Type']),
      package_name: trim(r['Package Name']),
      service_name: trim(r['Service Name']),
      brand: trim(r.Brand),
      venue_name: trim(r['Venue Name']),
      venue_full_address: trim(r['Venue Full Address']),
      estimated_guests: intOrNull(r['Estimated Number of Guests']),
      source: trim(r.Source) || trim(r.Origin),
      lead_type: trim(r['Lead Type']),
      total_cost_cents: parseCents(r['Total Cost']),
      cc_created_at: parseTimestamp(r['Created At']),
      booked_at: parseTimestamp(r['Booked At']),
      public_notes: trim(r['Public Notes']),
      private_notes: trim(r['Private Notes']),
    };
  });
}

// ── verification gates (run in dry-run AND before apply) ──────────

function verify(payments, payouts, events) {
  const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
  const inYear = (p, y) => (p.paid_on || '').startsWith(y);
  const checks = [
    ['payments row count', payments.length, EXPECT.payments],
    ['payments applied cents (all-time Sales)', sum(payments, (p) => p.payment_applied_cents), EXPECT.paymentsAppliedCents],
    ['payments 2024 cents (P&L 2024)', sum(payments.filter((p) => inYear(p, '2024')), (p) => p.payment_applied_cents), EXPECT.payments2024Cents],
    ['payments 2025 cents (P&L 2025)', sum(payments.filter((p) => inYear(p, '2025')), (p) => p.payment_applied_cents), EXPECT.payments2025Cents],
    ['tip cents', sum(payments, (p) => p.tip_cents), EXPECT.tipsCents],
    ['expense row count', payouts.length, EXPECT.expenses],
    ['staff payment cents (P&L Staff Payments)', sum(payouts.filter((p) => p.category === 'Staff Payments'), (p) => p.amount_cents), EXPECT.staffPaymentsCents],
    ['event row count', events.length, EXPECT.events],
    ['booked events (booked_at set)', events.filter((e) => e.booked_at).length, EXPECT.booked],
  ];
  const failures = checks.filter(([, got, want]) => got !== want);
  return { checks, failures };
}

// ── db plumbing (insertBatch exported for the alignment unit test) ──

async function insertBatch(client, table, rows, columns) {
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const params = [];
    const tuples = chunk.map((row, r) => {
      const ph = columns.map((c, cIdx) => {
        params.push(row[c]);
        return `$${r * columns.length + cIdx + 1}`;
      });
      return `(${ph.join(',')}, NOW())`;
    });
    await client.query(
      `INSERT INTO ${table} (${columns.join(',')}, imported_at) VALUES ${tuples.join(',')}`,
      params
    );
  }
}

async function run() {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const paths = { payments: getArg('--payments'), expenses: getArg('--expenses'), events: getArg('--events') };
  const apply = args.includes('--apply');
  const replace = args.includes('--replace');
  if (!paths.payments || !paths.expenses || !paths.events) {
    console.error('Usage: cc-ledger-import.js --payments <report (1).csv> --expenses <report (4).csv> --events <report.csv> [--replace] [--apply]');
    process.exit(1);
  }

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // Staff display names live in agreements.full_name (legal signed name);
    // exact normalized match only — v1's fuzzy matching caused mis-assignment.
    const { rows: userRows } = await pool.query(
      'SELECT u.id, ag.full_name FROM users u JOIN agreements ag ON ag.user_id = u.id WHERE ag.full_name IS NOT NULL'
    );
    const userIdByName = new Map(userRows.map((u) => [normalizeName(u.full_name), u.id]));
    const { rows: clientRows } = await pool.query('SELECT id, lower(email) AS email FROM clients WHERE email IS NOT NULL');
    const clientIdByEmail = new Map(clientRows.map((c) => [c.email, c.id]));

    const payments = buildPayments(loadCsv(paths.payments));
    const payouts = buildPayouts(loadCsv(paths.expenses), userIdByName);
    const events = buildEvents(loadCsv(paths.events), clientIdByEmail);

    const { checks, failures } = verify(payments, payouts, events);
    console.log('Verification gates:');
    for (const [label, got, want] of checks) {
      console.log(`  ${got === want ? 'PASS' : 'FAIL'}  ${label}: ${got}${got === want ? '' : ` (expected ${want})`}`);
    }
    const linked = events.filter((e) => e.client_id).length;
    const matchedPayees = new Set(payouts.filter((p) => p.payee_user_id).map((p) => p.payee_name_normalized));
    console.log(`Info: events linked to a client: ${linked}; distinct payees matched to users: ${matchedPayees.size}`);

    const { rows: existing } = await pool.query(
      "SELECT (SELECT count(*)::int FROM legacy_cc_payments) pay, (SELECT count(*)::int FROM legacy_cc_payouts) exp, (SELECT count(*)::int FROM legacy_cc_proposals) ev"
    );
    console.log(`Target tables currently: payments=${existing[0].pay} payouts=${existing[0].exp} events=${existing[0].ev}${replace ? ' (will be TRUNCATED)' : ''}`);

    // Double-count guard (per-lane review finding): the metrics blend adds
    // ledger sums ON TOP of native tables, so it is only correct when no
    // native row duplicates a ledger row. v1's importer "promoted" CC
    // payments into proposal_payments (legacy_charge_id) and stamped
    // proposals.cc_id — a database carrying those would count that money
    // TWICE under the blended 'all' view. Prod has zero; dev still carries
    // v1 test junk, hence the explicit bypass.
    const { rows: dupes } = await pool.query(
      `SELECT (SELECT count(*)::int FROM proposals WHERE cc_id IS NOT NULL) cc_props,
              (SELECT count(*)::int FROM proposal_payments WHERE legacy_charge_id IS NOT NULL) promoted_pays`
    );
    const promotedContamination = dupes[0].cc_props + dupes[0].promoted_pays;
    console.log(`Double-count guard: proposals with cc_id=${dupes[0].cc_props}, promoted payments=${dupes[0].promoted_pays}${promotedContamination ? '  <-- blended metrics would DOUBLE-COUNT this era' : ''}`);

    if (!apply) {
      console.log('\nDRY RUN - nothing written. Re-run with --apply (add --replace to reload non-empty tables).');
      return;
    }
    if (failures.length) {
      console.error(`\nABORTED: ${failures.length} verification gate(s) failed; nothing written.`);
      process.exit(1);
    }
    if (promotedContamination && !args.includes('--allow-promoted')) {
      console.error('\nABORTED: native tables carry v1-promoted CC rows (see double-count guard above); loading the ledger would double-count that money in blended metrics. Scrub them or pass --allow-promoted (dev only).');
      process.exit(1);
    }
    if (!replace && (existing[0].pay || existing[0].exp || existing[0].ev)) {
      console.error('\nABORTED: target tables are non-empty and --replace was not given; nothing written.');
      process.exit(1);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (replace) {
        await client.query('TRUNCATE legacy_cc_payments, legacy_cc_payouts, legacy_cc_proposals RESTART IDENTITY');
      }
      await insertBatch(client, 'legacy_cc_payments', payments, [
        'cc_event_title', 'cc_type', 'paid_on', 'event_date', 'payment_applied_cents', 'tip_cents',
        'processing_fee_cents', 'net_cents', 'event_total_cents', 'taxable_cents', 'total_adjustment_cents',
        'tax_rate_pct', 'tax_collected_cents', 'payment_method', 'processor', 'receipt_number',
        'invoice_number', 'reference_code', 'paid_by', 'assigned_staff', 'public_notes', 'private_notes',
      ]);
      await insertBatch(client, 'legacy_cc_payouts', payouts, [
        'payee_name', 'payee_name_normalized', 'payee_user_id', 'paid_on', 'amount_cents', 'reference_role', 'category',
      ]);
      await insertBatch(client, 'legacy_cc_proposals', events, [
        'cc_id', 'status', 'client_id', 'client_email_normalized', 'client_name', 'event_date', 'event_type',
        'package_name', 'service_name', 'brand', 'venue_name', 'venue_full_address', 'estimated_guests',
        'source', 'lead_type', 'total_cost_cents', 'cc_created_at', 'booked_at', 'public_notes', 'private_notes',
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const { rows: after } = await pool.query(
      `SELECT (SELECT count(*)::int FROM legacy_cc_payments) pay,
              (SELECT sum(payment_applied_cents)::bigint FROM legacy_cc_payments) applied,
              (SELECT count(*)::int FROM legacy_cc_payouts) exp,
              (SELECT count(*)::int FROM legacy_cc_proposals) ev,
              (SELECT count(*)::int FROM legacy_cc_proposals WHERE booked_at IS NOT NULL) booked`
    );
    const a = after[0];
    console.log(`\nAPPLIED. Ledger now: payments=${a.pay} (applied cents ${a.applied}), payouts=${a.exp}, events=${a.ev} (booked ${a.booked}).`);
    const ok = a.pay === EXPECT.payments && Number(a.applied) === EXPECT.paymentsAppliedCents
      && a.exp === EXPECT.expenses && a.ev === EXPECT.events && a.booked === EXPECT.booked;
    console.log(ok ? 'Post-apply verification: PASS' : 'Post-apply verification: FAIL — investigate before trusting the ledger');
    if (!ok) process.exit(1);
  } finally {
    await pool.end();
  }
}

module.exports = {
  decodeExport, parseCents, parsePct, firstIsoDate, parseTimestamp, normalizeStatus,
  normalizeName, normalizeEmail, firstEmail, intOrNull,
  buildPayments, buildPayouts, buildEvents, verify, insertBatch, EXPECT, STATUS_MAP,
};

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
