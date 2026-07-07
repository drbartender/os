#!/usr/bin/env node
/**
 * One-time CheckCherry CLIENT import (2026-07-06 reboot of the retired v1 importer).
 *
 * Scope is deliberately tiny: clients only. No proposals, no events, no
 * payments, no comms, none of the v1 phase machinery. Reads two fresh CC
 * exports and upserts client rows:
 *
 *   --contacts "<path>/report (5).csv"   CC contacts export (identity + paid aggregates)
 *   --events   "<path>/report.csv"       CC events export (confirmed events -> digest/venues)
 *   --apply                              actually write; default is a dry run that prints the plan
 *
 * Import rule: a CC contact comes over only if they actually gave us business,
 * i.e. Customer role AND (paid > $0 OR their email appears on a Confirmed
 * event). Quoted-but-never-booked contacts stay in the raw export archive.
 *
 * Upsert rules:
 *   - new email        -> INSERT (name, email, phone, source='checkcherry', notes=digest, cc_id)
 *   - existing email   -> fill blanks only (phone), set cc_id, append digest to notes;
 *                         native name/source/notes are never overwritten
 *   - cc_id already set -> skip (idempotent re-run)
 *
 * Run order for prod: deploy first (schema.sql adds 'checkcherry' to the
 * clients.source CHECK via initDb), then run this with prod DATABASE_URL.
 *
 * Usage:
 *   node -r dotenv/config scripts/cc-clients-import.js \
 *     --contacts ~/cc-archive/2026-07-06/"report (5).csv" \
 *     --events   ~/cc-archive/2026-07-06/report.csv [--apply]
 */

const fs = require('fs');
const { parse } = require('csv-parse/sync');

// ── pure helpers (exported for tests) ─────────────────────────────

/** CC exports arrive in mixed encodings (utf-8 and windows-1252 seen 2026-07-06). */
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

/** "$1,850" / "$-385" -> 1850 / -385 (whole dollars, float-safe for display math only). */
function parseMoney(raw) {
  const s = String(raw ?? '').replace(/[$,]/g, '').trim();
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
}

/** Lowercased/trimmed email or null (mirrors the retired v1 lib convention, plus an @ sanity guard). */
function normalizeEmail(raw) {
  if (raw == null) return null;
  const lower = String(raw).trim().toLowerCase();
  if (!lower || !lower.includes('@') || lower === 'n/a' || lower === 'none' || lower.startsWith('noemail@')) return null;
  return lower;
}

/** All emails on an event row ("Contact Email(s)" + "User Email(s)", comma/semicolon lists). */
function eventEmails(row) {
  const raw = `${row['Contact Email(s)'] || ''},${row['User Email(s)'] || ''}`;
  return new Set(
    raw.split(/[,;]/).map(normalizeEmail).filter((e) => e && e.includes('@'))
  );
}

/** "06-13-2026, 06-14-2026" -> latest ISO date "2026-06-14"; null if unparseable. */
function latestIsoDate(raw) {
  const found = [...String(raw || '').matchAll(/(\d{2})-(\d{2})-(\d{4})/g)]
    .map((m) => `${m[3]}-${m[1]}-${m[2]}`);
  return found.length ? found.sort().at(-1) : null;
}

function collapseWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Decide who comes over and with what row values.
 * Returns { imports: [{ccId, name, email, phone, notes}], orphanConfirmedEmails: [..] }.
 */
function buildImportPlan(contacts, events) {
  const confirmed = events.filter((r) => (r.Status || '').trim() === 'Confirmed');
  const confirmedByEmail = new Map();
  for (const ev of confirmed) {
    for (const email of eventEmails(ev)) {
      if (!confirmedByEmail.has(email)) confirmedByEmail.set(email, []);
      confirmedByEmail.get(email).push(ev);
    }
  }

  const contactByEmail = new Map();
  for (const c of contacts) {
    const email = normalizeEmail(c.Email);
    if (email) contactByEmail.set(email, c);
  }

  const imports = [];
  for (const [email, contact] of contactByEmail) {
    if (!(contact.Roles || '').includes('Customer')) continue;
    const paid = parseMoney(contact['Customer Events: Total Amount Paid']);
    const confirmedEvents = confirmedByEmail.get(email) || [];
    if (paid <= 0 && confirmedEvents.length === 0) continue;

    imports.push({
      ccId: String(contact.ID || '').trim() || null,
      name: collapseWhitespace(contact.Name || contact['Full Name']) || email,
      email,
      phone: collapseWhitespace(contact.Phone) || null,
      notes: buildDigest(paid, confirmedEvents),
    });
  }

  // A duplicate CC contact ID would trip the unique cc_id index mid-apply and
  // roll back the whole batch; fail loudly up front instead.
  const ccIds = imports.map((r) => r.ccId).filter(Boolean);
  const dupCcIds = ccIds.filter((id, i) => ccIds.indexOf(id) !== i);
  if (dupCcIds.length) throw new Error(`duplicate CC contact IDs in import set: ${[...new Set(dupCcIds)].join(', ')}`);

  const orphanConfirmedEmails = [...confirmedByEmail.keys()].filter((e) => !contactByEmail.has(e));
  imports.sort((a, b) => a.email.localeCompare(b.email));
  return { imports, orphanConfirmedEmails };
}

