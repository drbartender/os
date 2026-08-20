// A tip's Status on the cross-staff ledger, derived from the row ALONE. There
// is no tip -> payout key: a shift's tips pool across the event's bartenders,
// and a late tip lands in today's period while keeping the original shift, so
// a per-tip "lands in" period cannot be made truthful from event_date (spec
// §3 override). First match wins, in this order.
import { fmt$fromCents } from '../../../components/adminos/format';

const mmmd = (v) => new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });

export function netCents(t) {
  return Math.max(0, Number(t.amount_cents || 0) - Number(t.refunded_amount_cents || 0));
}

export function tipStatus(t) {
  if (t.dispute_won_at) return { label: 'dispute won', kind: 'warn' };
  if (Number(t.refunded_amount_cents) > 0) return { label: `refunded ${fmt$fromCents(Number(t.refunded_amount_cents))}`, kind: 'warn' };
  if (t.deferred_at) return { label: 'deferred, waiting for an open period', kind: 'violet' };
  if (!t.shift_id) return { label: 'unassigned', kind: 'danger', hint: 'see the repair queue above' };
  if (t.rolled_forward_at) return { label: `rolled forward ${mmmd(t.rolled_forward_at)}`, kind: 'info' };
  return { label: `on the ${mmmd(t.tipped_at)} event`, kind: 'ok' };
}
