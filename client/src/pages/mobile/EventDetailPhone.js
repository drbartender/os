import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import api from '../../utils/api';
import { offlineGet } from '../../utils/offlineRead';
import useDrawerParam from '../../hooks/useDrawerParam';
import { useMobileView } from '../../context/MobileViewContext';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import AssignmentSheet from '../../components/mobile/AssignmentSheet';
import EditSheet from '../../components/mobile/EditSheet';
import NoteSheet from '../../components/mobile/NoteSheet';
import { ctDay } from '../../components/adminos/format';
import { formatStaleTime } from '../../utils/staleTime';
import { editableEvent } from '../../utils/editSheetView';
import {
  headerOf, whenOf, setupOf, contactsOf, staffingOf, financialsOf, earliestStale, closedWord,
} from '../../utils/eventDetailView';
import { Caret, ContactsSection, MoneySection, EditRow, NoteRow } from './EventDetailSections';

// Phone event detail (spec 2026-08-13-mobile-admin section 4 Detail; benchmark
// docs/design-artifacts/2026-09-15-mobile-admin-shell.dc.html, Event detail).
// Renders INSIDE AdminLayout's scrolling .m-main. The rich header is the
// chrome's: this screen hands it the data through the outlet context.
//
// Four reads, each allowed to fail on its own, each made with offlineGet (they
// may be answered from the phone's cache, and the staleness line says so).
// Only the proposal is the route: when IT is gone or denied, or the :id in the
// URL is not a number, the screen dispatches mobile-route-dead and the chrome
// falls back to /events. It also renders a way back of its own, for the case
// where nobody heard the event. A missing drink plan, a roster this user may
// not see, or an invoices read that did not land each degrade one section.
//
// The assignment sheet opens only for a shift that is one of THIS event's, once
// the roster has loaded. A link cannot open the sheet of another event's shift
// under this event's header.
//
// The drink plan is read ONLY as its day-of-contact projection. The full plan
// carries its token, the internal notes and the venue access notes, and the
// phone needs a name and a number.
//
// Not on the phone in phase 1 (reachable through the Desktop-view escape):
// the activity feed, invite to portal, re-enroll nudges, cancel event, cancel
// line, the Out-of-Area Bonus knob, the drink plan card (the shopping-list
// Approve), payment actions, the message log, the menu print block, BEO
// confirmations, the service-extension panel, the "Last-minute: verify
// staffing" and "No tip jar" badges, the links to the client, the proposal
// and each staffer's profile, the client's source, the syrups line and
// package details, the staff BEO view, the plan logo, the house menu image,
// and the waitlist and requests-on-file counts. In the desktop drawer only:
// equipment and supply-run edits, over-filling a role, editing a past or
// cancelled roster. The Edit details row opens the edit sheet on an upcoming,
// live event and the Desktop view on a past one; the Note row edits the
// internal booking note on every event (lane ma-e3).
const LOAD_FAILED = 'Network error. Check your connection.';
const ROSTERLESS = 'No roles are declared on this shift. Staff it from desktop view.';
// The kinds of drawer that are phone sheets here. Module scope: one identity.
const SHEETS = ['shift', 'edit', 'note'];
const SAVED_BEHIND = 'Saved. The event below could not be refreshed and may be out of date.';
const isDead = (err) => !!err && (err.status === 404 || err.status === 403);
// An id the database can hold. Anything else can never load, all digits or not.
const validId = (id) => /^\d+$/.test(String(id)) && Number(id) >= 1 && Number(id) <= 2147483647;
const DAY_OF = { params: { fields: 'day_of_contact' } };
const FRAC = { open: 'm-frac', full: 'm-frac full', closed: 'm-frac past' };

