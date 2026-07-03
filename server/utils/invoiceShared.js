// Invoice shared internals: cents conversion + db/pool fallback. Extracted verbatim from invoiceHelpers.js.

/**
 * Invoice Helper Utilities — shared internals
 *
 * All money handled here is INTEGER CENTS for invoice tables.
 * Proposal/addon tables use NUMERIC dollars — convert with toCents().
 *
 * The `dbClient` parameter on every function accepts either:
 *   - A transaction client from pool.connect() (preferred inside transactions)
 *   - Omitted / falsy → falls back to the shared pool for standalone use
 */

'use strict';

const { pool } = require('../db');

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Convert a NUMERIC dollar value (string or number) to integer cents. */
function toCents(dollars) {
  return Math.round(Number(dollars) * 100);
}

/** Return the db client to use (transaction client or pool fallback). */
function db(dbClient) {
  return dbClient || pool;
}

module.exports = {
  toCents,
  db,
};
