// Renders the offline staleness line (spec section 7). Device-local time by
// design: the line answers "how old is what I'm seeing", not a business
// timestamp, so the repo's Chicago-keyed convention does not apply here.
// Screen lanes render formatStaleAt(res.staleAt) inside the .m-stale element.
const TIME = { hour: 'numeric', minute: '2-digit' };
const DAY = { month: 'short', day: 'numeric' };

export function formatStaleAt(iso, now = new Date()) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('en-US', TIME);
  return sameDay
    ? `as of ${time}`
    : `as of ${d.toLocaleDateString('en-US', DAY)}, ${time}`;
}
