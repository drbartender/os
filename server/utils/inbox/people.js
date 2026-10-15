'use strict';

// The people index (spec 5.2): who a phone number is, decided at READ time, so
// a text recorded before its sender became a client joins that client's item.
// Loaded once per engine snapshot; every resolver here is pure over it.
//   1. our own numbers never form an item: the three lines, ADMIN_PHONE,
//      VA_CELL, and every admin's and manager's contractor phone and presence
//      nudge phone (Dallas's staff account shares the 312, so ADMIN_PHONE
//      covers it);
//   2. clients by the last 10 digits, newest first (lookupSender's order);
//   3. the send-eligible staff set, the one the text route can reach (role
//      staff or manager, onboarding submitted/reviewed/approved, an agreement
//      on file), newest profile first. Applicants are not staff here;
//   4. a post-rollout Thumbtack proxy number, as the newest lead created before
//      the message (findThumbtackProxyLead's rule, narrowed by time);
//   5. anything else is p-<last 10 digits>.
// Email addresses (spec 2026-10-14 section 5.2), compared trimmed and
// lowercased, resolve the same way:
//   1. our own addresses never form an item: the mailbox, the personal alias,
//      the address FROM_EMAIL sends from, ADMIN_EMAIL, the INBOX_OWN_EMAILS
//      list, every admin's and manager's users.email, and Zola's vendor
//      address. Not the whole domain: a staffer's mailbox there is staff;
//   2. clients by clients.email, newest client first (the unique index is
//      case-sensitive, so two spellings of one address can coexist);
//   3. the send-eligible staff set by users.email, newest profile first;
//   4. anyone else is e-<the first 16 hex of the SHA-256 of the address>, so
//      the key never carries the address.
// A Zola couple is its lead's client when linked, else z-<zola_leads.id>.

const crypto = require('node:crypto');
const { pool } = require('../../db');
const { last10 } = require('../phone');
const smsLines = require('../smsLines');
const { FROM_EMAIL } = require('../email');
const { GMAIL_MAILBOX } = require('../gmailClient');
const { personKey } = require('./personKey');
const { THUMBTACK_PROXY_ROLLOUT, PERSONAL_ALIAS, PERSONAL_MAILBOX_OWNER_USER_ID, ZOLA_VENDOR_ADDRESS } = require('./constants');

// presenceStore.js:12, verbatim.
const NAME_SQL = "COALESCE(cp.display_name, cp.preferred_name, INITCAP(SPLIT_PART(u.email, '@', 1)))";

const PEOPLE_CLIENTS_SQL = 'SELECT id, name, phone, email, created_at FROM clients';
const PEOPLE_STAFF_SQL = `
  SELECT u.id, u.role, u.email, cp.phone, cp.updated_at, ${NAME_SQL} AS name
    FROM users u
    JOIN contractor_profiles cp ON cp.user_id = u.id
    JOIN agreements ag ON ag.user_id = u.id
   WHERE u.role IN ('staff', 'manager')
     AND u.onboarding_status IN ('submitted', 'reviewed', 'approved')`;
const PEOPLE_OPERATORS_SQL = `
  SELECT u.id, u.role, u.email, cp.phone, u.presence_nudge_phone, ${NAME_SQL} AS name
    FROM users u
    LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
   WHERE u.role IN ('admin', 'manager')`;
const PEOPLE_PROFILE_PHONES_SQL = 'SELECT user_id, phone FROM contractor_profiles WHERE phone IS NOT NULL';
const PEOPLE_LEADS_SQL = `
  SELECT id, negotiation_id, client_id, customer_name, customer_phone, created_at, first_reply_sent_at,
         event_date, location_city, location_state
    FROM thumbtack_leads`;
// wedding_date as 'YYYY-MM-DD': a calendar date, never a JS Date at midnight
// in whatever zone the server runs in.
const PEOPLE_ZOLA_LEADS_SQL = `
  SELECT id, lead_uuid, couple_label, to_char(wedding_date, 'YYYY-MM-DD') AS wedding_date, client_id, closed_at
    FROM zola_leads`;
