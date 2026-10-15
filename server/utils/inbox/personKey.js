'use strict';

// Person keys (spec 5.2): one Inbox item per person. A key is an IDENTITY,
// never an address. Replies go to the number the person last texted from
// (decision 29), so nothing ever rebuilds a phone number from a key.
//   c-<clients.id>      a client
//   s-<users.id>        a send-eligible staffer
//   p-<last 10 digits>  a number that is neither
//   t-<negotiation_id>  a Thumbtack thread whose lead has no client (a string)
//   e-<16 hex>          an email address that is neither: the first 16 hex of
//                       the SHA-256 of the lowercased address, so the key
//                       carries no address (spec 2026-10-14 section 5.2)
//   z-<zola_leads.id>   a Zola couple whose lead has no client

const NUMERIC_KEY_RE = /^(c|s|p)-(\d{1,20})$/;
const THUMBTACK_KEY_RE = /^t-([0-9A-Za-z_-]{1,100})$/;
const EMAIL_KEY_RE = /^e-([0-9a-f]{16})$/;
const ZOLA_KEY_RE = /^z-(\d{1,10})$/;
const CANONICAL_INT_RE = /^(0|[1-9]\d*)$/;
const MAX_INT = 2147483647;

// c-, s- and z- name INTEGER rows: one spelling per row (no leading zeros), so
// two keys can never alias one person, and nothing past int4 reaches SQL.
const isRowId = (id) => CANONICAL_INT_RE.test(id) && Number(id) <= MAX_INT;

function parsePersonKey(key) {
  if (typeof key !== 'string') return null;
  const n = NUMERIC_KEY_RE.exec(key);
  if (n) {
    const type = n[1];
    const id = n[2];
    if ((type === 'c' || type === 's') && !isRowId(id)) return null;
    return { type, id };
  }
  const t = THUMBTACK_KEY_RE.exec(key);
  if (t) return { type: 't', id: t[1] };
  const e = EMAIL_KEY_RE.exec(key);
  if (e) return { type: 'e', id: e[1] };
  const z = ZOLA_KEY_RE.exec(key);
  return z && isRowId(z[1]) ? { type: 'z', id: z[1] } : null;
}

function personKey(type, id) {
  if (id === null || id === undefined) return null;
  const key = `${type}-${String(id)}`;
  return parsePersonKey(key) ? key : null;
}

module.exports = { parsePersonKey, personKey };
