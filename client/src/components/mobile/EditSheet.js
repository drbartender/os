import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import useSheetFocus from '../../hooks/useSheetFocus';
import Icon from '../adminos/Icon';
import { ctDay } from '../adminos/format';
import { humanizeReason } from '../comms/notifyDrafts';
import useEditSheet, { LOAD_FAILED } from './useEditSheet';
import {
  SHEET_NOTE, STALE_EVENT, PREVIEW_FAILED, START_MIN, START_MAX,
  stepHours, stepGuests, canStep, fmtHours, startInputValue, nextStartValue, nextDateValue,
  sheetDateText, extensionHint, multiShiftNote, curfewRidesLine,
  wasLine, startSubLine, PENDING_FIGURE, BALANCE_BECOMES,
} from '../../utils/editSheetView';
import { holdTaps } from '../../utils/tapGuard';

const ARROW = String.fromCharCode(0x2192);

// What goes wrong after Confirm shows in the notices strip, just above the
// rows (in the notify step, the failed-save line above its heading): it is
// brought into view, and focus moves to it, never to the body. A notice in
// view moves nothing, and a capped strip scrolls inside itself before the
// sheet does, so the rows stay put; only a sheet that scrolls whole, on a
// screen too short for it, scrolls to the notice.
function bringIntoView(box, target) {
  if (box && typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'nearest' });
  if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
}

