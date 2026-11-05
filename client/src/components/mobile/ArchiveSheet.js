// ArchiveSheet: the phone's Archive for one proposal, a reason picked and then confirmed (spec
// 2026-08-13-mobile-admin section 3, Plan decisions of 2026-11-05; benchmark the archive sheet, 2026-10-14 shell).

import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import useSheetFocus from '../../hooks/useSheetFocus';
import Icon from '../adminos/Icon';
import { ARCHIVE_REASONS, archiveReasonLabel } from '../../utils/archiveReasons';
import { HOLD_NOTE, SHEET_MOVED, sheetRefusal } from '../../utils/proposalDetailView';
import { READ_TIMEOUT_MS } from '../../utils/editSheetView';
import { holdTaps } from '../../utils/tapGuard';

// MONEY. Archiving voids the proposal's unpaid invoice, cancels its shifts and
// stops its follow-ups (POST /proposals/:id/archive with scope one,
// server/routes/proposals/actions.js), so one tap never does it: a reason is
// picked first, then "Archive proposal" confirms. This proposal only; the
// whole-set choice stays on the desktop.
//
// BEFORE THE WRITE the proposal is read fresh (api.get with the read timeout,
// never the stored copy). A row already archived counts as done after a post
// of this sheet's that got no answer, so a Retry after a lost answer never
// archives twice; otherwise someone else archived it, and the sheet says so
// with that reason. Otherwise nothing is posted when
// the proposal went on legal hold, money landed on it, or its status left the
// archivable set (sheetRefusal); the sheet says why, and the page reads the
// proposal again when it closes.
// AFTER A FAILURE the pick is kept, and Retry repeats the whole step, read
// first. A refusal from the server (a 409 among them) reads in its words.
// ONE WRITE AT A TIME: a ref holds the step, as useSheetWrites does, so a
// double tap posts once; and the step is also held by proposal outside the
// sheet for as long as it runs, so a sheet opened again after Back while an
// archive is still going through says so and posts nothing. A sheet that
// Back closed during its read posts nothing at all.
// WHOSE ARCHIVE: an archived fresh read counts as done only after a post of
// this sheet's whose answer never came (no connection, or a server failure
// past the payment check); a definite refusal means the post did not land.
// ON SUCCESS: "Proposal archived." and the Proposals list, in place of this
// page, unless Back closed the sheet before the answer came: then the toast,
// and the page is told (onLateAnswer) so it reads the proposal again rather
// than leave Archive live under it; a page the user has moved on from is not
// replaced. A sheet closed after its post went out has the page read again.
export const ARCHIVE_OFFLINE = "No connection, didn't archive.";
export const ARCHIVE_UNSURE = 'No answer. It may have been archived. Retry checks first.';
export const ARCHIVE_EARLIER = 'An archive from an earlier tap is still going through. Close this and look at the proposal again.';
// Proposal ids with an archive step running, across sheets.
const ARCHIVES_OUT = new Set();
const GENERIC = 'Something went wrong. Try again.';
// Held after the sheet closes, as the edit sheet's arm does, so the second tap
// of a double tap lands on nothing beneath (utils/tapGuard.js); the scrim
// takes no tap for as long after the sheet opens.
const TAP_HOLD_MS = 500;
const READ = { timeout: READ_TIMEOUT_MS };
const isTransport = (err) => !err || err.status === 0 || err.code === 'NETWORK_ERROR';
const refusalText = (err) => {
  const texts = Object.values((err && err.fieldErrors) || {}).filter((v) => typeof v === 'string' && v.trim());
  return texts.length ? texts.join(' ') : ((err && err.message) || GENERIC);
};

