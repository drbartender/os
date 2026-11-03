'use strict';

// Read-only audit: which payment profiles hold a masked display value ('****' plus the last four) where an encrypted bank number belongs.
//
//   node -r dotenv/config server/scripts/findMaskedBankNumbers.js
//
// Before the bank-mask guard (utils/bankNumbers.js, 2026-11-03), the admin profile
// save and POST /api/payment encrypted whatever came back from a form seeded with
// the masked value, so a staffer's real routing or account number could be replaced
// by '****1234' with every screen still showing the same last four. Only code that
// holds the production ENCRYPTION_KEY can tell a stored mask from a stored number,
// so this runs where that key lives (a Render shell on the API service).
//
// It also counts stored numbers that are neither a mask nor in a valid format
// (a routing number failing the ABA checksum, an account number that is not 4 to
// 17 digits): those were stored before any format check, they are kept as they
// are on every save, and a payout may not go through with them.
//
// Prints counts and user ids only, never a bank number, masked or not. Writes
// nothing. Exits 0 when no row is affected, 1 when one is, 2 on an error.
// A row it cannot decrypt is counted on its own line, not as affected.

require('dotenv').config();
const { pool } = require('../db');
const { decrypt } = require('../utils/encryption');
const { isMaskedBankValue, isValidRoutingNumber, isValidAccountNumber } = require('../utils/bankNumbers');

const VALID = { routing_number: isValidRoutingNumber, account_number: isValidAccountNumber };

async function main() {
  const { rows } = await pool.query(
    `SELECT user_id, routing_number, account_number
       FROM payment_profiles
      WHERE routing_number IS NOT NULL OR account_number IS NOT NULL
      ORDER BY user_id`
  );

  const masked = { routing_number: [], account_number: [] };
  const invalid = { routing_number: [], account_number: [] };
  const undecryptable = { routing_number: [], account_number: [] };
  for (const row of rows) {
    for (const col of ['routing_number', 'account_number']) {
      if (!row[col]) continue;
      let plain;
      try {
        plain = decrypt(row[col]);
      } catch {
        undecryptable[col].push(row.user_id);
        continue;
      }
      const text = String(plain);
      if (isMaskedBankValue(text) || text.includes('*')) masked[col].push(row.user_id);
      else if (!VALID[col](text)) invalid[col].push(row.user_id);
    }
  }

  const ids = (list) => (list.length ? ` (user ids: ${list.join(', ')})` : '');
  console.log(`payment profiles with a bank number on file: ${rows.length}`);
  console.log(`masked routing number stored: ${masked.routing_number.length}${ids(masked.routing_number)}`);
  console.log(`masked account number stored: ${masked.account_number.length}${ids(masked.account_number)}`);
  console.log(`routing number not in a valid format: ${invalid.routing_number.length}${ids(invalid.routing_number)}`);
  console.log(`account number not in a valid format: ${invalid.account_number.length}${ids(invalid.account_number)}`);
  console.log(`could not decrypt, routing: ${undecryptable.routing_number.length}${ids(undecryptable.routing_number)}`);
  console.log(`could not decrypt, account: ${undecryptable.account_number.length}${ids(undecryptable.account_number)}`);

  const affected = masked.routing_number.length + masked.account_number.length
    + invalid.routing_number.length + invalid.account_number.length;
  return affected > 0 ? 1 : 0;
}

main()
  .then(async (code) => { await pool.end(); process.exit(code); })
  .catch(async (err) => {
    console.error('findMaskedBankNumbers failed:', err && err.message);
    try { await pool.end(); } catch (endErr) { console.error('closing the pool also failed:', endErr && endErr.message); }
    process.exit(2);
  });
