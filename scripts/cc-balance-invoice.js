'use strict';

// One-time operator script: mint the remaining Check Cherry balance invoices.
//
//   node -r dotenv/config scripts/cc-balance-invoice.js               # DRY RUN (default, no writes)
//   node -r dotenv/config scripts/cc-balance-invoice.js --only 597    # DRY RUN, one proposal
//   node -r dotenv/config scripts/cc-balance-invoice.js --only 597 --apply
//
// Nothing is emailed, ever. Dallas writes the client email himself; this only
// makes the invoice exist and be payable.
//
// generateLineItemsFromProposal is override-blind: it always itemizes from
// catalog, so for a CC contract it renders a correct total over line items that
// do not match it. Rather than teach that generator about a retired pricing
// model, this script mints the shape by hand, the one INV-0193 (Jack Van Dyke)
// ended up with:
//
//   label 'Balance'  - a real CONTRACT_LABELS member, so refundHelpers does not
//                      classify a later refund as extra-scope and refuse to
//                      shrink total_price.
//   status 'sent'    - the draft-pay trap: the public invoice page RENDERS a
//                      draft, so the link looks fine, but create-intent-for-
//                      invoice requires sent/partially_paid and the client hits
//                      "This invoice is no longer available" at pay time.
//   locked = true    - refreshUnlockedInvoices rebuilds an UNLOCKED invoice's
//                      line items from the snapshot on any admin save, which
//                      would replace the itemization below with catalog lines.
//   line items summing exactly to amount_due, deposit shown as a credit.
//
// Delete this script once Check Cherry is cancelled (2026-07-21).

const { pool } = require('../server/db');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx !== -1 ? parseInt(args[onlyIdx + 1], 10) : null;

// `--only` with a missing or malformed value parses to NaN, which is falsy, so
// the id filter below would silently vanish and --apply would mint EVERY
// eligible proposal instead of the one asked for. Fail loudly instead.
if (onlyIdx !== -1 && !(Number.isInteger(ONLY) && ONLY > 0)) {
  console.error(`--only requires a positive integer proposal id (got: ${args[onlyIdx + 1] ?? '<missing>'})`);
  process.exit(1);
}

const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : 'n/a');

async function main() {
  const { rows } = await pool.query(
    `SELECT p.id, c.name AS client_name, p.event_date, p.balance_due_date,
            p.total_price, p.total_price_override, p.amount_paid,
            sp.name AS package_name, p.event_duration_hours, p.guest_count,
            (SELECT COUNT(*)::int FROM invoices i
              WHERE i.proposal_id = p.id AND i.status <> 'void') AS live_invoices,
            (SELECT COUNT(*)::int FROM proposal_addons pa
              WHERE pa.proposal_id = p.id) AS addon_rows
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.transferred_from_cc_id IS NOT NULL
        AND p.status = 'confirmed'
        ${ONLY ? 'AND p.id = $1' : ''}
      ORDER BY p.balance_due_date NULLS LAST, p.id`,
    ONLY ? [ONLY] : []
  );

  if (rows.length === 0) {
    console.log('No transferred, confirmed proposals matched.');
    return;
  }

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${rows.length} candidate(s)\n`);
  let minted = 0;
  let skipped = 0;

  for (const r of rows) {
    const totalCents = Math.round(Number(r.total_price) * 100);
    const paidCents = Math.round(Number(r.amount_paid) * 100);
    const dueCents = totalCents - paidCents;
    const label = `#${r.id} ${r.client_name} (${ymd(r.event_date)})`;

    // Every SKIP is a case a human must look at, never a silent pass.
    if (r.live_invoices > 0) { console.log(`SKIP ${label}: already has a non-void invoice`); skipped++; continue; }
    if (dueCents <= 0) { console.log(`SKIP ${label}: nothing owed (${usd(dueCents)})`); skipped++; continue; }
    if (r.total_price_override === null) {
      console.log(`SKIP ${label}: no contract override, use the normal invoice flow`); skipped++; continue;
    }
    // total_price above the contract means drink-plan extras were folded in.
    // The single contract line below would silently bury them, so refuse.
    const contractCents = Math.round(Number(r.total_price_override) * 100);
    if (contractCents !== totalCents) {
      console.log(`SKIP ${label}: total ${usd(totalCents)} != contract ${usd(contractCents)}, extras folded in — handle by hand`);
      skipped++; continue;
    }
    if (r.addon_rows > 0) {
      console.log(`SKIP ${label}: has ${r.addon_rows} add-on row(s) — handle by hand`); skipped++; continue;
    }

    const lines = [
      {
        desc: `${r.package_name} (${Number(r.event_duration_hours)} hrs, ${r.guest_count} guests)`,
        cents: totalCents,
        src: 'package',
      },
    ];
    if (paidCents > 0) lines.push({ desc: 'Less deposit already paid', cents: -paidCents, src: 'manual' });

    const sum = lines.reduce((s, l) => s + l.cents, 0);
    if (sum !== dueCents) {
      console.log(`SKIP ${label}: lines ${usd(sum)} != amount due ${usd(dueCents)}`); skipped++; continue;
    }

    console.log(`${APPLY ? 'MINT' : 'WOULD MINT'} ${label}`);
    for (const l of lines) console.log(`    ${l.desc.padEnd(48)} ${usd(l.cents).padStart(12)}`);
    console.log(`    ${'AMOUNT DUE'.padEnd(48)} ${usd(dueCents).padStart(12)}   due ${ymd(r.balance_due_date)}`);

    if (!APPLY) { console.log(''); continue; }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inv = (await client.query(
        `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, status, due_date, locked, locked_at)
         SELECT $1, 'INV-' || lpad(nextval('invoice_number_seq')::text, 4, '0'), 'Balance', $2, 'sent', $3, true, NOW()
          WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE proposal_id = $1 AND status <> 'void')
         RETURNING id, invoice_number, token`,
        [r.id, dueCents, r.balance_due_date]
      )).rows[0];

      if (!inv) {
        await client.query('ROLLBACK');
        console.log('    RACE: an invoice appeared, skipped\n');
        skipped++;
        continue;
      }

      for (const l of lines) {
        await client.query(
          `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, line_total, source_type, source_id)
           VALUES ($1, $2, 1, $3, $3, $4, NULL)`,
          [inv.id, l.desc, l.cents, l.src]
        );
      }
      await client.query('COMMIT');
      minted += 1;
      console.log(`    ${inv.invoice_number}  https://drbartender.com/invoice/${inv.token}\n`);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`    FAILED ${label}: ${e.message}\n`);
    } finally {
      client.release();
    }
  }

  console.log(
    APPLY
      ? `\nMinted ${minted} invoice(s), skipped ${skipped}. Nothing was emailed.`
      : `\nDry run: ${rows.length - skipped} would mint, ${skipped} skipped. Re-run with --apply to write.`
  );
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error(e); pool.end(); process.exit(1); });
