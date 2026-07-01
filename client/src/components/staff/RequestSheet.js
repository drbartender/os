import React, { useEffect, useMemo, useState } from 'react';
import api from '../../utils/api';
import {
  parsePositionsNeeded,
  computeRemaining,
  classifyRequest,
  isEventFullyStaffed,
} from '../../utils/staffingRoles';
import RoleRankPicker, { fillMaps } from './RoleRankPicker';

/**
 * RequestSheet — the staff "request this shift" flow (staffing roster
 * project, Lane 6 §5). A bottom-sheet/dialog (reuses the portal's
 * sp-modal chassis) that:
 *
 *   1. Hosts RoleRankPicker so the staffer ranks the roles they can work.
 *   2. On a transport-required event (equipment and/or supply run), shows a
 *      warning block + a REQUIRED acknowledgment checkbox; submit is disabled
 *      until it's ticked. This mirrors the server's re-require-on-escalation
 *      guard so the client and server agree.
 *   3. Picks the submit label from the picked roles: if every picked role is
 *      already full, this is a waitlist join ("Join waitlist"); otherwise
 *      "Request".
 *   4. POSTs { requested_positions, transport_acknowledged } to
 *      /shifts/:id/request via api.js.
 *
 * The server resolves `position` at approval time; it is never sent here.
 *
 * Async-state coverage:
 *   - empty: the shift is gone or has no roles → friendly note + close.
 *   - submitting: the primary button is disabled and shows a working label.
 *   - error: an inline error with a Retry (resubmit) affordance; the sheet
 *     stays open so the staffer doesn't lose their ranking.
 *
 * Props:
 *   open       — render toggle.
 *   shift      — the open-shift feed row (positions_needed, approved_by_role,
 *                equipment_required, supply_run_required, my_requested_positions).
 *   busy       — external in-flight flag (parent may also gate the row).
 *   onClose    — close handler (scrim, ✕, Cancel). Ignored while submitting.
 *   onSubmitted — called after a successful POST so the parent can refetch.
 */
