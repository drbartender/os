'use strict';

// Person keys (spec 5.2): one Inbox item per person. A key is an IDENTITY,
// never an address. Replies go to the number the person last texted from
// (decision 29), so nothing ever rebuilds a phone number from a key.
//   c-<clients.id>      a client
//   s-<users.id>        a send-eligible staffer
//   p-<last 10 digits>  a number that is neither
//   t-<negotiation_id>  a Thumbtack thread whose lead has no client (a string)

const NUMERIC_KEY_RE = /^(c|s|p)-(\d{1,20})$/;
const THUMBTACK_KEY_RE = /^t-([0-9A-Za-z_-]{1,100})$/;
const CANONICAL_INT_RE = /^(0|[1-9]\d*)$/;
const MAX_INT = 2147483647;

function parsePersonKey(key) {
  if (typeof key !== 'string') return null;
  const n = NUMERIC_KEY_RE.exec(key);
  if (n) {
    const type = n[1];
    const id = n[2];
    // c- and s- name INTEGER rows: one spelling per row (no leading zeros), so
    // two keys can never alias one person, and nothing past int4 reaches SQL.
    if ((type === 'c' || type === 's') && (!CANONICAL_INT_RE.test(id) || Number(id) > MAX_INT)) return null;
    return { type, id };
  }
  const t = THUMBTACK_KEY_RE.exec(key);
  return t ? { type: 't', id: t[1] } : null;
}

function personKey(type, id) {
  if (id === null || id === undefined) return null;
  const key = `${type}-${String(id)}`;
  return parsePersonKey(key) ? key : null;
}

module.exports = { parsePersonKey, personKey };
