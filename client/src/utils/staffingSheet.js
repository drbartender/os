// Pure staffing logic for the phone staffing card and the assignment sheet
// (spec 2026-08-13-mobile-admin section 4 Detail, benchmark 2026-09-15). No
// React, no fetch. It rides on staffingRoles.js, the same module the desktop
// ShiftDrawer classifies with, so a request is "waitlisted" on the phone
// exactly when it is on the desktop.
//
// THE MONEY SEAM. roleStep decides which `position` an approve or an assign
// may send, and `position` keys payroll's tip split. Its law: the role that is
// written is always a role the screen showed before the tap. It never
// defaults and never infers. defaultAssignRole (the desktop picker's
// preselect) is deliberately NOT imported here.
import {
  parsePositionsNeeded, rosterCounts, classifyRequest, canonicalizeRole,
} from './staffingRoles';
import { roleFill, isCancelledEvent } from '../components/adminos/shifts';

export const READ_ONLY_NOTE = {
  cancelled: 'Cancelled · roster is read-only',
  past: 'Past event · roster is read-only',
  rosterless: 'No roles are declared on this shift. Staff it from desktop view.',
};

export function initialsOf(name) {
  const letters = String(name || '').trim().split(/\s+/).filter(Boolean).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  return letters || '?';
}

// A number, or a string that reads as one. Number() alone turns ' ', true,
// false and [] into 0 or 1, and the line would print a made-up "0 mi".
const known = (v) => (typeof v === 'number'
  ? Number.isFinite(v)
  : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));

// "14 events · 7 mi". Seniority and distance are facts Dallas decides on,
// shown as plain meta and never used to order anything. Either may be unknown
// (a person or a venue with no coordinates): an unknown fact is omitted, never
// rendered as a zero.
//
// WHOLE miles, always. The picker's distances arrive whole from the server
// (server/utils/staffingMeta.js), because these reads are stored on the phone
// and a tenth of a mile to ten venues places a home to the block. An
// applicant's distance arrives to the tenth, as the desktop shows it; the
// phone rounds it so every row reads alike.
export function staffMeta({ eventsWorked, miles } = {}) {
  const parts = [];
  if (known(eventsWorked)) {
    const n = Number(eventsWorked);
    parts.push(`${n} ${n === 1 ? 'event' : 'events'}`);
  }
  if (known(miles)) {
    // Under half a mile rounds to 0, which reads like a missing number (Dallas,
    // 2026-09-30). "<1 mi" says no more than "0 mi" did.
    const whole = Math.round(Number(miles));
    parts.push(whole < 1 ? '<1 mi' : `${whole} mi`);
  }
  return parts.join(' · ');
}

// GET /shifts/detail/:id returns request rows (id, staff_name); GET
// /shifts/by-proposal/:id returns requesters (request_id, name). One shape in.
export function normalizeRequest(raw) {
  const r = raw || {};
  const position = canonicalizeRole(r.position);
  return {
    requestId: r.request_id ?? r.id,
    userId: r.user_id,
    name: r.name || r.staff_name || r.staff_email || 'Staff member',
    status: r.status,
    position,
    // Role text on the row that is not a role this app knows. The row still
    // committed to SOMETHING, so it is never read as "Any role".
    strayRole: position ? null : (String(r.position ?? '').trim() || null),
    dropped: !!r.dropped_at,
    rankedRoles: [...new Set(parsePositionsNeeded(r.requested_positions))],
    miles: r.home_distance_miles ?? null,
    eventsWorked: r.events_worked ?? null,
    // Set on a cover claim: the request id of the teammate being covered.
    // Both reads carry it (GET /shifts/detail/:id and the by-proposal
    // requesters), so the card and the sheet read one claim the same way.
    coverFor: r.replaced_by_request_id ?? null,
  };
}

