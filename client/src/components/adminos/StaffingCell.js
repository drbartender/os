import React from 'react';
import StatusChip from './StatusChip';
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
// Pending requests get their own line, and which word they get depends only on
// whether an open slot remains: with a hole to fill they are `N requests`
// (someone is waiting on an approve/deny), with the roster full they are
// `N on waitlist` (informational overflow).
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

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function StaffingCell({ event }) {
  const { needed, confirmed, pending, open, inactive } = deriveStaffing(event);

  let line;
  if (needed === 0) {
    // Legacy/manual row with no canonical roster. There is no denominator, so
    // no ratio and no shortfall can be stated.
    line = <span className="staffing-none">No roster</span>;
  } else if (open > 0) {
    line = (
      <span className="staffing-ratio">
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
  // pending requests stay labelled as requests rather than being miscalled a
  // waitlist. (The old cell reported nothing at all for these rows.)
  const chipLabel = (open > 0 || needed === 0)
    ? plural(pending, 'request')
    : `${pending} on waitlist`;

  return (
    <div className={`vstack staffing-cell${inactive ? ' staffing-inactive' : ''}`} style={{ gap: 4, alignItems: 'flex-start' }}>
      {line}
      {pending > 0 && !inactive && (
        <StatusChip kind="neutral">{chipLabel}</StatusChip>
      )}
    </div>
  );
}
