const { validatePhone } = require('./phone');

/**
 * Find-or-create a client, de-duplicating on BOTH email and phone.
 *
 * Matching order: email (lower, via idx_clients_email_lower) first, then
 * normalized phone (last 10 digits, via idx_clients_phone_normalized) — but the
 * phone match only fires against a row whose email is still NULL AND whose name
 * matches (anti-takeover guard, mirrors calcom.js), so a shared phone can't
 * merge two different people. On a match we BACKFILL NULL fields only (e.g.
 * stamp the email onto a phone-only Thumbtack row); we NEVER overwrite an
 * existing non-null name/email/phone, which keeps this safe for the
 * UNAUTHENTICATED public wizard.
 *
 * Runs inside the caller's transaction — pass the caller's pg client.
 *
 * @param {import('pg').PoolClient} db
 * @param {{name:string,email?:string|null,phone?:string|null,source?:string,notes?:string|null}} args
 * @returns {Promise<number>} clients.id
 */
async function findOrCreateClient(db, { name, email, phone, source = 'direct', notes = null }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('findOrCreateClient: name is required');
  const cleanEmail = email && String(email).trim() ? String(email).trim().toLowerCase() : null;
  const { value: phone10 } = validatePhone(phone); // 10-digit string or null

  let winnerId = null;

  if (cleanEmail) {
    const r = await db.query('SELECT id FROM clients WHERE LOWER(email) = $1 LIMIT 1', [cleanEmail]);
    if (r.rows[0]) winnerId = r.rows[0].id;
  }

  if (!winnerId && phone10) {
    const r = await db.query(
      `SELECT id FROM clients
         WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1
           AND email IS NULL
           AND LOWER(name) = LOWER($2)
         ORDER BY created_at DESC
         LIMIT 1`,
      [phone10, cleanName]
    );
    if (r.rows[0]) winnerId = r.rows[0].id;
  }

  if (winnerId) {
    // Backfill NULLs only — never overwrite. This is the Jim fix: a phone-only
    // Thumbtack row gets the email stamped on, so the later proposal-create
    // resolves to it instead of inserting a second row.
    await db.query(
      `UPDATE clients SET email = COALESCE(email, $2), phone = COALESCE(phone, $3) WHERE id = $1`,
      [winnerId, cleanEmail, phone || null]
    );
    return winnerId;
  }

  // No match -> insert with 23505 race recovery (mirrors calcom.js).
  await db.query('SAVEPOINT foc_insert');
  try {
    const created = await db.query(
      `INSERT INTO clients (name, email, phone, source, notes) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [cleanName, cleanEmail, phone || null, source, notes]
    );
    await db.query('RELEASE SAVEPOINT foc_insert');
    return created.rows[0].id;
  } catch (err) {
    if (err.code === '23505' && cleanEmail) {
      await db.query('ROLLBACK TO SAVEPOINT foc_insert');
      const re = await db.query('SELECT id FROM clients WHERE LOWER(email) = $1 LIMIT 1', [cleanEmail]);
      if (re.rows[0]) return re.rows[0].id;
    }
    try { await db.query('ROLLBACK TO SAVEPOINT foc_insert'); } catch (_) { /* already rolled back */ }
    throw err;
  }
}

module.exports = { findOrCreateClient };
