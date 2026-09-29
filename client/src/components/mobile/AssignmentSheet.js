import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { offlineGet } from '../../utils/offlineRead';
import { chicagoDay } from '../../utils/chicagoDay';
import useSheetFocus from '../../hooks/useSheetFocus';
import Icon from '../adminos/Icon';
import StatusChip from '../adminos/StatusChip';
import { groupShiftRows, railParts } from '../../utils/eventCards';
import {
  buildShiftView, candidatesOf, roleStep, confirmCopy, READ_ONLY_NOTE,
} from '../../utils/staffingSheet';
import useSheetWrites from './useSheetWrites';

// The phone ShiftDrawer for ONE shift (spec 2026-08-13-mobile-admin section 4
// Detail; benchmark docs/design-artifacts/2026-09-15-mobile-admin-shell.dc.html,
// Assignment sheet). This file reads and draws; every write, and the rules a
// write must pass, live in useSheetWrites.js.
//
// Reads. The roster and the staff list are read with offlineGet, so either
// may be answered from the phone's cache (res.staleAt). Each governs what it
// feeds, and says so: a stored ROSTER makes the whole sheet read-only; a
// stored STAFF LIST locks the picker and leaves the roster's actions live,
// because none of them reads it. The staff list is read once the shift can
// take an assignment, or at mount when the owner already knows it can
// (`assignable`), so the picker does not wait a round behind the roster.
//
// Failed saves. One per row, shown under the row it came from with what it
// was, a Retry and a Dismiss. A failure whose row is not on screen (the picker
// closed, the person left the roster) is shown at the top of the sheet. A
// person in the picker who holds a failure stays in the list whatever the
// search field says. NOTHING in this file removes a failed save but Dismiss:
// see useSheetWrites.js for the three ways one leaves the screen, and for
// what holds while a write is in flight (the row says "Saving").
//
// Mounted only while open. The owner holds the URL state (useDrawerParam with
// push: true); this component never navigates.
const OFFLINE_NOTE = 'No connection. Staffing actions need the server; the roster below is the cached copy.';
const PICKER_OFFLINE_NOTE = 'No connection. Assigning needs the server; the staff list below is the cached copy.';
const SAVED_BEHIND = 'Saved. The roster below could not be refreshed and may be out of date.';
const LOAD_FAILED = 'Network error. Check your connection.';

