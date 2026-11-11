// ProposalDetailPhone: the phone proposal detail at /proposals/:id, inside the phone chrome
// (spec 2026-08-13-mobile-admin section 5 Detail; benchmark Proposal detail, 2026-10-14 shell).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import api from '../../utils/api';
import { offlineGet } from '../../utils/offlineRead';
import { useMobileView } from '../../context/MobileViewContext';
import useDrawerParam from '../../hooks/useDrawerParam';
import { useToast } from '../../context/ToastContext';
import Icon from '../../components/adminos/Icon';
import ResendSheet from '../../components/mobile/ResendSheet';
import ArchiveSheet from '../../components/mobile/ArchiveSheet';
import EditSheet from '../../components/mobile/EditSheet';
import StatusChip from '../../components/adminos/StatusChip';
import { formatStaleTime } from '../../utils/staleTime';
import { whenOf } from '../../utils/eventDetailView';
import { READ_TIMEOUT_MS } from '../../utils/editSheetView';
import {
  bookedTarget, proposalHeaderOf, proposalContactsOf, statusLineOf, chipOf, packageOf, gatesOf, HOLD_NOTE,
} from '../../utils/proposalDetailView';
import { Caret, ContactsSection, EditRow } from './EventDetailSections';

// Benchmark: docs/design-artifacts/2026-10-14-mobile-admin-shell.dc.html,
// Proposal detail; where the spec's Plan decisions of 2026-11-05 differ, they
// are the contract. Renders INSIDE AdminLayout's scrolling .m-main; the rich
// header is the chrome's, handed over through the outlet context.
//
// GET /proposals/:id through offlineGet: the screen renders the staleness
// line, and on a stored copy every row that acts reads "needs connection". The
// Client link needs no server, so it works on a stored copy. Beside it,
// GET /proposals/:id/change-requests through api.get, never stored (a request
// holds the client's own words): a pending request, on a fresh and unheld
// read, puts a "Change request · desktop view" row at the top, since the
// request is reviewed and applied only on the desktop page, and every way to a
// request (the Review link, the Overview queue item, the admin email) links to
// the bare proposal. A request read that fails, or is still out 4 seconds
// after a fresh proposal answer, shows no row, and a stored copy never waits
// for it.
// A booked proposal opens the event detail at the same id, with history
// replaced, unless a change request is pending (it stays here to show the row)
// or the event detail is in Desktop view: then this visit shows the desktop
// proposal page, where the desktop event page's link to it leads. A link into
// desktop-only work (?edit=1 from the Alternatives panel, a change_request_id)
// also opens the desktop page for the visit. A visit ends when the user leaves
// or taps Phone view. A malformed id, a 404 or a 403 shows "This proposal
// isn't available" with Back to Proposals when an in-app page is behind it; on
// a cold launch or a resume, with nothing behind it, it dispatches
// mobile-route-dead and the chrome falls back to /events (spec section 9).
//
// Resend proposal and Archive open their phone sheets (ResendSheet,
// ArchiveSheet) as pushed history entries, so Android's Back closes them. A
// sheet opens only on a fresh read whose row offers it, and a parameter that
// can open none here is dropped once the read settles; each sheet reads the
// proposal fresh again before it writes. A sheet that posted or refused has the
// page read the proposal again once it is gone, Back included, and an archive
// whose answer comes after Back does too. A read waits while a sheet is open:
// the read clears the screen, which would unmount the sheet and mount it
// fresh, and a resend sheet that came back fresh would offer Send again for a
// message already sent. It runs as the sheet closes. Edit details opens the
// phone edit sheet in its proposal variant (EditSheet) on a fresh read the gate
// allows (an open, unheld, ungrouped proposal dated today or later), and
// desktop view otherwise. Once the sheet's write has gone out (answered or
// not), or the sheet refused because the row moved, the page reads the proposal
// again as the sheet closes, Back included, with a plain read that gives up
// after the sheets' read timeout, never the stored copy, so the screen shows
// what the save wrote; a failed read's Retry stays a plain read until one
// lands. Send proposal (a draft or a modified proposal: the first send runs the
// remote staffing fee check) and anything an options group sends stay on
// desktop view for good. No Send reminder row (the owner, 2026-11-05: "leave it
// off").
const LOAD_FAILED = 'Network error. Check your connection.';
// The kinds of drawer that are phone sheets here. Module scope: one identity.
const SHEETS = ['resend', 'archive', 'edit'];
const isDead = (err) => !!err && (err.status === 404 || err.status === 403);
// The change-requests read is live and the worker never races it, so on weak
// signal it could hang for minutes. It is never aborted: an answer that comes
// before the proposal's always counts. Once a fresh proposal is in, the screen
// waits at most this long more for it, then counts it as no request.
const REQUEST_GRACE_MS = 4000;
const withinGrace = (read) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), REQUEST_GRACE_MS);
  read.then((value) => { clearTimeout(timer); resolve(value); });
});
// An id the database can hold. Anything else can never load, all digits or not.
const validId = (id) => /^\d+$/.test(String(id)) && Number(id) >= 1 && Number(id) <= 2147483647;
// A link into desktop-only work on a proposal: the editor (?edit=1, the
// Alternatives panel's new-option link) or a change request being applied.
const wantsDesktop = (search) => {
  const params = new URLSearchParams(search || '');
  return params.get('edit') === '1' || params.has('change_request_id');
};
const hasPendingRequest = (payload) => !!payload && Array.isArray(payload.requests)
  && payload.requests.some((r) => !!r && r.status === 'pending');