export function buildShiftView(shift, rawRequests, { justAssigned = [] } = {}) {
  const s = shift || {};
  const roster = parsePositionsNeeded(s.positions_needed);
  const rosterless = roster.length === 0;
  const needed = rosterCounts(roster);
  const roleOrder = Object.keys(needed);
  const requests = (Array.isArray(rawRequests) ? rawRequests : []).map(normalizeRequest);

  // `dropped` is load-bearing: an emergency drop leaves status 'approved' and
  // sets dropped_at, so a bare status check would count someone who already
  // bailed as filling their slot. Every server aggregate pairs the two.
  const approved = requests.filter((r) => r.status === 'approved' && !r.dropped);
  const pending = requests.filter((r) => r.status === 'pending');

  // An approval with no role on file (none in prod as of 2026-09-29, but the
  // column is nullable) still occupies a slot. Left uncounted, the phone would
  // show a filled slot as open and offer it again, which is an over-fill.
  // roleFill gives it the first role with room, in roster order. (The desktop's
  // remainingByRole gives a legacy row to the first roster role whether or not
  // it has room; this errs toward fewer open slots, the safe direction.) The
  // phone Events list counts with the same roleFill, so the two agree.
  const named = {};
  let roleless = 0;
  for (const r of approved) {
    if (r.position) named[r.position] = (named[r.position] || 0) + 1;
    else roleless += 1;
  }
  const { slots, open, filled, remaining, approvedByRole } = roleFill(roster, named, roleless);
  const openRoles = roleOrder
    .map((role) => ({ role, open: Math.max(0, remaining[role] || 0) }))
    .filter((r) => r.open > 0);

  const cancelled = isCancelledEvent({ status: s.status, proposal_status: s.proposal_status });
  const closedReason = cancelled ? 'cancelled' : (s.finished ? 'past' : null);

  const byName = (a, b) => a.name.localeCompare(b.name);
  const fresh = new Set((Array.isArray(justAssigned) ? justAssigned : []).map(Number));
  const nameOf = new Map(requests.map((r) => [Number(r.requestId), r.name]));
  const rostered = approved.slice().sort(byName).map((r) => ({
    ...r,
    key: `r${r.requestId}`,
    kind: 'rostered',
    initials: initialsOf(r.name),
    resolvableRole: null,
    meta: [r.position || 'Staff', fresh.has(Number(r.userId)) ? 'just assigned' : null].filter(Boolean).join(' · '),
  }));
  const asked = pending.map((r) => {
    // What this person asked for.
    //   A cover claim asked for the role written on it: claim-cover writes the
    //   claimer's own role and leaves any ranked list from an older request in
    //   place (staffShiftActions.js), so the role is the newer statement.
    //   Otherwise a ranked list wins.
    //   With no ranked list, a role on the row IS the request. An ordinary
    //   request nulls the role every time (/shifts/:id/request), so text there
    //   means someone committed to it, even text this app cannot read as a
    //   role: that row waits and picks, it is never "Any role".
    //   Only a row with neither asked for "Any role".
    // Reading a committed Barback as "Any role" would let one tap write them
    // into the Bartender tip split. The server's auto-assign draws the same
    // line (server/utils/autoAssign.js).
    const own = r.position || r.strayRole;
    const listed = r.rankedRoles.length ? r.rankedRoles : (own ? [own] : []);
    const wanted = r.coverFor !== null && own ? [own] : listed;
    const c = classifyRequest(wanted, remaining);
    // A role on the row AND a ranked list that resolves to a different role:
    // the row says two things. It is a cover claim whose link was cleared
    // (removing the covered teammate nulls replaced_by_request_id), or a row
    // an admin reset to pending, and the data cannot tell which. Such a row
    // never takes one tap: it picks. (A row with a role and NO ranked list
    // resolves to that role or to none, and one that resolves to none waits.)
    const unsure = !!own && c.resolvableRole !== own;
    const ranked = wanted.length ? wanted.join(' › ') : 'Any role';
    const covering = r.coverFor === null ? null : `Covering ${nameOf.get(Number(r.coverFor)) || 'a teammate'}`;
    return {
      ...r,
      key: `r${r.requestId}`,
      kind: c.state === 'actionable' ? 'applicant' : 'waitlisted',
      initials: initialsOf(r.name),
      resolvableRole: c.resolvableRole,
      unsure,
      meta: [covering, ranked, staffMeta(r)].filter(Boolean).join(' · '),
    };
  });
  const applicants = asked.filter((r) => r.kind === 'applicant');
  const waitlisted = asked.filter((r) => r.kind === 'waitlisted');

  const pills = Array.from({ length: slots }, (_, i) => {
    if (i < filled) return 'filled';
    if (i < filled + applicants.length) return 'pending';
    return 'open';
  });

  return {
    shiftId: s.id ?? null,
    rosterless,
    closedReason,
    slots,
    filled,
    open,
    full: open === 0,
    count: `${filled}/${slots}`,
    openRoles,
    openLabel: openRoles.map((r) => `${r.role} × ${r.open}`).join(' · '),
    mix: roleOrder.map((role) => `${role} ${Math.min(needed[role], approvedByRole[role] || 0)}/${needed[role]}`).join(' · '),
    rolesLabel: rosterless ? 'Staff' : roleOrder.map((role) => `${role}s`).join(' + '),
    pills,
    rows: [...rostered, ...applicants, ...waitlisted],
  };
}

