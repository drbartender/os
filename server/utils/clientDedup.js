const { validatePhone } = require('./phone');

/**
 * Find-or-create a client, de-duplicating on BOTH email and phone.
 *
 * Matching order: email (lower, via idx_clients_email_lower) first, then
 * normalized phone (last 10 digits, via idx_clients_phone_normalized) — but the
 * phone match only fires against a row whose email is still NULL AND whose name
 * matches (anti-takeover guard, mirrors calcom.js), so a shared phone can't
 * merge two different people. An EMAIL match resolves the row AS-IS and stamps
 * nothing: on the UNAUTHENTICATED public wizard a submitter proves nothing
 * about an email, so an attacker-supplied phone must not backfill onto a
 * victim's email-matched row (it would redirect their BEO/payment SMS). A PHONE
 * match (already name-guarded) backfills ONLY the email onto the phone-only row
 * (the Thumbtack "stamp email on" case). We NEVER overwrite a non-null field.
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
    // Email match resolves the row AS-IS. Do NOT backfill the submitted phone:
    // this helper runs on the UNAUTHENTICATED public wizard, where a submitter
    // proves nothing about an email. Letting an attacker-supplied phone COALESCE
    // onto a victim's email-matched row would redirect their BEO/payment SMS.
    // Email is trusted only to RESOLVE the row, never to mutate it.
    if (r.rows[0]) return r.rows[0].id;
  }

  if (phone10) {
    const r = await db.query(
      `SELECT id FROM clients
         WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1
           AND email IS NULL
           AND LOWER(name) = LOWER($2)
         ORDER BY created_at DESC
         LIMIT 1`,
      [phone10, cleanName]
    );
    if (r.rows[0]) {
      winnerId = r.rows[0].id;
      // Phone-only row matched by normalized phone AND name (the anti-takeover
      // guard). Stamp the email on (the "Jim fix") so a later proposal-create
      // resolves to it. The phone is already this row's match key; we backfill
      // ONLY the email, never overwriting a non-null value.
      if (cleanEmail) {
        await db.query('UPDATE clients SET email = COALESCE(email, $2) WHERE id = $1', [winnerId, cleanEmail]);
      }
      return winnerId;
    }
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
