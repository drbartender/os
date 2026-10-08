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

const { pool } = require('../../db');
const { last10 } = require('../phone');
const smsLines = require('../smsLines');
const { personKey } = require('./personKey');
const { THUMBTACK_PROXY_ROLLOUT } = require('./constants');

// presenceStore.js:12, verbatim.
const NAME_SQL = "COALESCE(cp.display_name, cp.preferred_name, INITCAP(SPLIT_PART(u.email, '@', 1)))";

const PEOPLE_CLIENTS_SQL = 'SELECT id, name, phone, created_at FROM clients';
const PEOPLE_STAFF_SQL = `
  SELECT u.id, u.role, cp.phone, cp.updated_at, ${NAME_SQL} AS name
    FROM users u
    JOIN contractor_profiles cp ON cp.user_id = u.id
    JOIN agreements ag ON ag.user_id = u.id
   WHERE u.role IN ('staff', 'manager')
     AND u.onboarding_status IN ('submitted', 'reviewed', 'approved')`;
const PEOPLE_OPERATORS_SQL = `
  SELECT u.id, u.role, cp.phone, u.presence_nudge_phone, ${NAME_SQL} AS name
    FROM users u
    LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
   WHERE u.role IN ('admin', 'manager')`;
const PEOPLE_PROFILE_PHONES_SQL = 'SELECT user_id, phone FROM contractor_profiles WHERE phone IS NOT NULL';
const PEOPLE_LEADS_SQL = `
  SELECT id, negotiation_id, client_id, customer_name, customer_phone, created_at, first_reply_sent_at,
         event_date, location_city, location_state
    FROM thumbtack_leads`;

const ms = (d) => new Date(d).getTime();
const newestFirst = (a, b) => (ms(b.created_at) - ms(a.created_at)) || (Number(b.id) - Number(a.id));

function buildPeopleIndex({ clients = [], staff = [], operators = [], profilePhones = [], leads = [], env = process.env } = {}) {
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
  const staffByPhone = new Map();
  for (const s of [...staff].sort((a, b) => (ms(b.updated_at) - ms(a.updated_at)) || (Number(b.id) - Number(a.id)))) {
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
  };
}

async function loadPeopleIndex(db = pool, env = process.env) {
  const [clients, staff, operators, profilePhones, leads] = await Promise.all([
    db.query(PEOPLE_CLIENTS_SQL),
    db.query(PEOPLE_STAFF_SQL),
    db.query(PEOPLE_OPERATORS_SQL),
    db.query(PEOPLE_PROFILE_PHONES_SQL),
    db.query(PEOPLE_LEADS_SQL),
  ]);
  return buildPeopleIndex({
    clients: clients.rows, staff: staff.rows, operators: operators.rows,
    profilePhones: profilePhones.rows, leads: leads.rows, env,
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
  buildPeopleIndex, loadPeopleIndex, latestPhoneOf,
  PEOPLE_CLIENTS_SQL, PEOPLE_STAFF_SQL, PEOPLE_OPERATORS_SQL, PEOPLE_PROFILE_PHONES_SQL, PEOPLE_LEADS_SQL,
};
