import React from 'react';
import { getEventTypeLabel } from '../../utils/eventTypes';

/**
 * ShiftCard — shared shift summary card for the redesigned staff portal
 * (spec §6.2 / §6.3 / §6.4). Renders the same chassis everywhere
 * (HomePage "Next shift", ShiftsPage/Mine, ShiftsPage/Past,
 * ShiftsPage/Available); the foot region adapts by `variant`.
 *
 * Props:
 *   shift             — backend shift / shift_request projection. Expected
 *                       shape:
 *                         {
 *                           id, event_date, start_time, end_time,
 *                           location, event_type, event_type_custom,
 *                           client_name, position, guest_count,
 *                           beo_confirmed, cover_needed
 *                         }
 *                       Fields are read defensively — every renderer guards
 *                       on the field being present.
 *   showConfirmFlag   — render the BEO confirm chip in the foot
 *                       (used on HomePage "Next shift" + ShiftsPage/Mine).
 *   onClick           — click handler for the whole card. Also fires on
 *                       Enter/Space when the card has keyboard focus.
 *   variant           — 'default' (own approved upcoming),
 *                       'open'    (open shift listing — shows estimate +
 *                                  requested-by + cover-needed badges),
 *                       'past'    (past shift — shows the payout-line
 *                                  total if `payout_line_total_cents` set).
 *                       Anything else falls back to 'default'.
 *
 * Pricing chips that need money never round; they read the raw integer
 * cents from `shift.pay_cents_estimate` or `shift.payout_line_total_cents`
 * so we don't reinvent the cents-formatter here.
 *
 * Styling: vanilla CSS classes prefixed `sp-` (component CSS in
 * client/src/index.css references the --sp-* design tokens). Classes
 * mirror the design source (see Dr Bartender (6)/staff/styles.css §"Shift
 * card") so the visual identity stays consistent with the rest of the
 * portal once §32+ CSS lands.
 */
export default function ShiftCard({ shift, showConfirmFlag = false, onClick, variant = 'default' }) {
  if (!shift) return null;

  const eventLabel = getEventTypeLabel({
    event_type: shift.event_type,
    event_type_custom: shift.event_type_custom,
  });

  const dateLabel = formatDate(shift.event_date);
  const rel = relativeDay(shift.event_date);
  const isToday = rel.label === 'Today';
  const isOpen = variant === 'open';
  const isPast = variant === 'past';

  // Confirmed-vs-needs-action tone is purely a visual accent and only
  // applies to mine/default cards. Open and past variants never tone.
  let tone = '';
  if (!isOpen && !isPast && showConfirmFlag) {
    const diff = rel.diffDays;
    if (!shift.beo_confirmed && diff >= 0 && diff <= 7) tone = 'needs-action';
    else if (shift.beo_confirmed && diff >= 0) tone = 'confirmed';
  }

  const className = [
    'sp-shift',
    tone,
    shift.cover_needed ? 'cover-needed' : '',
  ].filter(Boolean).join(' ');

  function handleKeyDown(e) {
    if (!onClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick(e);
    }
  }

  return (
    <div
      className={className}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <div className="sp-shift-head">
        <span className="sp-shift-when">{dateLabel}{shift.start_time ? ` · ${shift.start_time}` : ''}</span>
        <span className={'sp-shift-rel' + (isToday ? ' today' : '')}>{rel.label}</span>
      </div>
      <div>
        <div className="sp-shift-name">{shift.client_name || 'Client'}</div>
        <div className="sp-shift-type">
          {eventLabel}
          {shift.guest_count ? ` · ${shift.guest_count} guests` : ''}
        </div>
      </div>
      {(shift.location || (shift.start_time && shift.end_time)) && (
        <div className="sp-shift-meta">
          {shift.location && (
            <span className="sp-shift-meta-row">
              <LocationIcon size={12} />
              {shift.location}
            </span>
          )}
          {shift.start_time && shift.end_time && (
            <span className="sp-shift-meta-row">
              <ClockIcon size={12} />
              {shift.start_time}{'–'}{shift.end_time}
            </span>
          )}
        </div>
      )}
      <ShiftCardFoot
        shift={shift}
        variant={variant}
        showConfirmFlag={showConfirmFlag}
      />
    </div>
  );
}

