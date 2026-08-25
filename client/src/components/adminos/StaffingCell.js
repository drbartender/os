import React from 'react';
import StatusChip from './StatusChip';
import StaffHoverCard from './StaffHoverCard';
import { approvedCount } from './shifts';
import { parsePositionsNeeded } from '../../utils/staffingRoles';
import { dayDiff } from './format';

// Staffing summary for one events-list row.
//
// The shortfall is driven by CONFIRMED headcount alone. A pending applicant
// never occupies a slot: the previous pill model let one silently cancel the
// "N open" warning, so a fully unstaffed event with two applicants rendered
// calmer than a half-staffed one.
//
// Pending applicants surface here only when an open slot remains: those are
// `N requests`, someone waiting on an approve/deny. Surplus applicants on a
// FULL roster are a waitlist, informational rather than actionable, and this is
// the list staffing actually gets worked from, so the waitlist is not shown at
// all. A full roster says one thing, the green ratio, and the waitlist count
// still lives on the overview and on the event itself.
//
// There are TWO hover cards, and the waitlist rule lives in `showChip`, not in
// either card: the ratio's card lists who is confirmed, the chip's card lists
// who applied, and the chip only renders when a slot is open. So a full roster
// still shows no applicants, by never constructing the anchor that would carry
// them. The confirmed card never carries applicants either way.
export function deriveStaffing(e) {
  const needed = parsePositionsNeeded(e?.positions_needed).length;
  const confirmed = approvedCount(e);
  const pending = Math.max(0, Number(e?.pending_count || 0));
  const open = Math.max(0, needed - confirmed);

  // A finished or cancelled event is history, not a task, so it never shows
  // red and never advertises requests to action.
  const past = dayDiff(e?.event_date ? String(e.event_date).slice(0, 10) : null) < 0;
  const inactive = past || e?.status === 'cancelled' || e?.status === 'completed';

  return { needed, confirmed, pending, open, inactive };
}

// The confirmed people behind the ratio, from the admin feed's approved_staff
// aggregate (server/routes/shifts.js GET /). pg parses the json column and
// axios decodes the body, so it is an array or it is nothing; no string
// parsing, because there is no path that delivers one.
export function approvedStaffList(e) {
  return Array.isArray(e?.approved_staff) ? e.approved_staff : [];
}

// The applicants behind the requests chip, from the feed's pending_staff
// aggregate. Same contract and same reasoning as approvedStaffList.
export function pendingStaffList(e) {
  return Array.isArray(e?.pending_staff) ? e.pending_staff : [];
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function StaffingCell({ event }) {
  const { needed, confirmed, pending, open, inactive } = deriveStaffing(event);

  let line;
  if (needed === 0) {
    // Legacy/manual row with no canonical roster. There is no denominator, so
    // no ratio and no shortfall can be stated.
    line = <span className="staffing-none">No roster</span>;
  } else if (open > 0) {
    // The ratio itself carries the alarm on a live shortfall: the numbers are
    // what the eye lands on when scanning the column, so a muted ratio beside a
    // coloured "N open" buried the count that matters. `staffing-short` is
    // withheld on inactive rows rather than being fought in CSS, so history
    // keeps its muted treatment.
    line = (
      <span className={`staffing-ratio${inactive ? '' : ' staffing-short'}`}>
        {confirmed}/{needed}
        {' · '}
        {/* "open" is an adjective here, so it never takes a plural s. */}
        <span className={inactive ? 'staffing-open-muted' : 'staffing-open'}>{open} open</span>
      </span>
    );
  } else {
    line = <span className="staffing-full">{confirmed}/{needed}</span>;
  }

  // Without a roster we cannot tell a waitlist from an open-slot applicant, so
  // those rows keep the chip and stay labelled as requests rather than being
  // miscalled a waitlist. (The old cell reported nothing at all for these rows.)
  const actionable = open > 0 || needed === 0;

  const showChip = pending > 0 && actionable && !inactive;

  return (
    // gap: 0 is LOAD-BEARING, not tidying. `vstack` supplies gap: 0.5rem, and the
    // inline gap: 4 this replaces was overriding it DOWN. Dropping the inline
    // style without this would widen the dead zone between the two hover targets
    // to 8.5px. The 4px of spacing now lives in .staffing-cell > * + * padding,
    // which belongs to the second target's hit area instead of to nobody.
    <div className={`vstack staffing-cell${inactive ? ' staffing-inactive' : ''}`} style={{ gap: 0, alignItems: 'flex-start' }}>
      {/* Two anchors, deliberately adjacent. The ratio answers "who is on this
          event", the chip answers "who wants on it". They are separate cards by
          decision (Dallas, 2026-08-25), not one sectioned card.
          .staffing-line is a structural wrapper with NO styles of its own: it
          exists so every direct child of the cell is block-level, which is what
          lets `.staffing-cell > * + *` carry the spacing whether or not
          StaffHoverCard wrapped that child in an anchor. */}
      <StaffHoverCard staff={approvedStaffList(event)}>
        <div className="staffing-line">{line}</div>
      </StaffHoverCard>
      {showChip && (
        <StaffHoverCard staff={pendingStaffList(event)}>
          <div className="staffing-line">
            <StatusChip kind="neutral">{plural(pending, 'request')}</StatusChip>
          </div>
        </StaffHoverCard>
      )}
    </div>
  );
}