// The marketing leads table is read for the name only (spec 5.2).
const PEOPLE_EMAIL_LEADS_SQL = 'SELECT id, name, email FROM email_leads';

const ms = (d) => new Date(d).getTime();
const newestFirst = (a, b) => (ms(b.created_at) - ms(a.created_at)) || (Number(b.id) - Number(a.id));
const newestProfileFirst = (a, b) => (ms(b.updated_at) - ms(a.updated_at)) || (Number(b.id) - Number(a.id));

const normEmail = (address) => String(address || '').trim().toLowerCase();
// The e- key's id. Unsalted (spec 5.2, accepted): it keeps the address out of
// URLs and Sentry, not out of reach of someone already holding the address.
const emailHash = (address) => crypto.createHash('sha256').update(normEmail(address)).digest('hex').slice(0, 16);
// A personal mail's person (spec 2026-10-14 decision 6, as decided
// 2026-10-15): its own e- key, apart from the business e- key of the same
// address. The hash input is 'PERSONAL:' and the normalized address, and
// emailHash only ever hashes a lowercased string, which never holds an ASCII
// uppercase letter: no address, stored or typed into a client row, hashes to
// a personal key, so keyByEmailHash can never hold one and a personal key
// never moves (aliases.js rule 6, engine.resolveKey). Null for no address.
function personalEmailKey(address) {
  const a = normEmail(address);
  if (!a) return null;
  return personKey('e', crypto.createHash('sha256').update(`PERSONAL:${a}`).digest('hex').slice(0, 16));
}
// The address normalized and without a +tag on its local part (dallas+x@ is
// dallas@), for asking whether an address is one of ours.
function untagged(address) {
  const a = normEmail(address);
  const at = a.lastIndexOf('@');
  return at <= 0 ? a : `${a.slice(0, at).split('+')[0]}${a.slice(at)}`;
}
// FROM_EMAIL is in display form, "Name <address>"; a bare address passes through.
function bareAddress(value) {
  const m = /<([^>]+)>/.exec(String(value || ''));
  return normEmail(m ? m[1] : value);
}

