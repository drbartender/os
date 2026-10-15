'use strict';

// Personal mail (spec 2026-10-14 decision 6, as the owner decided it on
// 2026-10-15): each mail is judged ON ITS OWN, ONCE, by the sync, when it is
// stored, and the answer is stored on the row (gmail_messages.personal and
// personal_to). Nothing later changes it: a sender who becomes a client, a
// staffer or a marketing lead, or who writes to the business mailbox, never
// moves a stored personal mail to business, and never a business mail to
// personal. gmailSync.storeMessage calls judgePersonal inside the message's
// own transaction, through its connection.
//   inbound  (not a Zola notice, not a bounce) is personal when its sender was
//            nobody we knew when it arrived (no client, staffer, operator or
//            marketing lead whose record existed at the mail's `at`) and its
//            To and Cc name none of the business's addresses: either they hold
//            the owner alias alone among ours, or they name none of ours at
//            all (we were Bcc'd, a list, a forward), since an unclear shape
//            stays private. The business addresses are index.businessEmails:
//            the mailbox, the no-reply address FROM_EMAIL sends from,
//            ADMIN_EMAIL, the INBOX_OWN_EMAILS list and every admin's and
//            manager's own address but the owner's (an operator in copy is
//            business: the sender copied our team; the owner's own account
//            is not the team), never the alias.
//   Sent     ANSWERING decides first, whichever of our addresses it went
//            from. A Sent mail that answers an inbound (In-Reply-To, else the
//            newest inbound in its Gmail thread before it, the readers' rule;
//            never a forward) takes that inbound's side: it answers a
//            personal inbound, and it is personal for that inbound's sender
//            and for each recipient nobody knew when it was sent; it answers
//            a business inbound, and it is business, so the business item
//            gets its reply and can close. Only a mail that answers nothing
//            (a fresh send, or a forward) reads its From: from the owner
//            alias it is personal for each recipient nobody knew; from
//            anywhere else it is business. A client or staffer copied on it
//            keeps the business event either way. personal_to lists the
//            recipients it is personal for; personal is true when that list
//            holds anyone.
// Addresses compare trimmed and lowercased, as people.resolveEmail does; a
// +tag is cut only when asking whether an address is one of ours. One lookup
// (SQL.knownAt) answers who was known, and only for a mail that could be
// personal. A database error rejects the judgment, so the store fails with it
// (gmailSync's isDbOutage decides whose fault): a mail whose judgment could
// not run is never stored as business.

const { PERSONAL_ALIAS, ZOLA_RELAY_DOMAIN } = require('./constants');
const { untagged } = require('./people');
const rules = require('./gmailRules');

const SQL = Object.freeze({
  // The addresses (already lowercased) that named someone we knew at $2: a
  // client, a marketing lead, an admin or manager, or a send-eligible staffer
  // (people.PEOPLE_STAFF_SQL's set: role staff or manager, onboarding
  // submitted, reviewed or approved, a profile and an agreement; a manager is
  // known as an operator already), each by a record that existed then. Each
  // address comparison is lower(btrim(email)), the exact expression of
  // idx_clients_email_norm, idx_email_leads_email_norm and idx_users_email_norm. A record with no created_at is a legacy row from before any mail
  // the sync stores, so it counts as known. The staffer's onboarding status
  // is today's: no history of it is kept.
  knownAt: `SELECT a.address
              FROM unnest($1::text[]) AS a(address)
             WHERE EXISTS (SELECT 1 FROM clients c
                            WHERE lower(btrim(c.email)) = a.address AND COALESCE(c.created_at, '-infinity') <= $2)
                OR EXISTS (SELECT 1 FROM email_leads l
                            WHERE lower(btrim(l.email)) = a.address AND COALESCE(l.created_at, '-infinity') <= $2)
                OR EXISTS (SELECT 1 FROM users u
                            WHERE lower(btrim(u.email)) = a.address AND COALESCE(u.created_at, '-infinity') <= $2
                              AND (u.role IN ('admin', 'manager')
                                   OR (u.role = 'staff' AND u.onboarding_status IN ('submitted', 'reviewed', 'approved')
                                       AND EXISTS (SELECT 1 FROM contractor_profiles cp
                                                    WHERE cp.user_id = u.id AND COALESCE(cp.created_at, '-infinity') <= $2)
                                       AND EXISTS (SELECT 1 FROM agreements ag
                                                    WHERE ag.user_id = u.id AND COALESCE(ag.created_at, '-infinity') <= $2))))`,
  // The stored inbound a Sent mail answers, as readGmail.sentPeople finds it:
  // the one its In-Reply-To names (the lowest id, dated at or before the
  // reply, so a later mail reusing the Message-ID never takes it over), else
  // the newest in its thread at or before it. Human mail only (kind message,
  // no Zola lead).
  answeredInbound: `(SELECT 1 AS pick, personal, from_address FROM gmail_messages
                      WHERE message_id_header = $1 AND at <= $3 AND direction = 'in' AND kind = 'message' AND zola_lead_id IS NULL
                      ORDER BY id LIMIT 1)
                    UNION ALL
                    (SELECT 2 AS pick, personal, from_address FROM gmail_messages
                      WHERE thread_id = $2 AND at <= $3 AND direction = 'in' AND kind = 'message' AND zola_lead_id IS NULL
                      ORDER BY at DESC, id DESC LIMIT 1)
                    ORDER BY pick LIMIT 1`,
});

