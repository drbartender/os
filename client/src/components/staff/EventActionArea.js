import React from 'react';

/**
 * EventActionArea — the bottom of the staff Event Details page: whatever the
 * viewer can actually DO about this shift (spec 2026-07-22).
 *
 * Extracted from ShiftDetail.js, which had grown past 800 lines, and widened at
 * the same time. The page used to be assigned-only, so this region only ever
 * showed drop/cover plus the confirm bar. Now that any staffer can read an
 * event, a browsing staffer has to be able to REQUEST it from the page they
 * just read, instead of navigating back to a list to find the button.
 *
 * `viewerState` is computed by the page:
 *   'assigned'   — approved + active. Drop / cover + the confirm bar.
 *   'pending'    — requested, awaiting review. Withdraw.
 *   'waitlisted' — requested, but every role they picked is full. Leave waitlist.
 *   'browsing'   — no request. Request / Join waitlist / Cover this. A just-
 *                  dropped shift lands here too (the payload filters dropped
 *                  rows); the dropResult gate renders the dropped banner.
 *   'admin'      — admin or a manager who is only viewing. Read-only note.
 * Anything else renders nothing.
 *
 * The confirm action itself is unchanged: it still posts the same acknowledge
 * endpoint and is still gated on the drink plan being finalized. Only the words
 * changed ("BEO" is gone from everything staff read).
 */
export default function EventActionArea({
  viewerState,
  isDrinkPlanFinalized,
  hasProposal = true,
  confirmed,
  acknowledging,
  onConfirm,
  dropMode,
  dropResult,
  onOpenDrop,
  coverNeeded,
  coverForInitial,
  fullyStaffed,
  busy,
  onRequest,
  onClaimCover,
  onWithdraw,
}) {
  if (viewerState === 'admin') {
    return (
      <div className="sp-confirm-bar">
        <div className="sp-confirm-bar-msg">
          Admin view. Confirming is a per-bartender action, so that button is hidden for you.
        </div>
      </div>
    );
  }

  if (viewerState === 'browsing') {
    // Just dropped (clean or emergency): the server's payload no longer carries
    // the request row, so the refetch classifies this viewer as browsing. Without
    // this gate the page would invite them to re-request the shift they dropped
    // seconds ago. A cover request keeps them on the roster ('assigned' path).
    if (dropResult && dropResult.mode !== 'cover') {
      return (
        <>
          <DropResultNote dropResult={dropResult} />
          <div className="sp-confirm-bar">
            <div className="sp-confirm-bar-msg">
              <strong>You dropped this shift.</strong> Management has it from here.
            </div>
          </div>
        </>
      );
    }
    return (
      <div className="sp-confirm-bar">
        <div className="sp-confirm-bar-msg">
          {coverNeeded ? (
            <>
              <strong>{coverForInitial ? `${coverForInitial} needs a cover.` : 'A teammate needs a cover.'}</strong>{' '}
              Pick it up and you are on the roster.
            </>
          ) : fullyStaffed ? (
            <>
              <strong>This event is fully staffed.</strong> Join the waitlist and we will reach
              out if a slot opens.
            </>
          ) : (
            <>
              <strong>Want this shift?</strong> Request it and the lead will review.
            </>
          )}
        </div>
        <button
          type="button"
          className="sp-btn sp-btn-lg sp-btn-primary"
          onClick={coverNeeded ? onClaimCover : onRequest}
          disabled={busy}
        >
          {busy ? '…' : coverNeeded ? 'Cover this' : fullyStaffed ? 'Join waitlist' : 'Request this shift'}
        </button>
      </div>
    );
  }

  if (viewerState === 'pending' || viewerState === 'waitlisted') {
    const waitlisted = viewerState === 'waitlisted';
    return (
      <div className="sp-confirm-bar">
        <div className="sp-confirm-bar-msg">
          {waitlisted ? (
            <>
              <strong>You are on the waitlist.</strong> We will reach out if a slot opens.
            </>
          ) : (
            <>
              <strong>Request pending review.</strong> The lead will confirm or decline it.
            </>
          )}
        </div>
        <button
          type="button"
          className="sp-btn sp-btn-sm sp-btn-ghost"
          onClick={onWithdraw}
          disabled={busy}
        >
          {busy ? '…' : waitlisted ? 'Leave waitlist' : 'Withdraw'}
        </button>
      </div>
    );
  }

  // Anything unrecognized renders nothing rather than falling through to the
  // drop / confirm UI, which is the most dangerous default in this set.
  if (viewerState !== 'assigned') return null;

  return (
    <>
      {dropMode && !dropResult && (
        <div
          className={
            'sp-drop-card' +
            (dropMode === 'cover' ? ' sp-drop-warn' : '') +
            (dropMode === 'emergency' ? ' sp-drop-danger' : '')
          }
        >
          <div className="sp-drop-l">
            <div className="sp-drop-title">{dropTitle(dropMode)}</div>
            <div className="sp-drop-sub">{dropSub(dropMode)}</div>
          </div>
          <button
            type="button"
            className={'sp-btn sp-btn-sm' + (dropMode === 'emergency' ? ' sp-btn-danger' : '')}
            onClick={() => onOpenDrop(dropMode)}
          >
            {dropCta(dropMode)}
          </button>
        </div>
      )}

      {dropResult && <DropResultNote dropResult={dropResult} />}

      <div className="sp-confirm-bar">
        <ConfirmBar
          confirmed={confirmed}
          hasProposal={hasProposal}
          isDrinkPlanFinalized={isDrinkPlanFinalized}
          acknowledging={acknowledging}
          onConfirm={onConfirm}
        />
      </div>
    </>
  );
}