// The fork in ProposalDetail.js: whether /proposals/:id renders this screen.
// At phone width it does, unless the screen is in Desktop view (sticky, or for
// one visit).
export function usePhoneFork() {
  const { isPhone, desktopView } = useMobileView();
  return isPhone && !desktopView('proposal-detail');
}
// Whether an in-app page sits behind this one in history (the router's index).
const pageBehind = () => !!(window.history.state && window.history.state.idx > 0);

// A row of the action card. 'offline' takes no tap and says why; 'sheet'
// opens its phone sheet and, as drawn, carries no note; 'desktop' says where
// it goes.
function ActionRow({ icon, label, mode, sep, onSheet, onDesktop }) {
  return (
    <button type="button" className={`m-section-row${sep ? ' m-section-row-sep' : ''}`}
      disabled={mode === 'offline'} onClick={mode === 'sheet' ? onSheet : onDesktop}>
      <Icon name={icon} size={20} />
      <span className="m-section-name m-row-label">{label}</span>
      {mode === 'sheet' ? null : mode === 'offline' ? (
        <span className="m-edit-note m-edit-note-locked m-row-note"><span className="m-stale-dot" aria-hidden="true" />needs connection</span>
      ) : (
        <>
          <span className="m-edit-note">desktop view</span>
          <span className="m-section-caret" aria-hidden="true"><Icon name="right" size={16} /></span>
        </>
      )}
    </button>
  );
}