const lower = (a) => String(a || '').trim().toLowerCase();
const isOneOf = (address, set) => set.has(lower(address)) || set.has(untagged(address));
const setOf = (value) => (value instanceof Set ? value : new Set());
// readGmail's forward test (its subject starts Fwd: or Fw:), which answers no one.
const isForward = (subject) => /^\s*fwd?\s*:/i.test(String(subject || ''));
const isZolaRelay = (address) => lower(address).endsWith(`@${ZOLA_RELAY_DOMAIN}`);
const NOT_PERSONAL = Object.freeze({ personal: false, personalTo: null });
// Only human mail and auto-replies are judged: a Zola notice is a lead's, and
// a bounce sits with the Sent mail it names (readGmail).
const JUDGED_KINDS = new Set(['message', 'auto_reply']);

async function knownAt(db, addresses, at) {
  const { rows } = await db.query(SQL.knownAt, [addresses, at]);
  return new Set(rows.map((r) => r.address));
}

async function judgeInbound(db, m, index) {
  const toCc = rules.recipientsOf(m.headers, ['to', 'cc']);
  // The two private shapes (the owner alias alone among ours, or none of ours
  // at all) are one test: no business address in To or Cc.
  if (toCc.some((a) => isOneOf(a, setOf(index && index.businessEmails)))) return NOT_PERSONAL;
  const from = lower(m.fromAddress);
  if (!from) return NOT_PERSONAL;
  const known = await knownAt(db, [from], m.at);
  return { personal: !known.has(from), personalTo: null };
}

async function judgeSent(db, m, index) {
  let answered = null;
  if (!isForward(m.subject)) {
    const { rows } = await db.query(SQL.answeredInbound, [m.inReplyTo || null, m.threadId, m.at]);
    answered = rows[0] || null;
  }
  // Answering decides first: a reply to a business inbound is business, from
  // the owner alias too. Only a mail that answers nothing reads its From.
  const answersPersonal = Boolean(answered && answered.personal);
  if (answered && !answersPersonal) return NOT_PERSONAL;
  if (!answered && untagged(m.fromAddress) !== PERSONAL_ALIAS) return NOT_PERSONAL;
  const own = setOf(index && index.ownEmails);
  const people = [...new Set((m.recipients || []).map(lower))].filter((a) => a && !isOneOf(a, own) && !isZolaRelay(a));
  if (!people.length) return NOT_PERSONAL;
  const known = await knownAt(db, people, m.at);
  const asker = answersPersonal ? lower(answered.from_address) : null;
  const personalTo = people.filter((a) => a === asker || !known.has(a));
  return personalTo.length ? { personal: true, personalTo } : NOT_PERSONAL;
}

/**
 * The personal judgment for one parsed message (gmailRules.parseMessage) the
 * sync is about to store under `verdict`: { personal, personalTo }, where
 * personalTo (a Sent mail's recipients it is personal for) is null when
 * empty. db is the message's own transaction connection.
 */
function judgePersonal(db, m, verdict, index) {
  if (!verdict || !JUDGED_KINDS.has(verdict.kind)) return Promise.resolve(NOT_PERSONAL);
  return m.direction === 'out' ? judgeSent(db, m, index) : judgeInbound(db, m, index);
}

module.exports = { SQL, judgePersonal };