// proposal: the proposal the page showed when the sheet opened.
// onClose({ moved }): the sheet closed; moved when it refused because the
// proposal changed, or a post went out, so the page reads it again.
// onLateAnswer(): a post's step ended after Back closed the sheet.
export default function ArchiveSheet({ proposal, onClose, onLateAnswer }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [reason, setReason] = useState(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState(null);
  const [refused, setRefused] = useState(() => (ARCHIVES_OUT.has(proposal.id) ? ARCHIVE_EARLIER : null));
  const sheetRef = useRef(null);
  // wrote: a post went out from this sheet. maybeOurs: one whose answer never came.
  const wrote = useRef(false);
  const maybeOurs = useRef(false);
  const closers = useRef({});
  closers.current = { onClose: () => { if (!busyRef.current && onClose) onClose({ moved: !!refused || wrote.current }); } };
  useSheetFocus(sheetRef, closers);
  const mounted = useRef(false);
  const openedAt = useRef(Date.now());
  // The hold after close waits one tick, and the effect running again cancels
  // it: StrictMode runs this cleanup once right after mount in development.
  const pendingHold = useRef(null);
  useEffect(() => {
    mounted.current = true;
    clearTimeout(pendingHold.current);
    return () => {
      mounted.current = false;
      pendingHold.current = setTimeout(() => holdTaps(TAP_HOLD_MS), 0);
    };
  }, []);

  const done = () => {
    toast.success('Proposal archived.');
    if (mounted.current) navigate('/proposals', { replace: true });
  };

  const archive = async () => {
    if (busyRef.current || !reason || refused) return;
    if (ARCHIVES_OUT.has(proposal.id)) { setRefused(ARCHIVE_EARLIER); return; }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    ARCHIVES_OUT.add(proposal.id);
    let postedNow = false;
    try {
      let fresh;
      try {
        fresh = await api.get(`/proposals/${proposal.id}`, READ);
      } catch (err) {
        setError(isTransport(err) ? ARCHIVE_OFFLINE : refusalText(err));
        return;
      }
      if (fresh.staleAt) { setError(ARCHIVE_OFFLINE); return; }
      // Back closed the sheet during the read: the admin left, and nothing is posted.
      if (!mounted.current) return;
      if (fresh.data && fresh.data.status === 'archived') {
        if (maybeOurs.current) { done(); return; }
        const label = archiveReasonLabel(fresh.data.archive_reason);
        setRefused(`${SHEET_MOVED} It is archived now${label ? `: ${label}` : ''}.`);
        return;
      }
      const why = sheetRefusal('archive', fresh.data, proposal);
      if (why) { setRefused(why); return; }
      wrote.current = true;
      postedNow = true;
      try {
        await api.post(`/proposals/${proposal.id}/archive`, { scope: 'one', archive_reason: reason });
      } catch (err) {
        // No answer, or a server failure past the payment check (which runs
        // before any write): the archive may have landed.
        const unknown = isTransport(err) || (err.status >= 500 && err.code !== 'EXTERNAL_SERVICE_ERROR');
        maybeOurs.current = unknown;
        if (unknown) setError(ARCHIVE_UNSURE);
        else if (err.code === 'LEGAL_HOLD') setRefused(HOLD_NOTE);
        else setError(refusalText(err));
        return;
      }
      done();
    } finally {
      ARCHIVES_OUT.delete(proposal.id);
      busyRef.current = false;
      setBusy(false);
      if (postedNow && !mounted.current && onLateAnswer) onLateAnswer();
    }
  };

  const closeLabel = refused ? 'Close' : 'Cancel';
  return (
    <>
      <button type="button" className="m-sheet-scrim" aria-label="Close" tabIndex={-1}
        onClick={() => { if (Date.now() - openedAt.current >= TAP_HOLD_MS) closers.current.onClose(); }} />
      <div className="m-sheet" role="dialog" aria-modal="true" aria-label="Archive proposal" tabIndex={-1} ref={sheetRef}>
        <div className="m-sheet-handle" />
        <div className="m-sheet-head">
          <h2 className="m-sheet-title">Archive proposal{proposal.client_name ? <span className="m-sheet-kind"> · {proposal.client_name}</span> : null}</h2>
          <div className="m-sheet-mix">pick a reason · required</div>
        </div>
        <div className={`m-sheet-body${busy ? ' m-sheet-busy' : ''}`}>
          <div role="group" aria-label="Reason">
            {ARCHIVE_REASONS.map((r) => {
              const picked = reason === r.value;
              return (
                <button key={r.value} type="button" className={`m-sheet-row${picked ? ' m-arch-picked' : ''}`}
                  aria-pressed={picked} disabled={busy || !!refused} onClick={() => setReason(r.value)}>
                  <span className="m-arch-label">{r.label}</span>
                  {picked && <Icon name="check" size={16} />}
                </button>
              );
            })}
          </div>
          {refused && (
            <div className="m-sheet-note" role="alert">
              <span className="m-sheet-note-dot" aria-hidden="true" />
              <span className="m-sheet-note-text">{refused}</span>
            </div>
          )}
          {error && (
            <div className="m-fail m-arch-fail" role="alert">
              <span className="m-fail-msg">{error}</span>
              <button type="button" className="m-fail-retry" disabled={busy} onClick={archive}>Retry</button>
            </div>
          )}
        </div>
        <div className="m-acts m-arch-acts">
          <button type="button" className="m-act m-act-quiet" disabled={busy} onClick={() => closers.current.onClose()}>{closeLabel}</button>
          <button type="button" className="m-act m-act-primary" disabled={busy || !reason || !!refused} onClick={archive}>
            {busy ? 'Archiving' : 'Archive proposal'}
          </button>
        </div>
      </div>
    </>
  );
}