// The phone edit sheet for an EVENT (lane ma-e3; spec 2026-08-13-mobile-admin
// section 3, the brainstorm decisions of 2026-10-05 and the design pass of
// 2026-10-06; benchmark docs/design-artifacts/2026-10-06-edit-sheet-layout).
// This file draws; useEditSheet.js reads and writes. Mounted only while open;
// the owner holds the URL state (useDrawerParam, push). "Readout above,
// controls pinned": everything that comes and goes is in one readout between
// the head and the rows. Its copy (the total, the reprice lines, the notes)
// scrolls past the max height; its notices, under the copy, scroll in their
// own strip only when they alone outgrow the room; they, the rows and the
// footer sit at the bottom of the screen. The sheet is as tall as its
// content, at most the screen less 12px, so when the copy changes only the
// head moves. The notify step fills the max height, so a channel's message
// showing or hiding moves nothing.
export default function EditSheet({ proposalId, clientName, kind, shiftCount = 0, onClose, onSaved, previewDelayMs, armDelayMs = 500, inFlight = false }) {
  const sheet = useEditSheet({ proposalId, onSaved, previewDelayMs, inFlight });
  // Which notify button sent the save, so that one reads "Saving".
  const [tapped, setTapped] = useState(null);
  const ready = sheet.phase === 'ready' && !!sheet.values;

  // One arm for the whole sheet. Each time the sheet swaps the view under the
  // finger, the new view's controls, the scrim and Escape wait armDelayMs
  // before they take a tap: the second tap of a double tap lands on whatever
  // replaced the first tap's target. A swap is the sheet opening, every change
  // of phase (loading, ready, failed, locked), the notify step opening, and the
  // step going back to the form. The sheet is as tall as its content (design
  // pass 2026-10-06), so a phase change moves its top edge, and a double tap on
  // Edit details or Reload would otherwise land on the scrim. A change inside a
  // view (a figure landing, a notice or an error coming or going, a step that
  // withdraws the curfew confirm) is not a swap. The swap is counted in the
  // render that shows the new view (state adjusted during render), so its
  // controls are held from its very first commit.
  const viewSig = ready ? (sheet.pending || sheet.proposal) : sheet.phase;
  const [seenSig, setSeenSig] = useState(viewSig);
  const [swaps, setSwaps] = useState(1);   // the opening is the first swap
  if (seenSig !== viewSig) {
    setSeenSig(viewSig);
    setSwaps((n) => n + 1);
  }
  const [armedAt, setArmedAt] = useState(0);
  useEffect(() => {
    if (armDelayMs <= 0) return undefined;
    const done = swaps;
    const timer = setTimeout(() => setArmedAt(done), armDelayMs);
    return () => clearTimeout(timer);
  }, [swaps, armDelayMs]);
  const holding = armDelayMs > 0 && armedAt !== swaps;

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

  // After a reload, or a failed load's Retry, the button that had focus is
  // gone: once the read settles (the form, a failure with Retry, the locked
  // message), the sheet takes focus back (the dialog), as the opening does.
  // The opening itself is still loading, and useSheetFocus focuses it.
  useLayoutEffect(() => {
    const el = sheetRef.current;
    if (sheet.phase !== 'loading' && el && !el.contains(document.activeElement)) el.focus();
  }, [sheet.phase]);

  // As the sheet closes, however it closes, the screen's taps are held for the
  // arm, so the second tap of a double tap on Done, Cancel, the scrim or a save
  // lands on nothing beneath (the detail, its header, the tab bar under the
  // footer). The hold waits one tick, and the effect running again cancels it:
  // React.StrictMode (client/src/index.js) runs this cleanup once right after
  // the sheet mounts in development, then the effect again, and that is not a
  // close.
  const pendingHold = useRef(null);
  useEffect(() => {
    clearTimeout(pendingHold.current);
    return () => { pendingHold.current = setTimeout(() => holdTaps(armDelayMs), 0); };
  }, [armDelayMs]);

  // A strip of scrim above the sheet thinner than a thumb (44px) is too thin to
  // be a deliberate dismiss: it is 12px at the sheet's max height, and a sheet
  // just short of its cap leaves one still too thin. In the edit view a tap
  // there would discard the edits, so there it does nothing (Cancel, Back and
  // Escape still close); in the notify step it still steps back, which
  // discards nothing. The loading line, a failed load and the locked message
  // have no Cancel, so there the scrim stays a way out. A sheet with no
  // layout (height 0) is never thin.
  const scrimTap = () => {
    const el = sheetRef.current;
    const rect = el ? el.getBoundingClientRect() : null;
    const thin = !!rect && rect.height > 0 && rect.top < 44;
    if (thin && ready && !sheet.pending) return;
    closers.current.onClose();
  };

  const curfewRef = useRef(null);
  const curfewBtnsRef = useRef(null);
  const keepRef = useRef(null);
  const staleRef = useRef(null);
  const reloadRef = useRef(null);
  const errorRef = useRef(null);
  const headRef = useRef(null);
  const confirmRef = useRef(null);
  // The curfew confirm's button row (not its box, which can outgrow its capped
  // strip and would keep its top in view, its buttons out of it) and the stale
  // notice are scrolled into view once, as they appear; a failed save's line
  // lands inside the strip the same way, without scrolling the whole sheet.
  // Their safe button (Keep editing, Reload) takes focus once the view is
  // armed, since a held button cannot take focus: at once, unless the notice
  // came with a swap back from the notify step. The arm's end moves focus
  // only, never the scroll, so a scroll made meanwhile stays put.
  useEffect(() => { if (sheet.curfew) bringIntoView(curfewBtnsRef.current || curfewRef.current, null); }, [sheet.curfew]);
  useEffect(() => { if (sheet.curfew && !holding) bringIntoView(null, keepRef.current); }, [sheet.curfew, holding]);
  useEffect(() => { if (sheet.stale) bringIntoView(staleRef.current, null); }, [sheet.stale]);
  useEffect(() => { if (sheet.stale && !holding) bringIntoView(null, reloadRef.current); }, [sheet.stale, holding]);
  useEffect(() => { if (sheet.error) bringIntoView(errorRef.current, errorRef.current); }, [sheet.error]);

  // A step change moves focus: into the notify step's heading as it opens (a
  // heading, so a stray Enter cannot send), and back to Confirm when Cancel,
  // Escape or the scrim returns to the edit view, once the edit view is armed
  // (a held button cannot take focus). A curfew or stale notice takes it above.
  // The edit view comes back whole and at its top; the rows never moved.
  const wasPending = useRef(false);
  const confirmFocusDue = useRef(false);
  useLayoutEffect(() => {
    if (sheet.pending && !wasPending.current) {
      if (headRef.current) headRef.current.focus();
    } else if (!sheet.pending && wasPending.current) {
      confirmFocusDue.current = !sheet.curfew && !sheet.stale;
    }
    wasPending.current = !!sheet.pending;
  }, [sheet.pending, sheet.curfew, sheet.stale]);

  // The fade at the copy's foot: shown whenever the copy overflows, as the
  // export draws it. Measured after every render and when its box resizes.
  const editView = ready && !sheet.pending;
  const readoutRef = useRef(null);
  const [fade, setFade] = useState(false);
  const measureFade = useCallback(() => {
    const el = readoutRef.current;
    const over = !!el && el.scrollHeight > el.clientHeight + 1;
    setFade((cur) => (cur === over ? cur : over));
  }, []);
  useLayoutEffect(() => { measureFade(); });
  useEffect(() => {
    const el = readoutRef.current;
    if (!editView || !el || typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(measureFade);
    watch.observe(el);
    return () => watch.disconnect();
  }, [editView, measureFade]);

  useEffect(() => {
    if (holding || !confirmFocusDue.current) return;
    confirmFocusDue.current = false;
    if (confirmRef.current) confirmRef.current.focus({ preventScroll: true });
  }, [swaps, holding]);

  const today = ctDay(new Date());
  const v = sheet.values || {};
  const r = sheet.readout;
  const confirmLabel = r ? r.button : 'Done';
  const canConfirm = ready && !sheet.busy && !holding && !sheet.curfew && !sheet.stale
    && (!sheet.changed || sheet.preview.state === 'ready');
  const onConfirm = () => { if (sheet.changed) sheet.confirm(); else closeSheet(); };
  const hint = ready ? extensionHint(sheet.proposal, v.event_duration_hours) : null;
  const shiftsNote = multiShiftNote(shiftCount);
  const rides = sheet.curfew ? curfewRidesLine(sheet.curfew.notify, sheet.curfew.staff) : null;
  const was = (field) => wasLine(field, sheet.initial, sheet.values, today);
  // Three dots on screen, "pending" to a screen reader.
  const pendingDots = (
    <>
      <span aria-hidden="true">{PENDING_FIGURE}</span>
      <span className="visually-hidden">pending</span>
    </>
  );

  // A row's label, and under it what a changed field was (under Start, the setup).
  const label = (name, sub) => (
    <span className="m-edit-label">
      <span>{name}</span>
      {sub && <span className="m-edit-was">{sub}</span>}
    </span>
  );

  const stepper = (name, value, text, step, field, lessName, moreName) => (
    <div className="m-sheet-row m-edit-stepper-row">
      {label(name, was(field))}
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
      <button type="button" className="m-sheet-scrim" aria-label="Close" tabIndex={-1} onClick={scrimTap} />
      <div className={`m-sheet m-edit-sheet${ready && sheet.pending ? ' m-edit-notifying' : ''}`} role="dialog" aria-modal="true" aria-label="Edit details" tabIndex={-1} ref={sheetRef}>
        <div className="m-sheet-handle" />
        <div className="m-sheet-head">
          <h2 className="m-sheet-title">{clientName || 'Event'}{kind ? <span className="m-sheet-kind">{` · ${kind}`}</span> : null}</h2>
          <div className="m-sheet-mix">{SHEET_NOTE}</div>
        </div>
        {!ready && (
          <div className="m-sheet-body">
            {sheet.phase === 'loading' && <div className="m-sheet-state">Loading the event</div>}
            {sheet.phase === 'failed' && (
              <div className="m-fail" role="alert">
                <span className="m-fail-msg">{LOAD_FAILED}</span>
                <button type="button" className="m-fail-retry" disabled={holding} onClick={sheet.reload}>Retry</button>
              </div>
            )}
            {sheet.phase === 'locked' && <div className="m-sheet-state">{sheet.lockedMessage}</div>}
          </div>
        )}
        {editView && (
          <>
            {/* The readout's copy: what comes and goes, scrolling past the max height. */}
            <div className="m-edit-readout" ref={readoutRef}>
              <div className={`m-edit-figure${r.dim ? ' m-edit-dim' : ''}`} aria-busy={r.pricing ? 'true' : undefined}>
                {/* The two top lines, read as a whole when they change. */}
                <div aria-live="polite" aria-atomic="true">
                  <div className="m-edit-total">
                    <span className="m-edit-total-label">{r.label}</span>
                    <span className="m-edit-figs">
                      {r.old && <span className="m-edit-total-old">{r.old}</span>}
                      {r.old && <span className="m-edit-arrow" aria-hidden="true">{ARROW}</span>}
                      {r.old && <span className="visually-hidden"> to </span>}
                      <span className="m-edit-total-new">{r.pending ? pendingDots : r.now}</span>
                    </span>
                  </div>
                  <div className="m-edit-sub">
                    {r.pricing && <span className="m-edit-pricing">pricing</span>}
                    {r.sub && <span className="m-edit-bal">{r.pending ? <>{`${BALANCE_BECOMES} `}{pendingDots}</> : r.sub}</span>}
                  </div>
                </div>
                {r.lines.length > 0 && (
                  <div className="m-edit-lines">{r.lines.map((line) => <p key={line}>{line}</p>)}</div>
                )}
              </div>
              {hint && <p className="m-edit-hint">{hint}</p>}
              {shiftsNote && <p className="m-edit-hint">{shiftsNote}</p>}
              {fade && <div className="m-edit-fade" aria-hidden="true" />}
            </div>
            {/* The notices: under the copy, their foot on the rows. When a button
                removes its own notice, copy from above slides into its place, never
                another button. They scroll in their own strip only when they alone
                outgrow the room the rows and footer leave (a curfew confirm with its
                rides line at 320x568), whose button row is then brought into view. */}
            <div className="m-edit-notices">
              {sheet.changed && sheet.preview.state === 'failed' && (
                <div className="m-fail" role="alert">
                  <span className="m-fail-msg">{PREVIEW_FAILED}</span>
                  <button type="button" className="m-fail-retry" disabled={holding} onClick={sheet.retryPreview}>Retry</button>
                </div>
              )}
              {sheet.error && (
                <div className="m-fail" role="alert" tabIndex={-1} ref={errorRef}><span className="m-fail-msg">{sheet.error}</span></div>
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
                  <div className="m-confirm-btns" ref={curfewBtnsRef}>
                    <button type="button" className="m-act m-act-quiet" ref={keepRef} disabled={sheet.busy || holding} onClick={sheet.declineCurfew}>Keep editing</button>
                    <button type="button" className="m-act m-act-confirm" disabled={sheet.busy || holding} onClick={sheet.acknowledgeCurfew}>Book it anyway</button>
                  </div>
                </div>
              )}
            </div>
            <div className="m-edit-rows">
              <label className="m-sheet-row m-edit-pick">
                <Icon name="calendar" size={18} />
                {label('Date', was('event_date'))}
                <span className="m-edit-value">{sheetDateText(v.event_date, today)}</span>
                <span className="m-edit-caret" aria-hidden="true"><Icon name="right" size={16} /></span>
                <input type="date" className="m-edit-native" aria-label="Date" value={v.event_date || ''}
                  min={today} disabled={sheet.busy || holding}
                  onChange={(e) => { const next = nextDateValue(e.target.value, today); if (next) sheet.setValue('event_date', next); }} />
              </label>
              <label className="m-sheet-row m-edit-pick">
                <Icon name="clock" size={18} />
                {label('Start', startSubLine(sheet.proposal, sheet.initial, sheet.values))}
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
              {stepper('Guests', v.guest_count, String(v.guest_count), stepGuests, 'guest_count', 'Fewer guests', 'More guests')}
            </div>
            <div className="m-acts m-edit-acts">
              <button type="button" className="m-act m-act-quiet" disabled={sheet.busy || holding} onClick={closeSheet}>Cancel</button>
              <button type="button" className="m-act m-act-primary" ref={confirmRef} disabled={!canConfirm} onClick={onConfirm}>{sheet.busy ? 'Saving' : confirmLabel}</button>
            </div>
          </>
        )}
        {ready && sheet.pending && (
          <>
            <div className={`m-sheet-body${sheet.busy ? ' m-sheet-busy' : ''}`}>
              {/* A failed save in the notify step says so above "Notify the client?", where the step starts. */}
              {sheet.error && (
                <div className="m-fail m-notify-fail" role="alert" tabIndex={-1} ref={errorRef}><span className="m-fail-msg">{sheet.error}</span></div>
              )}
              <NotifyStep sheet={sheet} headRef={headRef} holding={holding} />
            </div>
            {/* Two rows: Cancel and "Send the update", then "Don't send" (the main
                button, last in reading order) across the whole width; no label wraps. */}
            <div className="m-acts m-acts-notify m-edit-acts">
              <button type="button" className="m-act m-act-quiet" disabled={sheet.busy || holding} onClick={sheet.backToEdit}>Cancel</button>
              <button type="button" className="m-act m-act-quiet" disabled={sheet.busy || holding || !sheet.canSend}
                onClick={() => { setTapped('send'); sheet.sendUpdate(); }}>{sheet.busy && tapped === 'send' ? 'Saving' : 'Send the update'}</button>
              <button type="button" className="m-act m-act-primary" disabled={sheet.busy || holding}
                onClick={() => { setTapped('quiet'); sheet.dontSend(); }}>{sheet.busy && tapped === 'quiet' ? 'Saving' : "Don't send"}</button>
            </div>
          </>
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
