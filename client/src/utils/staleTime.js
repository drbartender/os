// Renders the offline staleness line (spec section 7). Device-local time by
// design: the line answers "how old is what I'm seeing", not a business
// timestamp, so the repo's Chicago-keyed convention does not apply here.
// Screen lanes render formatStaleTime(res.staleAt) inside the .m-stale element.
const TIME = { hour: 'numeric', minute: '2-digit' };
const DAY = { month: 'short', day: 'numeric' };

// The whole label in one string, for a caller that does not render the two
// states itself. A thin wrapper over formatStaleTime on purpose: two copies of
// the same-day rule is how the label and the time drift apart.
export function formatStaleAt(iso, now = new Date()) {
  const t = formatStaleTime(iso, now);
  return t ? `as of ${t}` : null;
}

// The time alone, for the offline line the phone screens draw over a
// cache-served copy ("offline copy · as of"; a live screen shows no line,
// Dallas 2026-09-30). The screen renders the label and only the time sits in
// .m-stale-time. Today shows the time alone; anything older carries the day.
export function formatStaleTime(iso, now = new Date()) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('en-US', TIME);
  return sameDay ? time : `${d.toLocaleDateString('en-US', DAY)}, ${time}`;
}