/**
 * One neutral history line for the client notes field. Era-based, no vendor
 * branding on purpose (provenance lives in cc_id + source, not in prose).
 * e.g. "Past events: 3 (last 10-2026). Venues: Victory Gardens Theater. Lifetime paid: $1,850."
 */
function buildDigest(paid, confirmedEvents) {
  const parts = [];
  if (confirmedEvents.length > 0) {
    const lastIso = confirmedEvents.map((ev) => latestIsoDate(ev['Event Date'])).filter(Boolean).sort().at(-1);
    const last = lastIso ? ` (last ${lastIso.slice(5, 7)}-${lastIso.slice(0, 4)})` : '';
    parts.push(`Past events: ${confirmedEvents.length}${last}.`);
    const venues = [...new Set(confirmedEvents.map((ev) => collapseWhitespace(ev['Venue Name'])).filter(Boolean))];
    if (venues.length) parts.push(`Venues: ${venues.slice(0, 3).join('; ')}.`);
  } else {
    parts.push('Past client.');
  }
  if (paid > 0) parts.push(`Lifetime paid: $${paid.toLocaleString('en-US')}.`);
  return parts.join(' ');
}

// ── db plumbing (not exercised by unit tests) ──────────────────────

async function run() {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const contactsPath = getArg('--contacts');
  const eventsPath = getArg('--events');
  const apply = args.includes('--apply');
  if (!contactsPath || !eventsPath) {
    console.error('Usage: cc-clients-import.js --contacts <report (5).csv> --events <report.csv> [--apply]');
    process.exit(1);
  }

  const { imports, orphanConfirmedEmails } = buildImportPlan(loadCsv(contactsPath), loadCsv(eventsPath));

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const plan = { insert: [], merge: [], skip: [] };
  try {
    for (const row of imports) {
      const { rows } = await pool.query(
        'SELECT id, name, phone, notes, cc_id FROM clients WHERE lower(email) = $1',
        [row.email]
      );
      const existing = rows[0];
      if (!existing) plan.insert.push(row);
      else if (existing.cc_id != null) plan.skip.push({ ...row, clientId: existing.id });
      else plan.merge.push({ ...row, clientId: existing.id, existing });
    }

    console.log(`Import set: ${imports.length} CC clients`);
    console.log(`  INSERT new:            ${plan.insert.length}`);
    console.log(`  MERGE into existing:   ${plan.merge.length}${plan.merge.length ? '  (' + plan.merge.map((m) => m.email).join(', ') + ')' : ''}`);
    console.log(`  SKIP (already imported): ${plan.skip.length}`);
    if (orphanConfirmedEmails.length) {
      console.log(`  NOT IMPORTED - confirmed-event emails with no CC contact row: ${orphanConfirmedEmails.join(', ')}`);
    }
    console.log('\nSample rows:');
    for (const row of plan.insert.slice(0, 5)) {
      console.log(`  + ${row.email} | ${row.name} | ${row.phone || 'no phone'} | ${row.notes}`);
    }

    if (!apply) {
      console.log('\nDRY RUN - nothing written. Re-run with --apply to execute.');
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of plan.insert) {
        await client.query(
          `INSERT INTO clients (name, email, phone, source, notes, cc_id)
           VALUES ($1, $2, $3, 'checkcherry', $4, $5)`,
          [row.name, row.email, row.phone, row.notes, row.ccId]
        );
      }
      for (const row of plan.merge) {
        await client.query(
          `UPDATE clients
              SET phone = COALESCE(NULLIF(phone, ''), $2),
                  notes = CASE WHEN COALESCE(notes, '') = '' THEN $3
                               ELSE notes || E'\\n\\n' || $3 END,
                  cc_id = $4
            WHERE id = $1`,
          [row.clientId, row.phone, row.notes, row.ccId]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const { rows: after } = await pool.query(
      "SELECT count(*)::int AS n FROM clients WHERE source = 'checkcherry' OR cc_id IS NOT NULL"
    );
    console.log(`\nAPPLIED. Clients now carrying CC provenance: ${after[0].n} (expected ${plan.insert.length + plan.merge.length + plan.skip.length}).`);
  } finally {
    await pool.end();
  }
}

module.exports = { decodeExport, parseMoney, normalizeEmail, eventEmails, latestIsoDate, buildImportPlan, buildDigest, collapseWhitespace };

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