// Email identity, built from the same rows as the phone index (spec 5.2).
// mailboxEmails is the business's own mailboxes (the mailbox, its personal
// alias, the INBOX_OWN_EMAILS list), a subset of ownEmails: the Zola gate's
// "addressed to us" reads only these (gmailRules.addressedToUs), never an
// operator's own address, FROM_EMAIL or ADMIN_EMAIL (security re-review
// 2026-10-15). businessEmails is the addresses that make mail to the owner
// alias business when they are in To or Cc (personalMail.js): the mailbox,
// the INBOX_OWN_EMAILS list, the no-reply address FROM_EMAIL sends from (an
// alias of the mailbox), ADMIN_EMAIL, and every admin's and manager's own
// address but the owner's (the owner's call, 2026-10-15: the sender copied
// our team; the owner's own account, PERSONAL_MAILBOX_OWNER_USER_ID, is not
// the team, so a friend copying it keeps personal mail personal), never the
// personal alias itself and never Zola's address.
function buildEmailIndex({ clients, staffNewest, operators, zolaLeads, emailLeads, env }) {
  const ownEmails = new Set();
  const mailboxEmails = new Set();
  const businessEmails = new Set();
  const addOwn = (value, { mailbox = false, business = false } = {}) => {
    const a = bareAddress(value);
    if (!a) return;
    ownEmails.add(a);
    if (mailbox) mailboxEmails.add(a);
    if (business && untagged(a) !== PERSONAL_ALIAS) businessEmails.add(a);
  };
  addOwn(PERSONAL_ALIAS, { mailbox: true });
  [GMAIL_MAILBOX, ...String(env.INBOX_OWN_EMAILS || '').split(',')].forEach((a) => addOwn(a, { mailbox: true, business: true }));
  [FROM_EMAIL, env.ADMIN_EMAIL].forEach((a) => addOwn(a, { business: true }));
  addOwn(ZOLA_VENDOR_ADDRESS);
  for (const o of operators) addOwn(o.email, { business: Number(o.id) !== PERSONAL_MAILBOX_OWNER_USER_ID });

  const firstByAddress = (rows, idOf) => {
    const out = new Map();
    for (const r of rows) {
      const a = normEmail(r.email);
      if (a && !out.has(a)) out.set(a, idOf(r));
    }
    return out;
  };
  const clientsByEmail = firstByAddress([...clients].sort(newestFirst), (c) => Number(c.id));
  const staffByEmail = firstByAddress(staffNewest, (s) => Number(s.id));
  const leadNames = firstByAddress([...emailLeads].sort((a, b) => Number(b.id) - Number(a.id)), (l) => l.name);

  function resolveEmail(address) {
    const a = normEmail(address);
    if (!a || ownEmails.has(a)) return null;
    if (clientsByEmail.has(a)) return `c-${clientsByEmail.get(a)}`;
    if (staffByEmail.has(a)) return `s-${staffByEmail.get(a)}`;
    return personKey('e', emailHash(a));
  }
  // Every client and staff address's e- key, mapped to the person it names
  // now, so an e- key that only ever knew its hash can fold and move.
  const keyByEmailHash = new Map();
  for (const a of [...clientsByEmail.keys(), ...staffByEmail.keys()]) {
    const key = resolveEmail(a);
    if (key && !key.startsWith('e-')) keyByEmailHash.set(personKey('e', emailHash(a)), key);
  }
  const zolaLeadsById = new Map(zolaLeads.map((l) => [Number(l.id), l]));
  const zolaKey = (lead) => {
    if (!lead) return null;
    return lead.client_id ? `c-${Number(lead.client_id)}` : personKey('z', lead.id);
  };
  return {
    ownEmails, mailboxEmails, businessEmails, resolveEmail, emailHash, keyByEmailHash, zolaLeadsById, zolaKey,
    leadNameOf: (address) => leadNames.get(normEmail(address)) || null,
  };
}

function buildPeopleIndex({
  clients = [], staff = [], operators = [], profilePhones = [], leads = [], zolaLeads = [], emailLeads = [], env = process.env,
} = {}) {
  const own = new Set();
  const addOwn = (phone) => {
    const k = last10(phone);
    if (k) own.add(k);
  };
  for (const key of smsLines.LINE_KEYS) addOwn(smsLines.lineE164(key));
  addOwn(env.ADMIN_PHONE);
  addOwn(env.VA_CELL);
  for (const o of operators) {
    addOwn(o.phone);
    addOwn(o.presence_nudge_phone);
  }

  const clientsByPhone = new Map();
  for (const c of [...clients].sort(newestFirst)) {
    const k = last10(c.phone);
    if (k && !clientsByPhone.has(k)) clientsByPhone.set(k, Number(c.id));
  }
  const staffNewest = [...staff].sort(newestProfileFirst);
  const staffByPhone = new Map();
  for (const s of staffNewest) {
    const k = last10(s.phone);
    if (k && !staffByPhone.has(k)) staffByPhone.set(k, Number(s.id));
  }
  const latestLeadByClient = new Map();
  const proxyLeads = new Map();
  const rolloutMs = ms(THUMBTACK_PROXY_ROLLOUT);
  for (const l of [...leads].sort(newestFirst)) {
    if (l.client_id && !latestLeadByClient.has(Number(l.client_id))) latestLeadByClient.set(Number(l.client_id), l);
    const k = last10(l.customer_phone);
    if (!k || ms(l.created_at) < rolloutMs) continue;
    const list = proxyLeads.get(k) || [];
    list.push(l);
    proxyLeads.set(k, list);
  }

  const leadKey = (l) => (l.client_id ? `c-${Number(l.client_id)}` : personKey('t', l.negotiation_id));
  const leadForProxy = (k, at) => (proxyLeads.get(k) || []).find((l) => ms(l.created_at) <= ms(at)) || null;
  function resolvePhone(k, at) {
    if (!k || own.has(k)) return null;
    if (clientsByPhone.has(k)) return `c-${clientsByPhone.get(k)}`;
    if (staffByPhone.has(k)) return `s-${staffByPhone.get(k)}`;
    const lead = leadForProxy(k, at);
    if (lead && leadKey(lead)) return leadKey(lead);
    return personKey('p', k);
  }

  const staffMap = new Map(staff.map((s) => [Number(s.id), s]));
  return {
    own,
    clients: new Map(clients.map((c) => [Number(c.id), c])),
    staff: staffMap,
    staffEligible: new Set(staffMap.keys()),
    leadsByNegotiation: new Map(leads.map((l) => [String(l.negotiation_id), l])),
    latestLeadByClient,
    profilePhones: new Map(profilePhones.map((p) => [Number(p.user_id), p.phone])),
    users: operators.map((o) => ({ id: Number(o.id), name: o.name })),
    leadKey, leadForProxy, resolvePhone,
    isProxyPhone: (k) => Boolean(k && proxyLeads.has(k)),
    ...buildEmailIndex({ clients, staffNewest, operators, zolaLeads, emailLeads, env }),
  };
}