export default function ProposalDetailPhone() {
  const { id } = useParams();
  const { setHeaderDetail } = useOutletContext() || {};
  const mobileView = useMobileView();
  const { setDesktopView } = mobileView;
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const drawer = useDrawerParam({ push: true, kinds: SHEETS });
  // Read inside the load's answer, which must not re-run when they change.
  const latest = useRef({ mobileView, location });
  latest.current = { mobileView, location };

  const [proposal, setProposal] = useState(null);
  const [staleAt, setStaleAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dead, setDead] = useState(false);
  const [panes, setPanes] = useState({ contact: false, pay: false });
  const [attempt, setAttempt] = useState(0);
  const [requestPending, setRequestPending] = useState(false);
  // The next read after the edit sheet wrote (or refused) is a plain fresh read
  // until one lands: the stored copy the worker could serve on weak signal
  // predates the save.
  const freshNext = useRef(false);

  // The desktop proposal page for this visit only: armed before the navigation
  // it is for, the visit starts on the replaced entry, which the fork draws as
  // the desktop body (MobileViewContext's setDesktopForVisit). It ends when the
  // user leaves the page or taps Phone view.
  const openDesktopHere = useCallback(() => {
    const { mobileView: mv, location: here } = latest.current;
    mv.setDesktopForVisit('proposal-detail');
    navigate(`${here.pathname}${here.search}`, { replace: true });
  }, [navigate]);

  // The chrome listens from a layout effect and sends a dead route to /events.
  // With an in-app page behind, the screen says so itself and offers Back to
  // Proposals; with nothing behind (a cold launch, a resume) the chrome is
  // told. The screen renders its way back either way, for when nobody hears.
  const declareDead = useCallback(() => {
    setDead(true);
    if (!pageBehind()) window.dispatchEvent(new CustomEvent('mobile-route-dead'));
  }, []);

  useEffect(() => {
    if (!validId(id)) {
      setLoading(false);
      setProposal(null);
      declareDead();
      return undefined;
    }
    if (wantsDesktop(latest.current.location.search)) {
      openDesktopHere();
      return undefined;
    }
    let gone = false;
    // Clear first: a different proposal must never render over the last one.
    setLoading(true); setError(null); setDead(false); setProposal(null); setStaleAt(null); setRequestPending(false);
    // Both reads start together. A stored copy shows no request row, so it never
    // waits on the request read: on weak signal the worker serves the copy at its
    // stall window, and the screen shows it then (spec section 7).
    const requestRead = api.get(`/proposals/${id}/change-requests`).then((r) => r.data, () => null);
    const fresh = freshNext.current;
    const read = fresh ? (url) => api.get(url, { timeout: READ_TIMEOUT_MS }) : offlineGet;
    read(`/proposals/${id}`)
      .then((res) => (res.staleAt ? [res, null] : withinGrace(requestRead).then((requests) => [res, requests])))
      .then(([res, requests]) => {
        if (gone) return;
        if (fresh) freshNext.current = false;
        const pending = !res.staleAt && !!res.data && res.data.legal_hold === false && hasPendingRequest(requests);
        const target = bookedTarget(res.data);
        if (target && !pending) {
          if (latest.current.mobileView.desktopView('event-detail')) openDesktopHere();
          else navigate(target, { replace: true });
          return;
        }
        setProposal(res.data);
        setStaleAt(res.staleAt || null);
        setRequestPending(pending);
      })
      .catch((err) => {
        if (gone) return;
        if (isDead(err)) { declareDead(); return; }
        setError((err && err.message) || LOAD_FAILED);
      })
      .finally(() => { if (!gone) setLoading(false); });
    return () => { gone = true; };
  }, [id, attempt, declareDead, navigate, openDesktopHere]);

  useEffect(() => {
    if (!setHeaderDetail) return undefined;
    setHeaderDetail(proposal ? proposalHeaderOf(proposal) : null);
    return () => setHeaderDetail(null);
  }, [proposal, setHeaderDetail]);

  const view = useMemo(() => (proposal ? {
    when: whenOf(proposal),
    status: statusLineOf(proposal),
    chip: chipOf(proposal),
    contacts: proposalContactsOf(proposal),
    pkg: packageOf(proposal),
    gates: gatesOf(proposal, { stale: !!staleAt, requestPending }),
  } : null), [proposal, staleAt, requestPending]);

  // The sheets. Each opens only for this proposal, on a fresh read whose row
  // offers it; a parameter that can open neither (another proposal, a stored
  // copy, a row the proposal does not offer) is dropped once the read settles.
  const forThis = drawer.id !== null && String(drawer.id) === String(id);
  const resendOpen = drawer.kind === 'resend' && forThis && !!view && !!view.gates.send && view.gates.send.mode === 'sheet';
  const archiveOpen = drawer.kind === 'archive' && forThis && !!view && !!view.gates.archive && view.gates.archive.mode === 'sheet';
  const editOpen = drawer.kind === 'edit' && forThis && !!view && !!view.gates.edit && view.gates.edit.mode === 'edit';
  const closeDrawer = drawer.close;
  useEffect(() => {
    if (loading) return;
    if ((drawer.kind === 'resend' && !resendOpen) || (drawer.kind === 'archive' && !archiveOpen)
      || (drawer.kind === 'edit' && !editOpen)) closeDrawer();
  }, [loading, drawer.kind, resendOpen, archiveOpen, editOpen, closeDrawer]);
  // A sheet's closer acts only while the URL still shows that sheet: if Back
  // closed it meanwhile, a second close would pop the page itself.
  const sheetOpen = resendOpen || archiveOpen || editOpen;
  const live = useRef({ kind: null, close: null, sheetOpen: false });
  live.current = { kind: drawer.kind, close: drawer.close, sheetOpen };
  // A read asked for while a sheet is open waits for it to close (header).
  const readDue = useRef(false);
  const readAgain = useCallback(() => {
    if (live.current.sheetOpen) readDue.current = true;
    else setAttempt((n) => n + 1);
  }, []);
  useEffect(() => {
    if (sheetOpen || !readDue.current) return;
    readDue.current = false;
    setAttempt((n) => n + 1);
  }, [sheetOpen]);
  const sheetClosed = useCallback((kind, { moved = false } = {}) => {
    if (live.current.kind === kind) {
      live.current.close();
      if (moved) readDue.current = true;
    } else if (moved) {
      readAgain();
    }
  }, [readAgain]);

  const toDesktop = () => setDesktopView('proposal-detail', true);
  const toggle = (key) => setPanes((prev) => ({ ...prev, [key]: !prev[key] }));

  // The Android share sheet, else the clipboard. Dismissing the share sheet is
  // not a failure.
  const shareLink = (url) => {
    const copy = () => {
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        toast.error("Couldn't copy the link.");
        return;
      }
      navigator.clipboard.writeText(url)
        .then(() => toast.success('Link copied.'))
        .catch(() => toast.error("Couldn't copy the link."));
    };
    if (typeof navigator.share !== 'function') { copy(); return; }
    // Called in the tap itself: the share sheet needs the tap's activation.
    let shared;
    try { shared = navigator.share({ url }); } catch { copy(); return; }
    Promise.resolve(shared).catch((err) => { if (!err || err.name !== 'AbortError') copy(); });
  };

  if (dead) {
    return (
      <div className="m-empty">
        <div className="m-empty-title">This proposal isn't available</div>
        <div className="m-empty-body">It may have been removed, or your access may have changed.</div>
        <button type="button" className="m-retry-btn" onClick={() => navigate('/proposals', { replace: true })}>Back to Proposals</button>
      </div>
    );
  }
  if (loading && !proposal) return <div className="m-sheet-state">Loading the proposal</div>;
  if (error && !proposal) {
    return (
      <div className="m-empty" role="alert">
        <div className="m-empty-title">Couldn't load this proposal</div>
        <div className="m-empty-body">{error}</div>
        <button type="button" className="m-retry-btn" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
      </div>
    );
  }
  if (!proposal || !view) return null;

  const cachedTime = formatStaleTime(staleAt);
  const { gates, pkg } = view;

  return (
    <div>
      {cachedTime && (
        <div className="m-stale">
          <span className="m-stale-dot" aria-hidden="true" />
          <span>offline copy · as of <span className="m-stale-time">{cachedTime}</span></span>
          <button type="button" className="m-fail-retry" onClick={() => setAttempt((n) => n + 1)}>Refresh</button>
        </div>
      )}

      <div className="m-detail-when">
        <div className="m-detail-whenline">
          {view.when.text}
          <StatusChip kind={view.chip.kind}>{view.chip.label}</StatusChip>
        </div>
        <div className="m-detail-status">{view.status}</div>
      </div>

      {gates.held && (
        <div className="m-sheet-note m-hold-note" role="note">
          <span className="m-sheet-note-dot" aria-hidden="true" />
          <span className="m-sheet-note-text">{HOLD_NOTE}</span>
        </div>
      )}

      {requestPending && (
        <section className="m-section">
          <ActionRow icon="alert" label="Change request" mode="desktop" onDesktop={toDesktop} />
        </section>
      )}

      <ContactsSection
        open={panes.contact}
        onToggle={() => toggle('contact')}
        contacts={view.contacts}
        planState="none"
        clientName={proposal.client_name}
        dayOf={false}
      />

      <section className="m-section">
        <button type="button" className="m-section-row" aria-expanded={panes.pay} onClick={() => toggle('pay')}>
          <Icon name="dollar" size={20} />
          <span className="m-section-name">Package &amp; extras</span>
          <span className="m-section-num">{pkg.total}</span>
          <Caret open={panes.pay} />
        </button>
        {panes.pay && (
          <>
            {pkg.lines.map((line, i) => (
              <div className="m-money-row m-money-line" key={`${line.label}-${i}`}>
                <span className="m-money-main">
                  <span className="m-money-label">{line.label}</span>
                  {line.hidden && <span className="chip muted m-money-tag">hidden from client</span>}
                </span>
                <span className="m-money-amt">{line.amount}</span>
              </div>
            ))}
            <div className="m-money-row m-money-total">
              <span className="m-money-main"><span className="m-money-label">Total</span></span>
              <span className="m-money-amt">{pkg.total}</span>
            </div>
          </>
        )}
      </section>

      {gates.edit && (
        <EditRow mode={gates.edit.mode} sub="date · guests · add-ons"
          onEdit={() => drawer.open('edit', proposal.id)} onDesktop={toDesktop}>
          {gates.link && (
            <button type="button" className="m-section-row m-section-row-sep" disabled={!gates.link.url}
              onClick={() => shareLink(gates.link.url)}>
              <Icon name="external" size={20} />
              <span className="m-section-name m-row-label">Client link</span>
              {gates.link.url ? (
                <span className="m-link-text">
                  <span className="m-link-host">{gates.link.host}</span>
                  <span className="m-link-path">{gates.link.path}</span>
                </span>
              ) : <span className="m-link-text">{gates.link.text}</span>}
            </button>
          )}
        </EditRow>
      )}

      {(gates.send || gates.archive) && (
        <section className="m-section">
          {gates.send && (
            <ActionRow icon="mail" label={gates.send.label} mode={gates.send.mode}
              onSheet={() => drawer.open('resend', proposal.id)} onDesktop={toDesktop} />
          )}
          {gates.archive && (
            <ActionRow icon="clipboard" label={gates.archive.label} mode={gates.archive.mode} sep={!!gates.send}
              onSheet={() => drawer.open('archive', proposal.id)} onDesktop={toDesktop} />
          )}
        </section>
      )}

      {resendOpen && (
        <ResendSheet proposal={proposal} onClose={(how) => sheetClosed('resend', how)} onLateAnswer={readAgain}
          onDesktop={() => { sheetClosed('resend'); toDesktop(); }} />
      )}
      {archiveOpen && (
        <ArchiveSheet proposal={proposal} onClose={(how) => sheetClosed('archive', how)} onLateAnswer={readAgain} />
      )}
      {editOpen && (
        <EditSheet
          variant="proposal"
          proposalId={proposal.id}
          clientName={proposal.client_name}
          kind={proposalHeaderOf(proposal).kind}
          onClose={() => sheetClosed('edit')}
          onMoved={() => { freshNext.current = true; readAgain(); }}
          onSaved={() => { freshNext.current = true; sheetClosed('edit', { moved: true }); }}
        />
      )}
    </div>
  );
}
