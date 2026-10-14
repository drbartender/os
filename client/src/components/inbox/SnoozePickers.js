import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../adminos/Icon';
import useSheetFocus from '../../hooks/useSheetFocus';
import { snoozeOptions } from './inboxFormat';

// Snooze (spec 4.4, the design): 3 hours, Tomorrow morning, or Pick a date in
// the next 7 days, all 8:00 AM Chicago. The phone gets the shipped bottom
// sheet, the desktop a panel under the Snooze button. `onPick(untilIso)`.

const SUBCOPY = 'Hidden until then. It comes back to Waiting with its full wait time.';
// The sheet takes its name from its title's text. An unknown number's name is
// the formatted phone, and Sentry's click breadcrumbs copy the aria-label,
// title, alt, name and type of the tapped element and its ancestors, never
// their text: no attribute in the sheet may carry the name.
const TITLE_ID = 'ib-snooze-title';
const DAYS_NOTE = 'wakes at 8:00 AM on the day you pick';

export function SnoozeSheet({ name, nowMs, onPick, onClose }) {
  const sheetRef = useRef(null);
  const closers = useRef({});
  closers.current = { onClose };
  useSheetFocus(sheetRef, closers);
  const [pick, setPick] = useState(false);
  // Fixed while the sheet is open, so the times do not move under a thumb.
  const { presets, days } = useMemo(() => snoozeOptions(nowMs), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <button type="button" className="m-sheet-scrim" aria-label="Close" tabIndex={-1} onClick={onClose} />
      <div className="m-sheet" role="dialog" aria-modal="true" aria-labelledby={TITLE_ID} tabIndex={-1} ref={sheetRef}>
        <div className="m-sheet-handle" />
        <div className="m-sheet-head">
          <h2 className="m-sheet-title" id={TITLE_ID}>Snooze {name}</h2>
          <div className="ib-sheet-sub">{SUBCOPY}</div>
        </div>
        <div className="ib-snooze-opts">
          {presets.map((p) => (
            <button key={p.key} type="button" className="m-sheet-row" onClick={() => onPick(p.until)}>
              <span className="ib-sheet-icon"><Icon name={p.icon} size={20} /></span>
              <span className="ib-sheet-label">{p.label}</span>
              <span className="ib-sheet-when">{p.when}</span>
            </button>
          ))}
          <button type="button" className="m-sheet-row" aria-expanded={pick} onClick={() => setPick((v) => !v)}>
            <span className="ib-sheet-icon"><Icon name="calendar" size={20} /></span>
            <span className="ib-sheet-label">Pick a date</span>
            <span className="ib-sheet-when">{pick ? '' : 'next 7 days'}</span>
          </button>
        </div>
        {pick && (
          <>
            <div className="ib-days">
              {days.map((d) => (
                <button key={d.key} type="button" className="ib-day-btn" aria-label={d.label} onClick={() => onPick(d.until)}>
                  <span className="ib-day-dow">{d.dow}</span>
                  <span className="ib-day-num">{d.day}</span>
                </button>
              ))}
            </div>
            <div className="ib-days-note">{DAYS_NOTE}</div>
          </>
        )}
        <button type="button" className="m-sheet-row ib-sheet-cancel" onClick={onClose}>Cancel</button>
      </div>
    </>
  );
}

// `anchorRef` is the Snooze button the menu hangs from. A labelled group of
// plain buttons, not an ARIA menu: Tab moves through it (a menu promises
// arrow keys it does not have), and the date grid is not an item. The
// design's desktop draws no caption under the days (the phone sheet does).
export function SnoozeMenu({ nowMs, anchorRef, onPick, onClose }) {
  const ref = useRef(null);
  // What the listeners read when a press or a key lands. The owner passes a
  // new onClose on every render (the clock tick, a refetch), and the
  // listeners are set once per open, so a re-render never moves focus.
  const latest = useRef({});
  latest.current = { onClose, anchorRef };
  const [pick, setPick] = useState(false);
  const { presets, days } = useMemo(() => snoozeOptions(nowMs), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const first = ref.current && ref.current.querySelector('button');
    if (first) first.focus();
    const anchor = () => {
      const a = latest.current.anchorRef;
      return a && a.current ? a.current : null;
    };
    // A press on the Snooze button is not outside: its own click toggles
    // the menu shut.
    const onDown = (e) => {
      const a = anchor();
      if (ref.current && !ref.current.contains(e.target) && !(a && a.contains(e.target))) latest.current.onClose();
    };
    // Escape closes and hands focus back to the Snooze button from the menu
    // (or from nowhere), never out of a field the user tabbed on to.
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const at = document.activeElement;
      const fromMenu = !at || at === document.body || (ref.current && ref.current.contains(at));
      latest.current.onClose();
      const a = anchor();
      if (a && fromMenu) a.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  return (
    <div className="ib-menu" role="group" aria-label="Snooze until" ref={ref}>
      {presets.map((p) => (
        <button key={p.key} type="button" className="ib-menu-item" onClick={() => onPick(p.until)}>
          <span className="ib-menu-icon"><Icon name={p.icon} size={14} /></span>
          <span className="ib-menu-label">{p.label}</span>
          <span className="ib-menu-when">{p.when}</span>
        </button>
      ))}
      <button type="button" className="ib-menu-item" aria-expanded={pick} onClick={() => setPick((v) => !v)}>
        <span className="ib-menu-icon"><Icon name="calendar" size={14} /></span>
        <span className="ib-menu-label">Pick a date</span>
        <span className="ib-menu-when">{pick ? '' : 'next 7 days'}</span>
      </button>
      {pick && (
        <div className="ib-mdays">
          {days.map((d) => (
            <button key={d.key} type="button" className="ib-mday" aria-label={d.label} onClick={() => onPick(d.until)}>
              <span className="ib-mday-dow">{d.dow}</span>
              <span className="ib-mday-num">{d.day}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
