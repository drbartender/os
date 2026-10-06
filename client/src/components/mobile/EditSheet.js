import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import useSheetFocus from '../../hooks/useSheetFocus';
import Icon from '../adminos/Icon';
import { ctDay } from '../adminos/format';
import { humanizeReason } from '../comms/notifyDrafts';
import useEditSheet, { LOAD_FAILED } from './useEditSheet';
import {
  SHEET_NOTE, STALE_EVENT, PREVIEW_FAILED, START_MIN, START_MAX,
  stepHours, stepGuests, canStep, fmtHours, startInputValue, nextStartValue, nextDateValue,
  sheetDateText, setupMinutesText, extensionHint, multiShiftNote, curfewRidesLine,
} from '../../utils/editSheetView';

// What went wrong after Confirm renders where the eye is not (the foot of the
// edit view): it is scrolled into view, and focus moves to it, never to the body.
function bringIntoView(box, target) {
  if (box && typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'nearest' });
  if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
}

// The body's content never shrinks while the sheet is open: the tallest it has
// been is its floor (min-height). Otherwise, with the body scrolled, a prompt
// that leaves (the curfew confirm, a notice, an error) or a total that returns
// to the stored values would shorten it, the scroll would clamp, and the
// steppers would slide under the finger. Returns the floor.
function holdFloor(el, floor) {
  if (!el) return floor;
  const height = el.getBoundingClientRect().height;
  if (!(height > floor)) return floor;
  el.style.minHeight = `${height}px`;
  return height;
}

// Leaving the ready phase (a reload, a failed load, a lock) drops the floor and
// puts the body back at its top, so what renders next (the loading line, the
// fresh form, a failure with Retry, the locked message) is in view and not
// above it; the floor then starts again from that content. Returns the floor.
function dropFloor(el, body) {
  if (el) el.style.minHeight = '';
  if (body) body.scrollTop = 0;
  return 0;
}