export default function AssignmentSheet({
  shiftId, focusUserId = null, assignable = false, onClose, onChanged, onDead,
}) {
  const [data, setData] = useState(null);           // { shift, requests }
  const [staleAt, setStaleAt] = useState(null);     // set when the service worker served the roster
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [staff, setStaff] = useState([]);
  const [staffState, setStaffState] = useState('idle');   // idle | loading | ready | failed
  const [staffStaleAt, setStaffStaleAt] = useState(null); // set when the service worker served the picker
  const [focusKey, setFocusKey] = useState(null);   // the expanded roster row
  const [pickKey, setPickKey] = useState(null);     // the row showing its role rows
  const [confirm, setConfirm] = useState(null);     // { key, kind: 'remove' | 'deny' }
  const [query, setQuery] = useState('');

  const seq = useRef(0);
  const sheetRef = useRef(null);
  const focusedOnce = useRef(false);
  const handlers = useRef({ onClose, onChanged, onDead });
  handlers.current = { onClose, onChanged, onDead };
  const alive = useRef(true);         // false once the owner has closed the sheet
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Resolves true when an answer went on screen, false when none did, and null
  // when a newer read took over. `live`: only an answer from the network will
  // do (after a save, a stored copy is the roster from BEFORE it).
  const load = useCallback(async ({ quiet = false, live = false } = {}) => {
    const mine = ++seq.current;
    if (!quiet) { setLoading(true); setLoadError(null); }
    try {
      const res = await offlineGet(`/shifts/detail/${shiftId}`);
      if (mine !== seq.current) return null;
      if (live && res.staleAt) return false;
      setData(res.data || null);
      setStaleAt(res.staleAt || null);
      return true;
    } catch (err) {
      if (mine !== seq.current) return null;
      if (!alive.current) return false;
      // Dead shift (deleted, staffing access lost, or an id the server refuses
      // as malformed): the owner decides where to land. Never render an error
      // screen over a route that cannot recover.
      if (err && (err.status === 404 || err.status === 403 || err.status === 400)) {
        const h = handlers.current;
        if (h.onDead) h.onDead(); else if (h.onClose) h.onClose();
        return false;
      }
      if (!quiet) setLoadError((err && err.message) || LOAD_FAILED);
      return false;
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [shiftId]);

  const loadStaff = useCallback(async () => {
    setStaffState('loading');
    try {
      const res = await offlineGet('/admin/active-staff', { params: { limit: 100, shift_id: shiftId } });
      if (!alive.current) return;
      setStaff((res.data && res.data.staff) || []);
      setStaffStaleAt(res.staleAt || null);
      setStaffState('ready');
    } catch {
      if (!alive.current) return;
      // No list now, so no stored copy of one either: the picker says it
      // could not load, and nothing else is held back.
      setStaffStaleAt(null);
      setStaffState('failed');
    }
  }, [shiftId]);

  useEffect(() => { load(); }, [load]);

  const showFresh = useCallback((fresh) => { setData(fresh); setStaleAt(null); }, []);
  const reload = useCallback(() => load({ quiet: true, live: true }), [load]);
  const onDone = useCallback((ok) => { setConfirm(null); if (ok) setPickKey(null); }, []);
  const writes = useSheetWrites({ shiftId, showFresh, reload, onDone, handlers });
  const { busy, busyKey, busyLabel, failures, justAssigned } = writes;

  // Closing waits for a write in flight: a failed save that lands on a closed
  // sheet has nowhere to be shown. (Android Back still closes; the owner's
  // roster then shows what is true.)
  const closers = useRef({});
  closers.current = { onClose: () => { if (!busy && handlers.current.onClose) handlers.current.onClose(); } };
  useSheetFocus(sheetRef, closers);

  const view = useMemo(
    () => buildShiftView(data && data.shift, data && data.requests, { justAssigned }),
    [data, justAssigned]
  );
  const card = useMemo(() => (data && data.shift ? groupShiftRows([data.shift])[0] : null), [data]);

  const offline = !!staleAt;                          // the ROSTER is a stored copy
  const pickerOffline = offline || !!staffStaleAt;    // the roster or the STAFF LIST is
  const closed = !!view.closedReason;
  const locked = offline || closed;                   // no write is possible
  const canAssign = !closed && !view.rosterless && view.openRoles.length > 0;
  const picker = canAssign && staffState !== 'failed';

  useEffect(() => {
    if ((assignable || canAssign) && staffState === 'idle') loadStaff();
  }, [assignable, canAssign, staffState, loadStaff]);

  const candidates = useMemo(() => {
    if (!picker) return [];
    const found = new Set(candidatesOf(staff, view, query).map((c) => c.key));
    // A person this sheet just assigned is on the shift even when the roster on
    // screen is older than the save (the read after it failed).
    const placed = new Set(justAssigned.map(Number));
    return candidatesOf(staff, view, '')
      .filter((c) => !placed.has(Number(c.userId)))
      .filter((c) => found.has(c.key) || failures[c.key]);
  }, [picker, staff, view, query, failures, justAssigned]);

  useEffect(() => {
    if (focusedOnce.current || focusUserId === null || focusUserId === undefined || view.rows.length === 0) return;
    focusedOnce.current = true;
    const target = view.rows.find((r) => String(r.userId) === String(focusUserId));
    if (target) setFocusKey(target.key);
  }, [focusUserId, view.rows]);

  const toggleFocus = (key) => {
    setFocusKey((cur) => (cur === key ? null : key));
    setPickKey(null);
    setConfirm(null);
  };
  // None of these three touches a failed save: they open and close things and
  // write nothing.
  const onApprove = (row) => {
    const step = roleStep(view, row);
    if (step.kind === 'direct') writes.place(row, step.role, { direct: true });
    else if (step.kind === 'pick') setPickKey((cur) => (cur === row.key ? null : row.key));
  };
  const ask = (row, kind) => {
    setPickKey(null);
    setConfirm({ key: row.key, kind });
  };
  const onCandidate = (c) => {
    setFocusKey(null);
    setPickKey((cur) => (cur === c.key ? null : c.key));
  };

  // Dismiss is the quiet one: Retry repeats a write that texts a person.
  const failBox = (key) => {
    const held = failures[key];
    if (!held) return null;
    return (
      <div className="m-fail" role="alert" key={`fail-${key}`}>
        <span className="m-fail-msg">
          <span className="m-fail-who">{held.label}</span>
          {held.message}
        </span>
        <button type="button" className="m-fail-retry" disabled={busy || locked}
          onClick={() => writes.retry(key)}>Retry</button>
        <button type="button" className="m-fail-retry m-fail-quiet" disabled={busy}
          onClick={() => writes.forget(key)}>Dismiss</button>
      </div>
    );
  };

  // At the top of the sheet the line has no row, so it carries the label.
  const saving = (key, named = false) => (busyKey === key
    ? <div className="m-saving" role="status" key={`saving-${key}`}>{named ? `Saving · ${busyLabel}` : 'Saving'}</div>
    : null);

  const roleRows = (label, person) => (
    <>
      <div className="m-role-label">{label}</div>
      {view.openRoles.map((r) => (
        <button key={r.role} type="button" className="m-sheet-row" disabled={busy || locked}
          onClick={() => writes.place(person, r.role)}>
          <span className="m-role-name">{r.role}</span>
          <span className="m-role-open">{r.open} open</span>
        </button>
      ))}
    </>
  );

  const renderRosterRow = (row) => {
    const focused = focusKey === row.key && !closed;
    const step = roleStep(view, row);
    const asking = focused && confirm && confirm.key === row.key ? confirmCopy(confirm.kind, row.name) : null;
    return (
      <div className="m-sheet-item" key={row.key} role="group" aria-label={row.name}>
        <button type="button" className="m-sheet-row m-person" aria-expanded={focused}
          onClick={() => toggleFocus(row.key)}>
          <span className={`m-avatar${row.kind === 'rostered' ? '' : ' m-avatar-app'}`} aria-hidden="true">{row.initials}</span>
          <span className="m-person-main">
            <span className="m-person-name">{row.name}</span>
            {row.meta ? <span className="m-person-meta">{row.meta}</span> : null}
          </span>
          {row.kind === 'applicant' && <StatusChip kind="warn">Pending</StatusChip>}
          {row.kind === 'waitlisted' && <StatusChip kind="neutral">Waitlisted</StatusChip>}
          {row.kind === 'rostered' && <span className="m-person-check"><Icon name="check" size={16} /></span>}
        </button>
        {focused && asking && (
          <div className="m-confirm">
            <span className="m-confirm-copy">{asking.copy}</span>
            <span className="m-confirm-btns">
              <button type="button" className="m-act m-act-quiet" disabled={busy} onClick={() => setConfirm(null)}>Keep</button>
              <button type="button" className="m-act m-act-confirm" disabled={busy || offline}
                onClick={() => (confirm.kind === 'remove' ? writes.remove(row) : writes.deny(row))}>{asking.label}</button>
            </span>
          </div>
        )}
        {focused && !asking && (
          <div className="m-acts">
            {row.kind === 'rostered' ? (
              <button type="button" className="m-act m-act-danger" disabled={busy || offline}
                onClick={() => ask(row, 'remove')}>Remove from shift</button>
            ) : (
              <>
                <button type="button" className="m-act m-act-primary"
                  disabled={busy || offline || step.kind === 'blocked'}
                  onClick={() => onApprove(row)}>Approve</button>
                <button type="button" className="m-act m-act-quiet" disabled={busy || offline}
                  onClick={() => ask(row, 'deny')}>Deny</button>
              </>
            )}
          </div>
        )}
        {focused && !asking && pickKey === row.key && step.kind === 'pick' && roleRows('Approve as', row)}
        {saving(row.key)}
        {failBox(row.key)}
      </div>
    );
  };

  const renderCandidate = (c) => (
    <div className="m-sheet-item" key={c.key} role="group" aria-label={c.name}>
      <button type="button" className="m-sheet-row m-person" aria-expanded={pickKey === c.key}
        disabled={busy || pickerOffline} onClick={() => onCandidate(c)}>
        <span className="m-avatar" aria-hidden="true">{c.initials}</span>
        <span className="m-person-main">
          <span className="m-person-name">{c.name}</span>
          {c.meta ? <span className="m-person-meta">{c.meta}</span> : null}
        </span>
        <span className={`m-person-go${pickerOffline ? ' m-person-go-off' : ''}`}>{pickerOffline ? 'Offline' : 'Assign'}</span>
      </button>
      {pickKey === c.key && !pickerOffline && roleRows('Assign as', c)}
      {saving(c.key)}
      {failBox(c.key)}
    </div>
  );

  const rail = card && card.ymd ? railParts(card.ymd) : null;
  // Outside the current year the date names its year, as the detail's when
  // line does: an event next January must not read as this one.
  const thisYear = chicagoDay(new Date().toISOString()).slice(0, 4);
  const year = card && card.ymd && card.ymd.slice(0, 4) !== thisYear ? ` ${card.ymd.slice(0, 4)}` : '';
  const when = card ? [rail ? `${rail.dow} ${rail.mon} ${rail.day}${year}` : '', card.timeRange].filter(Boolean).join(' · ') : '';
  // Only rows that are DRAWN hold their own failure; the rest are strays.
  const drawn = view.rows.map((r) => r.key).concat(candidates.map((c) => c.key));
  const strays = Object.keys(failures).filter((key) => !drawn.includes(key));

  return (
    <>
      <button type="button" className="m-sheet-scrim" aria-label="Close" tabIndex={-1}
        onClick={() => closers.current.onClose()} />
      <div className="m-sheet" role="dialog" aria-modal="true" aria-label="Assign staff" tabIndex={-1} ref={sheetRef}>
        <div className="m-sheet-handle" />
        {card && (
          <div className="m-sheet-head">
            <h2 className="m-sheet-title">
              {card.clientName}
              {card.kind ? <span className="m-sheet-kind">{` · ${card.kind}`}</span> : null}
            </h2>
            <div className="m-sheet-when">
              <span>{when}</span>
              <span className="m-pills">
                {view.pills.map((p, i) => (
                  <span key={i} className={`m-pill${p === 'filled' ? ' m-pill-filled' : p === 'pending' ? ' m-pill-pending' : ''}`} />
                ))}
                {view.closedReason === 'cancelled' ? null : <span className="m-pill-count">{view.count}</span>}
              </span>
            </div>
            <div className="m-sheet-mix">{closed ? READ_ONLY_NOTE[view.closedReason] : view.mix}</div>
            {card.manual && card.venue ? <div className="m-sheet-venue">{card.venue}</div> : null}
          </div>
        )}
        <div className={`m-sheet-body${busy ? ' m-sheet-busy' : ''}`}>
          {loading && !data && <div className="m-sheet-state">Loading the roster</div>}
          {loadError && !data && (
            <div className="m-fail" role="alert">
              <span className="m-fail-msg">{loadError}</span>
              <button type="button" className="m-fail-retry" onClick={() => load()}>Retry</button>
            </div>
          )}
          {data && (
            <>
              {offline && !closed && (
                <div className="m-sheet-note">
                  <span className="m-sheet-note-dot" aria-hidden="true" />
                  <span className="m-sheet-note-text">{OFFLINE_NOTE}</span>
                  <button type="button" className="m-fail-retry"
                    onClick={() => { load(); if (staffState !== 'idle') loadStaff(); }}>Retry</button>
                </div>
              )}
              {writes.behind && !offline && !closed && (
                <div className="m-sheet-note">
                  <span className="m-sheet-note-dot" aria-hidden="true" />
                  <span className="m-sheet-note-text">{SAVED_BEHIND}</span>
                  <button type="button" className="m-fail-retry" disabled={busy} onClick={writes.refresh}>Retry</button>
                </div>
              )}
              {view.rosterless && !closed && (
                <div className="m-sheet-note">
                  <span className="m-sheet-note-dot" aria-hidden="true" />
                  <span className="m-sheet-note-text">{READ_ONLY_NOTE.rosterless}</span>
                </div>
              )}
              {strays.map((key) => failBox(key))}
              {busyKey !== null && !drawn.includes(busyKey) && saving(busyKey, true)}
              {view.rows.length > 0 && (
                <>
                  <div className="m-sheet-sec">On this shift</div>
                  {view.rows.map(renderRosterRow)}
                </>
              )}
              {canAssign && (
                <>
                  <div className={`m-sheet-sec${view.rows.length > 0 ? ' m-sheet-sec-line' : ''}`}>{`Assign · ${view.openLabel}`}</div>
                  {!offline && !!staffStaleAt && (
                    <div className="m-sheet-note">
                      <span className="m-sheet-note-dot" aria-hidden="true" />
                      <span className="m-sheet-note-text">{PICKER_OFFLINE_NOTE}</span>
                      <button type="button" className="m-fail-retry" disabled={busy} onClick={loadStaff}>Retry</button>
                    </div>
                  )}
                  <div className="m-sheet-searchwrap">
                    <input type="search" className="m-sheet-search" placeholder="Search active staff"
                      aria-label="Search active staff" value={query} disabled={pickerOffline}
                      onChange={(e) => { setQuery(e.target.value); setPickKey(null); }} />
                  </div>
                  {staffState === 'failed' && (
                    <div className="m-fail" role="alert">
                      <span className="m-fail-msg">Couldn't load the staff list.</span>
                      <button type="button" className="m-fail-retry" onClick={loadStaff}>Retry</button>
                    </div>
                  )}
                  {staffState !== 'failed' && staffState !== 'ready' && (
                    <div className="m-sheet-state">Loading the staff list</div>
                  )}
                  {candidates.map(renderCandidate)}
                  {staffState === 'ready' && candidates.length === 0 && (
                    <div className="m-sheet-nomatch">
                      {query.trim() ? `No active staff matches “${query.trim()}”.` : 'Everyone active is already on this shift.'}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