// What an Approve or an Assign tap must do for this row.
//   blocked: no open role, or the roster is read-only. Over-filling is a
//            deliberate desktop action; the phone never does it.
//   direct:  an applicant whose row says one thing, exactly one role open, and
//            it is the role their own
//            ranking resolves to. Approve is already the second tap (row, then
//            Approve), and the open role is named in the sheet head.
//   pick:    everything else shows one tap-row per open role. A waitlisted
//            applicant always picks (the open role is one they did not ask
//            for). A candidate always picks: an assignment texts and emails a
//            real person, so a single stray tap on a list row must never be
//            enough to fire it.
export function roleStep(view, row) {
  if (!view || view.closedReason || view.openRoles.length === 0) return { kind: 'blocked' };
  if (row && row.kind === 'applicant' && !row.unsure && view.openRoles.length === 1
      && row.resolvableRole === view.openRoles[0].role) {
    return { kind: 'direct', role: row.resolvableRole };
  }
  return { kind: 'pick', roles: view.openRoles };
}

// The picker: active staff not already on this shift, alphabetical. Search
// narrows by name. No ranking, no scoring, no auto-assign.
export function candidatesOf(staff, view, query) {
  const taken = new Set(((view && view.rows) || []).map((r) => Number(r.userId)));
  const q = String(query || '').trim().toLowerCase();
  return (Array.isArray(staff) ? staff : [])
    .map((s) => ({
      userId: s.id,
      name: s.display_name || s.preferred_name || s.email || 'Staff member',
      miles: s.home_distance_miles ?? null,
      eventsWorked: s.events_worked ?? null,
    }))
    .filter((c) => !taken.has(Number(c.userId)))
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({
      key: `c${c.userId}`,
      kind: 'candidate',
      userId: c.userId,
      name: c.name,
      initials: initialsOf(c.name),
      meta: staffMeta(c),
    }));
}

// Remove is a hard DELETE of the request: payroll re-accrues on a completed
// event and the Out-of-Area lock releases (server/routes/shifts.js, DELETE
// /requests/:requestId). It sends nothing to the person removed. Deny closes
// the request and notifies NOBODY (shifts.approval.js sends only on approval).
// Both confirms say so: left off one of them, the silence read as the opposite.
export function confirmCopy(kind, name) {
  if (kind === 'remove') {
    return {
      copy: `Remove ${name} from this shift? Payroll re-accrues and any out-of-area lock is released. They are not notified.`,
      label: 'Remove',
    };
  }
  if (kind === 'deny') {
    return {
      copy: `Deny ${name}’s application? The request closes. They are not notified.`,
      label: 'Deny',
    };
  }
  // A kind this function does not know must never borrow another kind's words.
  throw new Error(`confirmCopy: unknown kind "${kind}"`);
}