async function loadPeopleIndex(db = pool, env = process.env) {
  const [clients, staff, operators, profilePhones, leads, zolaLeads, emailLeads] = await Promise.all([
    db.query(PEOPLE_CLIENTS_SQL),
    db.query(PEOPLE_STAFF_SQL),
    db.query(PEOPLE_OPERATORS_SQL),
    db.query(PEOPLE_PROFILE_PHONES_SQL),
    db.query(PEOPLE_LEADS_SQL),
    db.query(PEOPLE_ZOLA_LEADS_SQL),
    db.query(PEOPLE_EMAIL_LEADS_SQL),
  ]);
  return buildPeopleIndex({
    clients: clients.rows, staff: staff.rows, operators: operators.rows,
    profilePhones: profilePhones.rows, leads: leads.rows, zolaLeads: zolaLeads.rows, emailLeads: emailLeads.rows, env,
  });
}

// The slice of the index the Gmail sync reads (gmailRules.classifyMessage
// asks ownEmails, mailboxEmails and resolveEmail, personalMail.js ownEmails
// and businessEmails, nothing else): clients with an address,
// the send-eligible staff and the operators, three reads instead of seven,
// built through buildEmailIndex so both answer exactly as the full index does.
const EMAIL_CLIENTS_SQL = 'SELECT id, email, created_at FROM clients WHERE email IS NOT NULL';

async function loadEmailIndex(db = pool, env = process.env) {
  const [clients, staff, operators] = await Promise.all([
    db.query(EMAIL_CLIENTS_SQL),
    db.query(PEOPLE_STAFF_SQL),
    db.query(PEOPLE_OPERATORS_SQL),
  ]);
  return buildEmailIndex({
    clients: clients.rows, staffNewest: [...staff.rows].sort(newestProfileFirst), operators: operators.rows,
    zolaLeads: [], emailLeads: [], env,
  });
}

// The other party's latest number on a person's SMS events, either direction.
function latestPhoneOf(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    // eslint-disable-next-line security/detect-object-injection -- i is this loop's own index into the array, never input
    const e = events[i];
    if (e.meta && e.meta.source === 'sms' && e.meta.phone && !e.meta.companionOf) return e.meta.phone;
  }
  return null;
}

module.exports = {
  buildPeopleIndex, loadPeopleIndex, loadEmailIndex, latestPhoneOf, emailHash, personalEmailKey, untagged,
  PEOPLE_CLIENTS_SQL, PEOPLE_STAFF_SQL, PEOPLE_OPERATORS_SQL, PEOPLE_PROFILE_PHONES_SQL, PEOPLE_LEADS_SQL,
  PEOPLE_ZOLA_LEADS_SQL, PEOPLE_EMAIL_LEADS_SQL, EMAIL_CLIENTS_SQL,
};