/**
 * The confirm bar's three states. The finalize gate is unchanged from the
 * original page: a staffer is never asked to confirm details the lead may
 * still be revising.
 */
function ConfirmBar({ confirmed, hasProposal, isDrinkPlanFinalized, acknowledging, onConfirm }) {
  if (!hasProposal) {
    // A legacy manual shift has no drink plan and never will, so "confirm
    // unlocks once the lead finalizes" would be a promise that never resolves.
    return (
      <div className="sp-confirm-bar-msg">
        There is no plan to confirm for this event.
      </div>
    );
  }
  if (confirmed) {
    return (
      <div className="sp-confirm-bar-msg">
        <strong>Confirmed.</strong> Thanks. The lead has been notified.
      </div>
    );
  }
  if (!isDrinkPlanFinalized) {
    return (
      <div className="sp-confirm-bar-msg">
        <strong>Details still being finalized.</strong> Confirm unlocks once the lead
        finalizes the plan.
      </div>
    );
  }
  return (
    <>
      <div className="sp-confirm-bar-msg">
        <strong>Confirm you have read the event details.</strong> The lead will see this on
        the roster.
      </div>
      <button
        type="button"
        className="sp-btn sp-btn-lg sp-btn-primary"
        onClick={onConfirm}
        disabled={acknowledging}
      >
        {acknowledging ? (
          'Confirming…'
        ) : (
          <>
            <CheckIcon size={14} />
            Confirm details
          </>
        )}
      </button>
    </>
  );
}

/** The green what-just-happened note under a drop / cover / emergency action. */
function DropResultNote({ dropResult }) {
  return (
    <div className="sp-drop-result">
      <CheckIcon size={14} />
      <span>
        {dropResult.mode === 'drop' && (
          <>
            <strong>Shift dropped.</strong> Management notified.
          </>
        )}
        {dropResult.mode === 'cover' && (
          <>
            <strong>Cover request broadcast.</strong> You are still on the roster until
            someone picks it up.
          </>
        )}
        {dropResult.mode === 'emergency' && (
          <>
            <strong>Management notified by SMS.</strong> They will be in touch.
          </>
        )}
      </span>
    </div>
  );
}

// ── Drop / cover copy (moved verbatim from ShiftDetail.js) ─────────────────

function dropTitle(mode) {
  if (mode === 'drop') return 'Drop this shift';
  if (mode === 'cover') return 'Need a cover';
  return 'Emergency, can’t make it';
}

function dropSub(mode) {
  if (mode === 'drop') return '14+ days out, simple swap. Slot goes back to the open pool.';
  if (mode === 'cover')
    return 'Under 14 days. Cover broadcasts to qualified bartenders; you stay on the roster until someone picks it up.';
  return 'Under 72 hours. Late drops bypass cover broadcast and ping management by SMS.';
}

function dropCta(mode) {
  if (mode === 'drop') return 'Drop shift';
  if (mode === 'cover') return 'Need a cover';
  return 'Emergency, can’t make it';
}

function CheckIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
