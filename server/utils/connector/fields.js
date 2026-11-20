'use strict';

// The Claude connector's field lists (spec 2026-11-19 law 2): every tool result is built from the named fields here, never from a row passed through.
//
// Each tool builds its rows explicitly and then runs them through shape(),
// which keeps only the keys its list names, so a column a shared read adds
// later (the reads return whole rows, link tokens included) can never reach
// Claude by accident. NEVER_KEYS is the never-list: a key on it in any list
// is a load-time error, and assertSafe() refuses a result that carries one
// anywhere (the last check before a result leaves, failing closed).
//
// Dates: a Postgres DATE arrives from node-pg as a Date at LOCAL midnight, so
// ymd() reads it back by its local parts (calendar only, no time zone math);
// a timestamp goes out as ISO.

// Spec law 2's never-list, by key name: link tokens, banking, tax ids,
// password hashes, token_version, Stripe secrets and ids, staff home
// addresses, signatures and the client portal's sign-in token.
const NEVER_KEYS = Object.freeze([
  'token', 'proposal_token', 'drink_plan_token', 'auth_token', 'auth_token_expires_at', 'token_version',
  'password_hash', 'routing_number', 'account_number', 'tax_id', 'ssn', 'ein',
  'stripe_customer_id', 'stripe_payment_method_id', 'stripe_secret', 'client_secret',
  'street_address', 'zip_code', 'home_address', 'lat', 'lng',
  'client_signature_data', 'client_signature_ip', 'client_signature_user_agent',
  'adjustments_token', 'menu_print_key', 'link',
]);

const FIELDS = Object.freeze({
  // Waiting on you
  waiting: ['generated_at', 'waiting', 'waiting_count', 'shown', 'has_more', 'snoozed_count', 'handled_recently_count'],
  waiting_row: ['person_key', 'name', 'kind', 'client_written_need', 'waiting_since', 'hot', 'channels', 'claimed_by', 'menu_tasks_only'],
  // Upcoming events
  events: ['window_start', 'window_end', 'days', 'days_cut_to', 'shifts', 'events_shown', 'has_more'],
  event_row: [
    'shift_id', 'proposal_id', 'event_date', 'start_time', 'end_time', 'place', 'client_name', 'event_type',
    'guest_count', 'shift_status', 'needed_by_role', 'confirmed_by_role', 'confirmed_count', 'open_slots', 'short_staffed',
  ],
  // Money owed
  money: ['bookings', 'shown', 'total', 'has_more', 'amounts_in'],
  money_row: [
    'proposal_id', 'client_id', 'client_name', 'event_type', 'event_date', 'status', 'amount_owed',
    'balance_due_date', 'days_past_due', 'due_state', 'autopay_enrolled',
  ],
  // Search
  search: ['query_length', 'clients', 'proposals', 'events', 'staff', 'group_limit'],
  search_client: ['client_id', 'name'],
  search_booking: ['proposal_id', 'client_name', 'event_type', 'event_date', 'status'],
  search_staff: ['user_id', 'name', 'status'],
  // Client
  client: [
    'client_id', 'name', 'email', 'phone', 'email_status', 'phone_status', 'source', 'client_written_notes',
    'created_at', 'proposals', 'proposals_shown', 'proposals_total', 'amounts_in',
  ],
  client_proposal: ['proposal_id', 'status', 'event_date', 'event_type', 'package', 'total_price', 'amount_paid'],
  // Proposal or event
  proposal: [
    'proposal_id', 'client_id', 'client_name', 'status', 'booked', 'event_type', 'event_date', 'event_start_time',
    'event_duration_hours', 'client_written_location', 'venue_name', 'venue_city', 'venue_state', 'guest_count',
    'num_bars', 'num_bartenders', 'package', 'add_ons', 'price_lines', 'price_lines_total', 'total_price',
    'amount_paid', 'deposit_amount', 'balance_due_date', 'payment_type', 'autopay_enrolled', 'accepted_at',
    'client_written_notes', 'staffing', 'drink_plan', 'recent_activity', 'amounts_in',
  ],
  proposal_addon: ['name', 'billing_type', 'quantity', 'quantity_unit', 'rate', 'line_total'],
  price_line: ['label', 'amount', 'hidden_from_client'],
  staffing_row: ['shift_id', 'event_date', 'start_time', 'end_time', 'shift_status', 'needed_by_role', 'confirmed_by_role', 'confirmed_count', 'open_slots', 'short_staffed'],
  drink_plan: ['drink_plan_id', 'status', 'serving_type', 'submitted_at', 'finalized_at', 'shopping_list_status'],
  activity_row: ['action', 'by', 'at'],
  // Thread
  thread: ['person_key', 'name', 'kind', 'client_id', 'status', 'waiting', 'waiting_since', 'client_written_need', 'messages', 'shown', 'has_more'],
  thread_message: [
    'ref', 'from', 'channel', 'at', 'client_written_subject', 'client_written_text', 'business_subject', 'business_text',
    'client_written_note', 'author', 'attachments', 'media_count', 'failed',
  ],
});

for (const [name, keys] of Object.entries(FIELDS)) {
  const bad = keys.filter((k) => NEVER_KEYS.includes(k));
  if (bad.length) throw new Error(`connector fields: ${name} names a never-listed key (${bad.join(', ')})`);
}

/**
 * The object with only the keys FIELDS[name] lists, in that order; a listed
 * key the object lacks is left out (never invented).
 */
function shape(name, obj) {
  const keys = FIELDS[name];
  if (!keys) throw new Error(`connector fields: no field list named ${name}`);
  const out = {};
  for (const k of keys) if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Throws when any key anywhere in the value is on the never-list. */
function assertSafe(value, path = 'result') {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSafe(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (NEVER_KEYS.includes(k)) throw new Error(`connector fields: ${path}.${k} is on the never-list`);
      assertSafe(v, `${path}.${k}`);
    }
  }
}

// The largest id a Postgres integer column holds, the ceiling of every id a tool takes.
const PG_INT_MAX = 0x7fffffff;

/** A calendar day as YYYY-MM-DD from a pg DATE (a local-midnight Date) or a YYYY-MM-DD string; null otherwise. */
function ymd(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const p = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
  }
  return null;
}

/** A timestamp as ISO, or null. */
function iso(value) {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = { FIELDS, NEVER_KEYS, PG_INT_MAX, shape, assertSafe, ymd, iso };
