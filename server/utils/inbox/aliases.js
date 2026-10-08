'use strict';

// Moved person keys (spec 5.2, amendment 22), PURE. A key names a person as
// the index resolved them when the tap was made, and that can change: an
// unknown number becomes a client, a Thumbtack lead gains one, a staffer
// leaves the send-eligible set. Before the rules run, every action and seen
// mark stored under a key that moved is folded onto the person's current key,
// in this order (database review, 2026-10-08); rules 2 and 4 ask the people
// index the way the item route's resolveKey (engine.js) does:
//   1. a key that still has events stays exactly where it is, so a live item
//      keeps its own Done, Snooze and Claim;
//   2. a p- key asks the live people index, at the tap's time, and moves when
//      the index names someone else (an unknown number became a client);
//   3. only then an event alias: the p- key of a phone whose SMS events all
//      name ONE person (a phone on two people's texts never aliases);
//   4. an s- key of a staffer who is no longer send-eligible follows their
//      profile phone to the key the index names, when that key has events;
//   5. a t- key follows its lead to the client the lead now belongs to.
// Reads need nothing here: the rules match a read by subject_ref alone,
// whatever person_key it was written under.

const { last10 } = require('../phone');
const { parsePersonKey, personKey } = require('./personKey');

// p-<last 10> of a phone -> its person's key, only for a phone whose SMS
// events all belong to one person. A phone on two people's texts (a number
// that changed hands, a shared phone, a reused Thumbtack proxy number) names
// no one, whatever order the events come in.
function eventAliases(events) {
  const owners = new Map();
  for (const e of events || []) {
    if (!e || !e.meta || e.meta.source !== 'sms' || !e.meta.phone) continue;
    const alias = personKey('p', last10(e.meta.phone));
    if (!alias) continue;
    const keys = owners.get(alias) || new Set();
    keys.add(e.personKey);
    owners.set(alias, keys);
  }
  const aliases = new Map();
  for (const [alias, keys] of owners) {
    const [only] = keys;
    if (keys.size === 1 && only !== alias) aliases.set(alias, only);
  }
  return aliases;
}

// The key a stored key names today, in the header's order. eventKeys is the
// set of person keys that have events.
function currentKeyOf(key, { index, aliases, at, eventKeys = new Set() }) {
  if (eventKeys.has(key)) return key;
  const k = parsePersonKey(key);
  if (!k) return key;
  if (k.type === 'p') {
    const now = index.resolvePhone(k.id, at);
    if (now && now !== key) return now;
    return aliases.get(key) || key;
  }
  if (k.type === 's') {
    if (index.staffEligible.has(Number(k.id))) return key;
    const phone = index.profilePhones.get(Number(k.id));
    const now = phone ? index.resolvePhone(last10(phone), at) : null;
    return now && now !== key && eventKeys.has(now) ? now : key;
  }
  if (k.type === 't') {
    const lead = index.leadsByNegotiation.get(k.id);
    return lead && lead.client_id ? `c-${Number(lead.client_id)}` : key;
  }
  return key;
}

function foldTaps({ actions = [], seen = [], events = [], index }) {
  const eventKeys = new Set();
  for (const e of events || []) if (e && e.personKey) eventKeys.add(e.personKey);
  const aliases = eventAliases(events);
  const keyAt = (key, at) => currentKeyOf(key, { index, aliases, at: new Date(at), eventKeys });
  const folded = actions.map((a) => {
    const key = keyAt(a.person_key, a.created_at);
    return key === a.person_key ? a : { ...a, person_key: key };
  });
  const newest = new Map();
  for (const s of seen) {
    const key = keyAt(s.person_key, s.seen_at);
    const prev = newest.get(key);
    if (!prev || new Date(s.seen_at) > new Date(prev.seen_at)) newest.set(key, { ...s, person_key: key });
  }
  return { actions: folded, seen: [...newest.values()] };
}

module.exports = { foldTaps, currentKeyOf, eventAliases };