// The phone edit sheet for an EVENT (lane ma-e3; spec 2026-08-13-mobile-admin
// section 3, brainstorm decisions of 2026-10-05; benchmark 2026-09-15, the
// edit sheet). This file draws; useEditSheet.js reads and writes. Mounted
// only while open; the owner holds the URL state (useDrawerParam, push).
// The sheet keeps one height (m-edit-sheet), so nothing above the total block
// moves under the finger when a figure loads, lands, or leaves.
export default function EditSheet({ proposalId, clientName, kind, shiftCount = 0, onClose, onSaved, previewDelayMs, armDelayMs = 500 }) {
  const sheet = useEditSheet({ proposalId, onSaved, previewDelayMs });
  // Which notify button sent the save, so that one reads "Saving".
  const [tapped, setTapped] = useState(null);
  const ready = sheet.phase === 'ready' && !!sheet.values;

  // One arm for the whole sheet. Each time the sheet swaps the view under the
  // finger (the form's first ready render after the sheet opens or reloads,
  // the notify step opening, the step going back to the form), the new view's
  // controls, the scrim and Escape wait armDelayMs before they take a tap: the
  // second tap of a double tap lands on whatever replaced the first tap's
  // target. A change inside a view (a figure landing, a notice or an error
  // coming or going, a step that withdraws the curfew confirm) is not a swap.
  // The swap is counted in the render that shows the new view (state adjusted
  // during render), so its controls are held from its very first commit.
  const viewSig = ready ? (sheet.pending || sheet.proposal) : null;
  const [seenSig, setSeenSig] = useState(viewSig);
  const [swaps, setSwaps] = useState(0);
  if (seenSig !== viewSig) {
    setSeenSig(viewSig);
    if (viewSig) setSwaps((n) => n + 1);
  }
  const [armedAt, setArmedAt] = useState(0);
  useEffect(() => {
    if (armDelayMs <= 0 || swaps === 0) return undefined;
    const done = swaps;
    const timer = setTimeout(() => setArmedAt(done), armDelayMs);
    return () => clearTimeout(timer);
  }, [swaps, armDelayMs]);
  const holding = ready && armDelayMs > 0 && armedAt !== swaps;

  const sheetRef = useRef(null);
  const closeSheet = () => { if (!sheet.busy && !holding && onClose) onClose(); };
  // Escape (useSheetFocus) and a tap on the scrim: in the notify step they step
  // back to the edit view with the edits kept, as the desktop popup's Escape and
  // backdrop return to the editor; in the edit view they close the sheet. Never
  // while a save is in flight, and not while a view just swapped in is held.
  const closers = useRef({});
  closers.current = {
    onClose: () => {
      if (sheet.busy || holding) return;
      if (sheet.pending) sheet.backToEdit(); else if (onClose) onClose();
    },
  };
  useSheetFocus(sheetRef, closers);

  const curfewRef = useRef(null);
  const keepRef = useRef(null);
  const staleRef = useRef(null);
  const reloadRef = useRef(null);
  const errorRef = useRef(null);
  const headRef = useRef(null);
  const confirmRef = useRef(null);
  // The curfew confirm and the stale notice are scrolled into view once, as
  // they appear. Their safe button (Keep editing, Reload) takes focus once the
  // view is armed, since a held button cannot take focus: at once, unless the
  // notice came with a swap back from the notify step. The arm's end moves
  // focus only, never the scroll, so a scroll made meanwhile stays put.
  useEffect(() => { if (sheet.curfew) bringIntoView(curfewRef.current, null); }, [sheet.curfew]);
  useEffect(() => { if (sheet.curfew && !holding) bringIntoView(null, keepRef.current); }, [sheet.curfew, holding]);
  useEffect(() => { if (sheet.stale) bringIntoView(staleRef.current, null); }, [sheet.stale]);
  useEffect(() => { if (sheet.stale && !holding) bringIntoView(null, reloadRef.current); }, [sheet.stale, holding]);
  useEffect(() => { if (sheet.error) bringIntoView(errorRef.current, errorRef.current); }, [sheet.error]);

  // The content's floor, from the moment the sheet opens (each opening mounts
  // the sheet afresh) or returns to the ready phase: measured after every
  // render, and on any resize a render does not cause (fonts, rotation). Any
  // phase but ready drops it first (declared first, so the measure below
  // starts again in the same commit).
  const bodyRef = useRef(null);
  const contentRef = useRef(null);
  const floor = useRef(0);
  useLayoutEffect(() => {
    if (sheet.phase !== 'ready') floor.current = dropFloor(contentRef.current, bodyRef.current);
  }, [sheet.phase]);
  useLayoutEffect(() => { floor.current = holdFloor(contentRef.current, floor.current); });
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(() => { floor.current = holdFloor(el, floor.current); });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  // A step change moves focus too: into the notify step's heading as it opens
  // (a heading, so a stray Enter cannot send), and back to Confirm when Cancel,
  // Escape or the scrim returns to the edit view, once the edit view is armed
  // (a held button cannot take focus). A curfew or stale notice takes it
  // above. The edit view comes back scrolled where it was, so the steppers
  // return to where they were; before paint, and before the notice effects
  // above bring a curfew or stale notice into view.
  const wasPending = useRef(false);
  const editScroll = useRef(0);
  const confirmFocusDue = useRef(false);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (sheet.pending && !wasPending.current) {
      if (body) editScroll.current = body.scrollTop;
      if (headRef.current) headRef.current.focus();
    } else if (!sheet.pending && wasPending.current) {
      if (body) body.scrollTop = editScroll.current;
      confirmFocusDue.current = !sheet.curfew && !sheet.stale;
    }
    wasPending.current = !!sheet.pending;
  }, [sheet.pending, sheet.curfew, sheet.stale]);
  useEffect(() => {
    if (holding || !confirmFocusDue.current) return;
    confirmFocusDue.current = false;
    if (confirmRef.current) confirmRef.current.focus({ preventScroll: true });
  }, [swaps, holding]);

  const today = ctDay(new Date());
  const v = sheet.values || {};
  const view = sheet.view;
  const confirmLabel = view ? view.button : 'Done';
  const canConfirm = ready && !sheet.busy && !holding && !sheet.curfew && !sheet.stale
    && (!sheet.changed || sheet.preview.state === 'ready');
  const onConfirm = () => { if (sheet.changed) sheet.confirm(); else closeSheet(); };
  const hint = ready ? extensionHint(sheet.proposal, v.event_duration_hours) : null;
  const shiftsNote = multiShiftNote(shiftCount);
  const rides = sheet.curfew ? curfewRidesLine(sheet.curfew.notify, sheet.curfew.staff) : null;

  const stepper = (label, value, text, step, field, lessName, moreName) => (
    <div className="m-sheet-row m-edit-stepper-row">
      <span className="m-edit-label">{label}</span>
      <span className="m-stepper-ctl">
        <button type="button" className="m-stepper-btn" aria-label={lessName}
          disabled={sheet.busy || holding || !canStep(value, -1, step)}
          onClick={() => sheet.setValue(field, step(value, -1))}>{String.fromCharCode(0x2212)}</button>
        <span className="m-stepper-value" aria-live="polite">{text}</span>
        <button type="button" className="m-stepper-btn" aria-label={moreName}
          disabled={sheet.busy || holding || !canStep(value, 1, step)}
          onClick={() => sheet.setValue(field, step(value, 1))}>+</button>
      </span>
    </div>
  );

  return (
    <>
      <button type="button" className="m-sheet-scrim" aria-label="Close" tabIndex={-1} onClick={() => closers.current.onClose()} />
      <div className="m-sheet m-edit-sheet" role="dialog" aria-modal="true" aria-label="Edit details" tabIndex={-1} ref={sheetRef}>
        <div className="m-sheet-handle" />
        <div className="m-sheet-head">
          <h2 className="m-sheet-title">{clientName || 'Event'}{kind ? <span className="m-sheet-kind">{` · ${kind}`}</span> : null}</h2>
          <div className="m-sheet-mix">{SHEET_NOTE}</div>
        </div>
        <div className={`m-sheet-body${sheet.busy ? ' m-sheet-busy' : ''}`} ref={bodyRef}>
          {/* One box around everything the body scrolls, for the floor above. */}
          <div className="m-edit-content" ref={contentRef}>
            {sheet.phase === 'loading' && <div className="m-sheet-state">Loading the event</div>}
            {sheet.phase === 'failed' && (
              <div className="m-fail" role="alert">
                <span className="m-fail-msg">{LOAD_FAILED}</span>
                <button type="button" className="m-fail-retry" onClick={sheet.reload}>Retry</button>
              </div>
            )}
            {sheet.phase === 'locked' && <div className="m-sheet-state">{sheet.lockedMessage}</div>}
            {ready && !sheet.pending && (
              <>
                <label className="m-sheet-row m-edit-pick">
                  <Icon name="calendar" size={18} />
                  <span className="m-edit-label">Date</span>
                  <span className="m-edit-value">{sheetDateText(v.event_date, today)}</span>
                  <span className="m-edit-caret" aria-hidden="true"><Icon name="right" size={16} /></span>
                  <input type="date" className="m-edit-native" aria-label="Date" value={v.event_date || ''}
                    min={today} disabled={sheet.busy || holding}
                    onChange={(e) => { const next = nextDateValue(e.target.value, today); if (next) sheet.setValue('event_date', next); }} />
                </label>
                <label className="m-sheet-row m-edit-pick">
                  <Icon name="clock" size={18} />
                  <span className="m-edit-label">Start</span>
                  <span className="m-edit-value">{startInputValue(v.event_start_time)}</span>
                  <span className="m-edit-caret" aria-hidden="true"><Icon name="right" size={16} /></span>
                  <input type="time" className="m-edit-native" aria-label="Start" step={300}
                    min={START_MIN} max={START_MAX} value={startInputValue(v.event_start_time)} disabled={sheet.busy || holding}
                    onChange={(e) => {
                      const next = nextStartValue(e.target.value, sheet.initial.event_start_time);
                      if (next) sheet.setValue('event_start_time', next);
                    }} />
                </label>
                {stepper('Duration', v.event_duration_hours, fmtHours(v.event_duration_hours), stepHours, 'event_duration_hours', 'Shorter', 'Longer')}
                {hint && <div className="m-edit-hint">{hint}</div>}
                <div className="m-sheet-row m-edit-static">
                  <span className="m-edit-label">Setup</span>
                  <span className="m-edit-value">{setupMinutesText(sheet.proposal)}</span>
                </div>
                {stepper('Guests', v.guest_count, String(v.guest_count), stepGuests, 'guest_count', 'Fewer guests', 'More guests')}
                {shiftsNote && <div className="m-edit-hint">{shiftsNote}</div>}
                {view && view.repriced && (
                  // While a newer figure is on its way the last one stays, dimmed.
                  <div className={view.stale ? 'm-edit-total-stale' : undefined} aria-busy={view.stale ? 'true' : undefined}>
                    <div className="m-edit-total">
                      <span className="m-edit-total-label">New total</span>
                      <span className="m-edit-total-old">{view.oldTotal}</span>
                      <span className="m-edit-arrow" aria-hidden="true">{String.fromCharCode(0x2192)}</span>
                      <span className="m-edit-total-new">{view.newTotal}</span>
                    </div>
                    {view.balanceLine && <div className="m-edit-bal">{view.balanceLine}</div>}
                    {view.lines.length > 0 && (
                      <ul className="m-edit-lines">{view.lines.map((line) => <li key={line}>{line}</li>)}</ul>
                    )}
                  </div>
                )}
                {sheet.changed && sheet.preview.state === 'failed' && (
                  <div className="m-fail" role="alert">
                    <span className="m-fail-msg">{PREVIEW_FAILED}</span>
                    <button type="button" className="m-fail-retry" disabled={holding} onClick={sheet.retryPreview}>Retry</button>
                  </div>
                )}
                {sheet.stale && (
                  <div className="m-sheet-note" role="alert" ref={staleRef}>
                    <span className="m-sheet-note-dot" aria-hidden="true" />
                    <span className="m-sheet-note-text">{STALE_EVENT}</span>
                    <button type="button" className="m-fail-retry" ref={reloadRef} disabled={holding} onClick={sheet.reload}>Reload</button>
                  </div>
                )}
                {sheet.curfew && (
                  <div className="m-confirm" role="alert" ref={curfewRef}>
                    <div className="m-confirm-copy">{`${sheet.curfew.reason} Book it anyway? This will be recorded.`}</div>
                    {rides && <div className="m-confirm-copy">{rides}</div>}
                    <div className="m-confirm-btns">
                      <button type="button" className="m-act m-act-quiet" ref={keepRef} disabled={sheet.busy || holding} onClick={sheet.declineCurfew}>Keep editing</button>
                      <button type="button" className="m-act m-act-confirm" disabled={sheet.busy || holding} onClick={sheet.acknowledgeCurfew}>Book it anyway</button>
                    </div>
                  </div>
                )}
                {sheet.error && (
                  <div className="m-fail" role="alert" tabIndex={-1} ref={errorRef}><span className="m-fail-msg">{sheet.error}</span></div>
                )}
              </>
            )}
            {/* A failed save in the notify step says so above "Notify the client?", where the step starts. */}
            {ready && sheet.pending && sheet.error && (
              <div className="m-fail m-notify-fail" role="alert" tabIndex={-1} ref={errorRef}><span className="m-fail-msg">{sheet.error}</span></div>
            )}
            {ready && sheet.pending && <NotifyStep sheet={sheet} headRef={headRef} holding={holding} />}
          </div>
        </div>
        {ready && !sheet.pending && (
          <div className="m-acts">
            <button type="button" className="m-act m-act-quiet" disabled={sheet.busy || holding} onClick={closeSheet}>Cancel</button>
            <button type="button" className="m-act m-act-primary" ref={confirmRef} disabled={!canConfirm} onClick={onConfirm}>{sheet.busy ? 'Saving' : confirmLabel}</button>
          </div>
        )}
        {/* Two rows: Cancel and "Send the update", then "Don't send" (the main
            button, last in reading order) across the whole width; no label wraps. */}
        {ready && sheet.pending && (
          <div className="m-acts m-acts-notify">
            <button type="button" className="m-act m-act-quiet" disabled={sheet.busy || holding} onClick={sheet.backToEdit}>Cancel</button>
            <button type="button" className="m-act m-act-quiet" disabled={sheet.busy || holding || !sheet.canSend}
              onClick={() => { setTapped('send'); sheet.sendUpdate(); }}>{sheet.busy && tapped === 'send' ? 'Saving' : 'Send the update'}</button>
            <button type="button" className="m-act m-act-primary" disabled={sheet.busy || holding}
              onClick={() => { setTapped('quiet'); sheet.dontSend(); }}>{sheet.busy && tapped === 'quiet' ? 'Saving' : "Don't send"}</button>
          </div>
        )}
      </div>
    </>
  );
}

