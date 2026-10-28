// Find-or-create a client de-duped on email OR phone (name-guarded, backfill-only;
// trustedPhoneMatch for the Thumbtack webhook); the single intake find-or-create

const { validatePhone } = require('./phone');

/**
 * Find-or-create a client, de-duplicating on BOTH email and phone.
 *
 * Matching order: email (lower, via idx_clients_email_lower) first, then
 * normalized phone (last 10 digits, via idx_clients_phone_normalized) — but the
 * phone match only fires against a row whose email is still NULL (unless
 * `trustedPhoneMatch`, below) AND whose name matches (anti-takeover guard,
 * mirrors calcom.js), so a shared phone can't
 * merge two different people. An EMAIL match resolves the row AS-IS and stamps
 * nothing: on the UNAUTHENTICATED public wizard a submitter proves nothing
 * about an email, so an attacker-supplied phone must not backfill onto a
 * victim's email-matched row (it would redirect their BEO/payment SMS). A PHONE
 * match (already name-guarded) backfills ONLY the email onto the phone-only row
 * (the Thumbtack "stamp email on" case). We NEVER overwrite a non-null field.
 *
 * `trustedPhoneMatch` (default false) lets the phone + name match also resolve an
 * EMAIL-BEARING row whose source is 'thumbtack': one the webhook created, or a
 * client an admin entered as a Thumbtack customer (ProposalCreate defaults to
 * that source). It prefers the row that carries an email. No public form writes
 * that source (the wizard and SMS opt-in hard-code 'website'), so a stranger's
 * self-entered identity is never reachable this way. Only the Thumbtack webhook
 * passes it, and only on a request that passed its secret check (name + phone
 * come from the customer's Thumbtack account). Thumbtack never sends an email,
 * so without it a harvested repeat customer is re-created as a second,
 * email-less client. A trusted caller passes no email; a submitted email never
 * overwrites the matched row's email. The public wizard and every other caller
 * never pass it, so the guard above holds.
 *
 * Runs inside the caller's transaction — pass the caller's pg client.
 *
 * `created` distinguishes "this call inserted the row" from "this call resolved
 * an existing one". Callers on unauthenticated surfaces need that distinction:
 * resolving a stranger's row by email proves nothing about the submitter, so a
 * public form may write to a row it CREATED but must not mutate one it merely
 * matched. See recordSmsConsent in utils/smsConsent.js.
 *
 * @param {import('pg').PoolClient} db
 * @param {{name:string,email?:string|null,phone?:string|null,source?:string,notes?:string|null,trustedPhoneMatch?:boolean}} args
 * @returns {Promise<{id:number, created:boolean}>}
 */
async function findOrCreateClientDetailed(db, { name, email, phone, source = 'direct', notes = null, trustedPhoneMatch = false }) {
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
    if (r.rows[0]) return { id: r.rows[0].id, created: false };
  }

  if (phone10) {
    // Phone + name resolves an EMAIL-LESS row only (the anti-takeover guard: this
    // helper serves the unauthenticated public wizard, and a stranger who knows a
    // name + phone must not be handed a row that already has an identity). The
    // Thumbtack webhook passes trustedPhoneMatch on a verified request: the name +
    // phone come from Thumbtack's own customer account, and Thumbtack never sends
    // an email, so a harvested repeat customer was being re-created as a second
    // client (four times by 2026-10-14). Trusted, the match may also land on an
    // email-bearing row whose source is 'thumbtack' (the webhook's, or a client an
    // admin entered as a Thumbtack customer), never on a row a public form created
    // (those are 'website'), preferring the row that carries an email; the
    // tie-breakers keep the pick stable (created_at is nullable).
    const trusted = trustedPhoneMatch === true;
    const r = await db.query(
      `SELECT id FROM clients
         WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1
           AND LOWER(name) = LOWER($2)
           AND (email IS NULL OR ($3::boolean AND source = 'thumbtack'))
         ORDER BY (email IS NOT NULL) DESC, created_at DESC NULLS LAST, id DESC
         LIMIT 1`,
      [phone10, cleanName, trusted]
    );
    if (r.rows[0]) {
      winnerId = r.rows[0].id;
      // Matched by normalized phone AND name. Stamp the email on (the "Jim fix")
      // so a later proposal-create resolves to it. The phone is already this
      // row's match key; we backfill ONLY the email, never overwriting a
      // non-null value.
      if (cleanEmail) {
        await db.query('UPDATE clients SET email = COALESCE(email, $2) WHERE id = $1', [winnerId, cleanEmail]);
      }
      return { id: winnerId, created: false };
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
    return { id: created.rows[0].id, created: true };
  } catch (err) {
    if (err.code === '23505' && cleanEmail) {
      await db.query('ROLLBACK TO SAVEPOINT foc_insert');
      const re = await db.query('SELECT id FROM clients WHERE LOWER(email) = $1 LIMIT 1', [cleanEmail]);
      if (re.rows[0]) return { id: re.rows[0].id, created: false };
    }
    try { await db.query('ROLLBACK TO SAVEPOINT foc_insert'); } catch (_) { /* already rolled back */ }
    throw err;
  }
}

/**
 * Back-compat wrapper: the id alone, which is all most callers want.
 * @returns {Promise<number>} clients.id
 */
async function findOrCreateClient(db, args) {
  const { id } = await findOrCreateClientDetailed(db, args);
  return id;
}

module.exports = { findOrCreateClient, findOrCreateClientDetailed };