function ShiftCardFoot({ shift, variant, showConfirmFlag }) {
  if (variant === 'past') {
    const cents = shift.payout_line_total_cents;
    const status = shift.payout_status;
    if (cents == null && !status) return null;
    return (
      <div className="sp-shift-foot">
        <div className="sp-shift-foot-l">
          {status && (
            <span className={'sp-chip ' + (status === 'paid' ? 'ok' : 'info')}>
              <span className="sp-chip-dot" />
              {status === 'paid' ? 'Paid' : 'Processing'}
            </span>
          )}
        </div>
        {cents != null && (
          <span className="sp-shift-payout sp-mono">{formatCents(cents)}</span>
        )}
      </div>
    );
  }

  if (variant === 'open') {
    const hasEstimate = shift.pay_cents_estimate != null;
    const hasCount = shift.requested_by_count > 0;
    const hasCover = !!shift.cover_needed;
    if (!hasEstimate && !hasCount && !hasCover) return null;
    return (
      <div className="sp-shift-foot">
        <div className="sp-shift-foot-l">
          {hasEstimate && (
            <span className="sp-chip neutral">
              <span className="sp-chip-dot" />
              {'~' + formatCents(shift.pay_cents_estimate)} est.
            </span>
          )}
          {hasCount && (
            <span className="sp-chip neutral">
              {shift.requested_by_count} already requested
            </span>
          )}
          {hasCover && (
            <span className="sp-chip warn">
              <span className="sp-chip-dot" />
              Cover needed
            </span>
          )}
        </div>
      </div>
    );
  }

  // default — mine / home next-shift
  const showPosition = !!shift.position;
  if (!showPosition && !showConfirmFlag) return null;
  return (
    <div className="sp-shift-foot">
      <div className="sp-shift-foot-l">
        {showPosition && (
          <span className="sp-chip neutral">
            <span className="sp-chip-dot" />
            {shift.position}
          </span>
        )}
        {showConfirmFlag && (
          shift.beo_confirmed
            ? <span className="sp-chip ok"><span className="sp-chip-dot" />BEO confirmed</span>
            : <span className="sp-chip warn"><span className="sp-chip-dot" />BEO to confirm</span>
        )}
      </div>
    </div>
  );
}

// ── Local helpers ──────────────────────────────────────────────────────────
//
// These mirror the helpers in the design source's data.jsx (fmtDay,
// relDay_ST, $$). They live here for now so the foundation tasks don't
// have to import an extra utils file that other shared components don't
// need yet. When more components grow (paystub formatting, payday math,
// etc.) these will lift out into client/src/utils/staffFormat.js.

/** YYYY-MM-DD → "Sat, May 30" */
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** YYYY-MM-DD → { label, diffDays } where label is Today/Tomorrow/Yesterday/In Nd/Nd ago */
function relativeDay(iso) {
  if (!iso) return { label: '', diffDays: 0 };
  const d = new Date(iso + 'T12:00:00');
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return { label: 'Today', diffDays: diff };
  if (diff === 1) return { label: 'Tomorrow', diffDays: diff };
  if (diff === -1) return { label: 'Yesterday', diffDays: diff };
  if (diff > 0) return { label: `In ${diff}d`, diffDays: diff };
  return { label: `${-diff}d ago`, diffDays: diff };
}

/** Integer cents → "$45.50" or "$45" (trims trailing .00). */
function formatCents(cents) {
  const v = Math.abs(cents) / 100;
  const formatted = v.toFixed(2).replace(/\.00$/, '');
  return (cents < 0 ? '-' : '') + '$' + formatted;
}

function LocationIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function ClockIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