// The desktop notify popup, mirrored (spec section 3, 2026-10-05): the same
// ticks, the standard message read-only, the staff block off by default.
function NotifyStep({ sheet, headRef, holding }) {
  const { pending, drafts, staff } = sheet;
  // A save in flight, or the step just opened and not armed yet.
  const busy = sheet.busy || holding;
  return (
    <div className="m-notify">
      <h3 className="m-notify-title" tabIndex={-1} ref={headRef}>Notify the client?</h3>
      {pending.notices.map((n, i) => {
        const d = drafts[i] || { channels: [], subject: '', bodyText: '', smsBody: '' };
        const r = n.recipient || {};
        const contact = r.email ? ` (${r.email})` : (r.phone ? ` (${r.phone})` : '');
        return (
          <div key={n.type} className="m-notify-notice">
            <div className="m-notify-reasons">
              {`${(n.reasons || []).map(humanizeReason).join(', ')}. Current contact on file: ${r.name || 'the client'}${contact}.`}
            </div>
            {n.autopay_notice && <div className="m-notify-autopay">{n.autopay_notice}</div>}
            <div className="m-notify-channels">
              {['email', 'sms'].map((ch) => {
                const c = (n.channels || {})[ch];
                const label = ch === 'email' ? 'Email' : 'Text';
                if (c && c.available) {
                  return (
                    <label key={ch} className="m-notify-check">
                      <input type="checkbox" checked={d.channels.includes(ch)} disabled={busy}
                        onChange={() => sheet.toggleChannel(i, ch)} />
                      <span>{label}</span>
                    </label>
                  );
                }
                return c && c.unavailable_reason
                  ? <span key={ch} className="m-notify-unavail">{`${label} unavailable: ${c.unavailable_reason}`}</span>
                  : null;
              })}
            </div>
            {n.composable ? (
              <>
                {d.channels.includes('email') && (
                  <div className="m-notify-msg">
                    <div className="m-notify-subject">{d.subject}</div>
                    <div className="m-notify-body">{d.bodyText}</div>
                  </div>
                )}
                {d.channels.includes('sms') && (
                  <div className="m-notify-msg"><div className="m-notify-body">{d.smsBody}</div></div>
                )}
              </>
            ) : <div className="m-notify-fixed">This message is not editable.</div>}
          </div>
        );
      })}
      <div className="m-notify-staff">
        <label className="m-notify-check">
          <input type="checkbox" checked={staff.enabled} disabled={busy}
            onChange={(e) => sheet.setStaff(e.target.checked ? { ...staff, enabled: true } : { enabled: false, sms: false, email: false })} />
          <span>Notify assigned staff</span>
        </label>
        {/* Off until "Notify assigned staff" is ticked, and they look it. Each
            name starts with its visible label (WCAG 2.5.3). */}
        <div className={`m-notify-sub${staff.enabled ? '' : ' m-notify-sub-off'}`}>
          <label className="m-notify-check">
            <input type="checkbox" aria-label="Text (SMS), assigned staff" checked={staff.sms} disabled={busy || !staff.enabled}
              onChange={(e) => sheet.setStaff({ ...staff, sms: e.target.checked })} />
            <span>Text (SMS)</span>
          </label>
          <label className="m-notify-check">
            <input type="checkbox" aria-label="Email, assigned staff" checked={staff.email} disabled={busy || !staff.enabled}
              onChange={(e) => sheet.setStaff({ ...staff, email: e.target.checked })} />
            <span>Email</span>
          </label>
        </div>
        <div className="m-notify-hint">Staff are notified only when the date, time, or location actually changes.</div>
      </div>
    </div>
  );
}