export default function RequestSheet({ open, shift, busy = false, onClose, onSubmitted }) {
  const neededRoles = useMemo(
    () => {
      const parsed = parsePositionsNeeded(shift?.positions_needed);
      // A shift with no defined roles (legacy or manually-created rows) still
      // needs a bartender by default, so it stays requestable as a single
      // Bartender slot instead of showing "no open roles".
      return parsed.length > 0 ? parsed : ['Bartender'];
    },
    [shift?.positions_needed]
  );
  const approvedByRole = useMemo(
    () => (shift?.approved_by_role && typeof shift.approved_by_role === 'object'
      ? shift.approved_by_role
      : {}),
    [shift?.approved_by_role]
  );
  const { counts, approved } = useMemo(
    () => fillMaps(neededRoles, approvedByRole),
    [neededRoles, approvedByRole]
  );
  const remaining = useMemo(
    () => computeRemaining(neededRoles, approvedByRole),
    [neededRoles, approvedByRole]
  );

  // Transport gating: equipment present OR a supply run is required.
  const transportRequired = requiresTransport(shift);

  // Seed the picker from a prior request's ranking when re-requesting, else
  // empty. Re-seeded whenever the sheet opens for a different shift.
  const [selection, setSelection] = useState([]);
  const [ack, setAck] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    const prior = parsePositionsNeeded(shift?.my_requested_positions)
      .filter((r) => neededRoles.includes(r));
    setSelection(prior);
    setAck(false);
    setError(null);
    setSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shift?.id]);

  if (!open) return null;

  // Empty state: the shift vanished or genuinely needs nobody.
  if (!shift || neededRoles.length === 0) {
    return (
      <Sheet onClose={onClose}>
        <div className="sp-modal-icon warn" aria-hidden="true">
          <AlertIcon size={20} />
        </div>
        <div className="sp-modal-title">This shift isn't open</div>
        <div className="sp-modal-sub">
          It may have been filled or cancelled. Head back to Available to find
          another.
        </div>
        <div className="sp-modal-acts">
          <button type="button" className="sp-btn sp-btn-block" onClick={onClose}>
            Close
          </button>
        </div>
      </Sheet>
    );
  }

  // Submit label: a request whose every picked role is full is a waitlist join.
  const joiningWaitlist =
    selection.length > 0 &&
    classifyRequest(selection, remaining).state === 'waitlisted';
  const eventFull = isEventFullyStaffed(remaining);

  const blockedNoRole = selection.length === 0;
  const blockedNoAck = transportRequired && !ack;
  const submitDisabled = submitting || busy || blockedNoRole || blockedNoAck;

  async function submit() {
    if (submitDisabled) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/shifts/${shift.id}/request`, {
        requested_positions: selection,
        transport_acknowledged: transportRequired ? ack : false,
      });
      onSubmitted?.();
    } catch (err) {
      // Surface the server's field-level message when present, else a generic.
      const fieldMsg =
        err?.fieldErrors?.requested_positions ||
        err?.fieldErrors?.transport_acknowledged ||
        err?.message;
      setError(fieldMsg || 'Could not send the request. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const submitLabel = joiningWaitlist || eventFull ? 'Join waitlist' : 'Request';

  return (
    <Sheet onClose={submitting ? undefined : onClose}>
      <div className={'sp-modal-icon' + (joiningWaitlist || eventFull ? ' warn' : '')} aria-hidden="true">
        <HandIcon size={20} />
      </div>
      <div className="sp-modal-title">
        {joiningWaitlist || eventFull ? 'Join the waitlist' : 'Request this shift'}
      </div>
      <div className="sp-modal-sub">
        {joiningWaitlist || eventFull
          ? 'Every role you can work is filled. Join the waitlist and we will reach out if a slot opens.'
          : 'Tell us which roles you can work. We confirm you into the highest-ranked open slot.'}
      </div>

      <RoleRankPicker
        roles={neededRoles.filter((r, i, a) => a.indexOf(r) === i)}
        counts={counts}
        approved={approved}
        value={selection}
        onChange={setSelection}
        disabled={submitting}
      />

      {transportRequired && (
        <>
          <div className="sp-cover-banner" style={{ marginTop: '0.6rem' }}>
            <AlertIcon size={14} />
            <span>
              <strong>Gear and supplies.</strong>{' '}
              {transportLine(shift)} You'll need reliable transportation to
              haul it.
            </span>
          </div>
          <label className="sp-ack-row">
            <input
              type="checkbox"
              checked={ack}
              disabled={submitting}
              onChange={(e) => setAck(e.target.checked)}
            />
            <span>
              I can transport the required equipment and supplies to this event.
            </span>
          </label>
        </>
      )}

      {error && <div className="sp-modal-error">{error}</div>}

      <div className="sp-modal-acts">
        <button
          type="button"
          className="sp-btn sp-btn-block"
          onClick={onClose}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="button"
          className="sp-btn sp-btn-block sp-btn-primary"
          onClick={submit}
          disabled={submitDisabled}
        >
          {submitting
            ? 'Sending…'
            : error
            ? 'Try again'
            : submitLabel}
        </button>
      </div>
    </Sheet>
  );
}

/**
 * The shift requires transport when it lists any equipment OR a supply run is
 * flagged. Mirrors the server's shiftRequiresTransport so the client gate and
 * the server gate agree.
 */
function requiresTransport(shift) {
  if (!shift) return false;
  const equip = parseEquipment(shift.equipment_required);
  return equip.length > 0 || shift.supply_run_required === true;
}

function transportLine(shift) {
  const equip = parseEquipment(shift.equipment_required);
  const hasEquip = equip.length > 0;
  const hasSupplies = shift?.supply_run_required === true;
  if (hasEquip && hasSupplies) return 'This event needs equipment hauled and a supply run.';
  if (hasEquip) return 'This event needs equipment hauled.';
  return 'This event needs a supply run.';
}

function parseEquipment(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((t) => typeof t === 'string' && t.trim().length > 0);
}

function Sheet({ children, onClose }) {
  // Esc closes the sheet unless a submit is in flight (onClose undefined).
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && onClose) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="sp-modal-scrim" onClick={onClose} />
      <div className="sp-modal" role="dialog" aria-modal="true">
        {onClose && (
          <button
            type="button"
            className="sp-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <CloseIcon size={14} />
          </button>
        )}
        {children}
      </div>
    </>
  );
}

function HandIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0" />
      <path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  );
}

function AlertIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function CloseIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