export default function EventDetailPhone() {
  const { id } = useParams();
  const outlet = useOutletContext() || {};
  const { setHeaderDetail, refreshBadges } = outlet;
  const { setDesktopView } = useMobileView();
  const navigate = useNavigate();
  const drawer = useDrawerParam({ push: true, kinds: SHEETS });
  // The id the screen is showing NOW, for reads that can land after it moved on.
  const showing = useRef(id);
  showing.current = id;

  const [proposal, setProposal] = useState(null);
  const [shifts, setShifts] = useState({ state: 'loading', rows: [] });     // loading | ready | denied | failed
  const [plan, setPlan] = useState({ state: 'loading', row: null });         // loading | ready | none | failed
  const [money, setMoney] = useState({ state: 'loading', payload: null });   // loading | ready | failed
  const [stale, setStale] = useState({});                                    // read name -> cached-at stamp
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dead, setDead] = useState(false);
  const [panes, setPanes] = useState({ contact: false, staffing: true, pay: false });
  const [attempt, setAttempt] = useState(0);
  const [noteDraft, setNoteDraft] = useState(null);
  const [refresh, setRefresh] = useState('idle'); // idle | reading | behind
  const editLatch = useRef(false);
  const noteLatch = useRef(false);

  // The route is dead. The chrome is told, and falls back to /events; the
  // screen also renders a way back of its own. The chrome listens from a layout
  // effect, and React takes those down while a suspended boundary hides the
  // chrome: an event sent then is heard by nobody, and this screen was blank.
  const declareDead = useCallback(() => {
    setDead(true);
    window.dispatchEvent(new CustomEvent('mobile-route-dead'));
  }, []);

  // Every roster read takes a number. An answer goes on screen when it is NEWER THAN WHAT
  // IS THERE and the screen still shows its event, so a read that lands late (an older
  // reload, or another event's) changes nothing. "Newest asked" would be the wrong rule: a
  // newer read that fails would then throw away an older one that succeeded, and the
  // loading line would never leave.
  //   fresh: a first read or a Retry of one. Nothing to keep, so it shows the loading line
  //   and, if it fails, says why there is no roster.
  //   not fresh: the reload after a sheet write, or a Retry of one. It never takes the
  //   phone's stored copy, which is the roster from BEFORE the write. If it fails, or only
  //   a stored copy answers, the roster on screen stays, marked as possibly behind, until an
  //   answer asked for AFTER the failed one lands (an older one can predate the write).
  const asked = useRef(0);
  const applied = useRef(0);
  const failed = useRef(0);
  const readShifts = useCallback((fresh) => {
    asked.current += 1;
    const mine = asked.current;
    const newer = () => mine > applied.current && showing.current === id;
    const lag = () => {
      failed.current = Math.max(failed.current, mine);
      // Nothing on screen: a reload that failed while a fresh read is still
      // out leaves the loading line to that read.
      setShifts((cur) => (cur.state === 'ready' ? { ...cur, behind: true, rereading: false } : cur));
    };
    if (fresh) setShifts({ state: 'loading', rows: [] });
    else setShifts((cur) => (cur.state === 'ready' && cur.behind ? { ...cur, rereading: true } : cur));
    offlineGet(`/shifts/by-proposal/${id}`)
      .then((res) => {
        if (!newer()) return;
        if (!fresh && res.staleAt) { lag(); return; }
        applied.current = mine;
        // forId: the event this roster was read for. The sheet rule below acts
        // only on a roster read for the event on screen.
        setShifts({ state: 'ready', rows: Array.isArray(res.data) ? res.data : [], behind: mine < failed.current, forId: id });
        setStale((prev) => ({ ...prev, shifts: res.staleAt || null }));
      })
      .catch((err) => {
        if (!newer()) return;
        if (!fresh) { lag(); return; }
        failed.current = Math.max(failed.current, mine);
        const refused = err && err.status === 403 ? 'denied' : 'failed';
        setShifts((cur) => (cur.state === 'ready' ? { ...cur, behind: true } : { state: refused, rows: [], forId: id }));
      });
  }, [id]);

  useEffect(() => {
    // A malformed id can never load: say so at once, instead of an error
    // screen whose Retry cannot succeed.
    if (!validId(id)) {
      setLoading(false);
      setProposal(null);
      declareDead();
      return undefined;
    }
    let gone = false;
    const stamp = (name, res) => setStale((prev) => ({ ...prev, [name]: res.staleAt || null }));
    // Clear first: a different event id must never render over the last one.
    setLoading(true); setError(null); setDead(false); setProposal(null); setStale({});
    setPlan({ state: 'loading', row: null });
    setMoney({ state: 'loading', payload: null });

    offlineGet(`/proposals/${id}`)
      .then((res) => {
        if (gone) return;
        setProposal(res.data);
        stamp('proposal', res);
      })
      .catch((err) => {
        if (gone) return;
        if (isDead(err)) { declareDead(); return; }
        setError((err && err.message) || LOAD_FAILED);
      })
      .finally(() => { if (!gone) setLoading(false); });

    readShifts(true);

    offlineGet(`/drink-plans/by-proposal/${id}`, DAY_OF)
      .then((res) => { if (gone) return; setPlan({ state: 'ready', row: res.data }); stamp('plan', res); })
      // 404 is the normal answer for an event whose client has not started a plan.
      .catch((err) => { if (!gone) setPlan({ state: err && err.status === 404 ? 'none' : 'failed', row: null }); });

    offlineGet(`/invoices/proposal/${id}`)
      .then((res) => { if (gone) return; setMoney({ state: 'ready', payload: res.data }); stamp('money', res); })
      .catch(() => { if (!gone) setMoney({ state: 'failed', payload: null }); });

    return () => { gone = true; };
  }, [id, attempt, readShifts, declareDead]);

  // The sheet's onChanged: the roster and the tab badge both moved.
  const reloadShifts = useCallback(() => {
    readShifts(false);
    if (refreshBadges) refreshBadges();
  }, [readShifts, refreshBadges]);

  // After an edit save: the event, the invoices and the roster moved. Never the
  // stored copy, which predates the save. Numbered as readShifts is (see there):
  // an older answer or failure that lands late changes nothing.
  const saved = useRef({ asked: 0, applied: 0, failed: 0 });
  const reloadAfterSave = useCallback(() => {
    const mine = ++saved.current.asked;
    const newer = () => mine > saved.current.applied && showing.current === id;
    setRefresh('reading');
    readShifts(false);
    if (refreshBadges) refreshBadges();
    Promise.all([api.get(`/proposals/${id}`), api.get(`/invoices/proposal/${id}`)])
      .then(([p, inv]) => {
        if (!newer()) return;
        saved.current.applied = mine;
        setProposal(p.data);
        setMoney({ state: 'ready', payload: inv.data });
        setStale((prev) => ({ ...prev, proposal: null, money: null }));
        setRefresh(mine < saved.current.failed ? 'behind' : 'idle');
      })
      .catch(() => { if (newer()) { saved.current.failed = Math.max(saved.current.failed, mine); setRefresh('behind'); } });
  }, [id, readShifts, refreshBadges]);

  useEffect(() => {
    if (!setHeaderDetail) return undefined;
    setHeaderDetail(proposal ? headerOf(proposal) : null);
    return () => setHeaderDetail(null);
  }, [proposal, setHeaderDetail]);

  const when = useMemo(() => (proposal ? whenOf(proposal) : null), [proposal]);
  const setup = useMemo(() => (proposal ? setupOf(proposal) : null), [proposal]);
  const contacts = useMemo(() => (proposal ? contactsOf(proposal, plan.row) : null), [proposal, plan.row]);
  const staffing = useMemo(() => staffingOf(shifts.rows, proposal), [shifts.rows, proposal]);
  const fin = useMemo(() => (proposal ? financialsOf(proposal, money.payload) : null), [proposal, money.payload]);

  const staleAt = earliestStale(stale.proposal, stale.shifts, stale.plan, stale.money);
  const cachedTime = formatStaleTime(staleAt);
  const cancelled = !!proposal && proposal.status === 'archived';
  const toggle = (key) => setPanes((prev) => ({ ...prev, [key]: !prev[key] }));

  // The sheet parameter, and whether it names a shift of THIS event. Judged
  // only on a roster read for the event on screen (`forId`).
  const wanted = drawer.kind === 'shift' ? String(drawer.id || '') : null;
  const settled = shifts.forId === id && (shifts.state === 'ready' || shifts.state === 'denied');
  const sheetOpen = wanted !== null && /^\d+$/.test(wanted) && settled && shifts.state === 'ready'
    && shifts.rows.some((row) => Number(row.id) === Number(wanted));
  // A parameter that can open no sheet here is dropped: a shift of another
  // event, an id that is not a number, a user with no staffing access. While
  // the roster is loading, or failed and may be retried, the parameter waits.
  const closeDrawer = drawer.close;
  useEffect(() => {
    if (wanted !== null && settled && !sheetOpen) closeDrawer();
  }, [wanted, settled, sheetOpen, closeDrawer]);
  // What the page already knows about the sheet's shift: open, so the sheet
  // reads the staff list at once instead of a round behind its own roster.
  const sheetGroup = sheetOpen ? staffing.groups.find((g) => Number(g.shiftId) === Number(wanted)) : null;
  const assignable = !!sheetGroup && !sheetGroup.view.closedReason && !sheetGroup.view.rosterless
    && sheetGroup.view.open > 0;

  // The edit and note sheets. Both rows' taps, and both sheets, wait for every read the
  // gate needs: the roster says whether the event has finished (by date alone, a link to an
  // event that ended today opens), and a cached drink plan or invoices answer would shut a
  // sheet on the edits. A parameter neither sheet can open (another event, a past one, a
  // stored copy) is dropped once those reads settle. The latches keep an open sheet open:
  // the edit sheet's past the event turning past; the note sheet's past everything, a later
  // stale stamp included, as it reads and re-reads fresh on its own.
  const editable = !!proposal && !cancelled && editableEvent(proposal, shifts, ctDay(new Date()));
  const editMode = staleAt ? 'offline' : (editable ? 'edit' : 'desktop');
  const readsSettled = shifts.forId === id && shifts.state !== 'loading' && plan.state !== 'loading' && money.state !== 'loading';
  const forThis = drawer.id !== null && String(drawer.id) === String(id);
  const editOpen = drawer.kind === 'edit' && forThis && !staleAt && readsSettled && (editable || editLatch.current);
  editLatch.current = editOpen;
  const noteOpen = drawer.kind === 'note' && forThis && (noteLatch.current || (!staleAt && readsSettled));
  noteLatch.current = noteOpen;
  useEffect(() => {
    if (!proposal || !readsSettled) return;
    if ((drawer.kind === 'edit' && !editOpen) || (drawer.kind === 'note' && !noteOpen)) closeDrawer();
  }, [proposal, readsSettled, drawer.kind, editOpen, noteOpen, closeDrawer]);
  // The two sheets' closers. A save holds the closer from the render where Save was tapped;
  // if Back closed the sheet meanwhile, that drawer.close would pop a second entry and leave
  // the event. So a closer acts only while the URL shows its sheet, via the latest close.
  const live = useRef({ kind: null, close: null });
  live.current = { kind: drawer.kind, close: drawer.close };
  const closeIfShowing = useCallback((kind) => { if (live.current.kind === kind) live.current.close(); }, []);

  if (dead) {
    return (
      <div className="m-empty">
        <div className="m-empty-title">This event isn't available</div>
        <div className="m-empty-body">It may have been removed, or your access may have changed.</div>
        <button type="button" className="m-retry-btn" onClick={() => navigate('/events', { replace: true })}>Back to Events</button>
      </div>
    );
  }
  if (loading && !proposal) return <div className="m-sheet-state">Loading the event</div>;
  if (error && !proposal) {
    return (
      <div className="m-empty" role="alert">
        <div className="m-empty-title">Couldn't load this event</div>
        <div className="m-empty-body">{error}</div>
        <button type="button" className="m-retry-btn" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
      </div>
    );
  }
  if (!proposal) return null;

  return (
    <div>
      {/* Only an offline copy says how old it is (Dallas, 2026-09-30). */}
      {cachedTime && (
        <div className="m-stale">
          <span className="m-stale-dot" aria-hidden="true" />
          <span>offline copy · as of <span className="m-stale-time">{cachedTime}</span></span>
          <button type="button" className="m-fail-retry" onClick={() => setAttempt((n) => n + 1)}>Refresh</button>
        </div>
      )}
      {refresh === 'behind' && (
        <div className="m-fail m-saved-behind" role="alert">
          <span className="m-fail-msg">{SAVED_BEHIND}</span>
          <button type="button" className="m-fail-retry" onClick={reloadAfterSave}>Retry</button>
        </div>
      )}

      <div className="m-detail-when">
        <div className="m-detail-whenline">
          {when.text}
          {cancelled && <StatusChip kind="neutral">{closedWord(proposal)}</StatusChip>}
          {!cancelled && when.isToday && <StatusChip kind="accent">Today</StatusChip>}
          {/* The client paid to skip the tip jar, so staff must not set one out.
              The desktop's badge, on the day-of device (Dallas, 2026-09-30). */}
          {!cancelled && proposal.tip_jar === false && <StatusChip kind="warn">No tip jar</StatusChip>}
        </div>
        {setup && <div className="m-detail-setup">{`setup ${setup}`}</div>}
      </div>

      <ContactsSection
        open={panes.contact}
        onToggle={() => toggle('contact')}
        contacts={contacts}
        planState={plan.state}
        clientName={proposal.client_name}
      />

      <section className="m-section">
        <button type="button" className="m-section-row" aria-expanded={panes.staffing} onClick={() => toggle('staffing')}>
          <Icon name="userplus" size={20} />
          <span className="m-section-name">Staffing</span>
          {staffing.count && <span className={FRAC[staffing.state]}>{staffing.count}</span>}
          <Caret open={panes.staffing} />
        </button>
        {panes.staffing && (
          <>
            {shifts.state === 'loading' && <div className="m-section-note">Loading the roster</div>}
            {shifts.state === 'denied' && <div className="m-section-note">Staffing needs staffing access.</div>}
            {shifts.state === 'failed' && (
              <div className="m-fail" role="alert">
                <span className="m-fail-msg">Couldn't load staffing.</span>
                <button type="button" className="m-fail-retry" onClick={() => readShifts(true)}>Retry</button>
              </div>
            )}
            {shifts.state === 'ready' && shifts.behind && (
              <div className="m-fail" role="alert">
                <span className="m-fail-msg">Couldn't refresh staffing. The roster below may be out of date.</span>
                <button type="button" className="m-fail-retry" disabled={!!shifts.rereading}
                  onClick={() => readShifts(false)}>{shifts.rereading ? 'Retrying' : 'Retry'}</button>
              </div>
            )}
            {shifts.state === 'ready' && staffing.groups.length === 0 && (
              <div className="m-section-note">No shifts created for this event yet.</div>
            )}
            {shifts.state === 'ready' && staffing.groups.map((g) => (
              <div key={g.shiftId}>
                {g.showHead && (
                  <div className="m-shift-head">
                    <span className="m-shift-label">{g.label}</span>
                    {g.view.closedReason !== 'cancelled' && (
                      <span className={FRAC[g.view.closedReason ? 'closed' : g.view.full ? 'full' : 'open']}>{g.view.count}</span>
                    )}
                  </div>
                )}
                {g.view.rows.map((row) => (
                  <button key={row.key} type="button" className="m-section-item m-person"
                    onClick={() => drawer.open('shift', g.shiftId, { focus: row.userId })}>
                    <span className={`m-avatar${row.kind === 'rostered' ? '' : ' m-avatar-app'}`} aria-hidden="true">{row.initials}</span>
                    <span className="m-person-main">
                      <span className="m-person-name">{row.name}</span>
                      {row.meta ? <span className="m-person-meta">{row.meta}</span> : null}
                    </span>
                    {row.kind === 'applicant' && <StatusChip kind="warn">Pending</StatusChip>}
                    {row.kind === 'waitlisted' && <StatusChip kind="neutral">Waitlisted</StatusChip>}
                    {row.kind === 'rostered' && <span className="m-person-check"><Icon name="check" size={16} /></span>}
                  </button>
                ))}
                {!g.view.closedReason && !g.view.rosterless && g.view.open > 0 && (
                  <button type="button" className="m-section-item m-assign-row" onClick={() => drawer.open('shift', g.shiftId)}>
                    <Icon name="userplus" size={18} />
                    {`Assign staff · ${g.view.open} open`}
                  </button>
                )}
                {!g.view.closedReason && g.view.rosterless && (
                  <div className="m-section-note">{ROSTERLESS}</div>
                )}
              </div>
            ))}
          </>
        )}
      </section>

      <MoneySection
        open={panes.pay}
        onToggle={() => toggle('pay')}
        fin={fin}
        moneyState={money.state}
      />

      <NoteRow note={proposal.admin_notes} offline={!!staleAt} held={!readsSettled} onOpen={() => drawer.open('note', proposal.id)} />

      {!cancelled && (
        <EditRow mode={editMode} held={!readsSettled} onEdit={() => drawer.open('edit', proposal.id)}
          onDesktop={() => setDesktopView('event-detail', true)} />
      )}

      {sheetOpen && (
        <AssignmentSheet
          key={drawer.id}
          shiftId={Number(drawer.id)}
          focusUserId={drawer.focus}
          assignable={assignable}
          onClose={drawer.close}
          onChanged={reloadShifts}
          onDead={drawer.close}
        />
      )}
      {/* Every shift, cancelled included: a save moves a shift only when there is exactly one (syncShiftsFromProposal). */}
      {editOpen && (
        <EditSheet
          proposalId={proposal.id}
          clientName={proposal.client_name}
          kind={headerOf(proposal).kind}
          shiftCount={shifts.state === 'ready' ? shifts.rows.length : 0}
          onClose={() => closeIfShowing('edit')}
          onSaved={() => { closeIfShowing('edit'); reloadAfterSave(); }}
        />
      )}
      {noteOpen && (
        <NoteSheet
          proposalId={proposal.id}
          draft={noteDraft}
          onDraft={setNoteDraft}
          onSaved={(note) => setProposal((p) => (p ? { ...p, admin_notes: note } : p))}
          onClose={() => closeIfShowing('note')}
        />
      )}
    </div>
  );
}
