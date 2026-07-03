import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import api from '../../utils/api';
import ShiftCard from '../../components/staff/ShiftCard';
import LogisticsTag from '../../components/staff/LogisticsTag';
import RequestSheet from '../../components/staff/RequestSheet';
import { getEventTypeLabel } from '../../utils/eventTypes';
import {
  parsePositionsNeeded,
  rosterCounts,
  computeRemaining,
  classifyRequest,
  isEventFullyStaffed,
  CANONICAL_LABELS,
} from '../../utils/staffingRoles';
import ShiftDetail from './ShiftDetail';

const SUB_TABS = ['available', 'all', 'mine', 'past'];

/**
 * True when an open-shift feed row still has at least one unfilled role.
 * Available shows these; All shows every open event (full or not). Both
 * source the same /shifts feed (fully-staffed events stay status='open').
 */
function isShiftAvailable(row) {
  const needed = parsePositionsNeeded(row.positions_needed);
  // An empty/malformed roster (legacy or manually-created rows) still needs a
  // bartender by default, so treat it as available. isEventFullyStaffed({}) is
  // vacuously true, which would otherwise drop these rows from Available.
  if (needed.length === 0) return true;
  const remaining = computeRemaining(
    needed,
    row.approved_by_role && typeof row.approved_by_role === 'object' ? row.approved_by_role : {}
  );
  return !isEventFullyStaffed(remaining);
}

/**
 * ShiftsPage — staff portal v2 (spec §6.3).
 *
 * URL-driven sub-tab selector. Four sub-routes share one page:
 *   /shifts/available — open events with at least one unfilled role
 *   /shifts/all       — every open event (full ones included; join a waitlist)
 *   /shifts/mine      — pending / waitlisted + upcoming approved
 *   /shifts/past      — completed / past approved
 *
 * Available and All source the SAME open-shift feed (GET /api/shifts staff
 * path); a fully-staffed event stays status='open', so the only difference
 * is a client-side filter (isShiftAvailable) that drops fully-staffed rows
 * from Available. Per-role fill comes from positions_needed + approved_by_role.
 *
 * Mounted from App.js as `<Route path="shifts/*">`. The component reads the
 * sub-tab segment from useParams() so the active sub-tab survives reload,
 * direct link, and back/forward navigation. A bare /shifts URL
 * redirects to /available to give every load a deterministic landing tab.
 *
 * Action surface per sub-tab:
 *   - Available / All: open-shift rows with a per-role fill line + logistics
 *     tag. Cover-needed rows show the accent border + inline banner +
 *     "Cover this" → POST /api/shifts/requests/:shiftId/claim-cover. Plain
 *     open rows open the RequestSheet (ranked roles + transport ack), which
 *     POSTs { requested_positions, transport_acknowledged } to
 *     /api/shifts/:id/request. A fully-staffed event shows "Join waitlist".
 *   - Mine: pending rows (faded) with a "Withdraw" button →
 *     DELETE /api/shifts/requests/:requestId. Approved upcoming rows use
 *     ShiftCard with `showConfirmFlag` and navigate into ShiftDetail.
 *   - Past: ShiftCard with `variant='past'` and the payout-line total in
 *     the foot. Tapping a row opens PayoutDetail at the matching shift
 *     line (per spec §6.3 — NOT ShiftDetail).
 *
 * Async-state coverage (spec §6.1.5):
 *   - Loading: skeleton placeholder list on first fetch.
 *   - Error: inline error card with Retry; the hero + sub-tab seg stay
 *     visible so the user can switch tabs to recover.
 *   - Empty: per-tab spec copy.
 */
export default function ShiftsPage() {
  const params = useParams();
  // The mount path is `shifts/*` so the dynamic segment lives at params['*'].
  // Numeric first segment → render ShiftDetail (the `:shiftId` route lives
  // under the same parent block per the spec §6.1 URL table; see App.js).
  // Sub-tab segment → render the tab body. Anything else → /available.
  const wildcard = params['*'] || '';
  const segment = wildcard.split('/')[0];

  if (segment && /^\d+$/.test(segment)) {
    return <ShiftDetail />;
  }
  if (!segment || !SUB_TABS.includes(segment)) {
    return <Navigate to="/shifts/available" replace />;
  }
  return <ShiftsPageBody subTab={segment} />;
}

function ShiftsPageBody({ subTab }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const toast = useToast();

  // Each sub-tab maintains its own data + loading/error state so switching
  // away and back doesn't blank the screen. Available + mine + past use
  // different endpoints (see fetchTab below).
  const [openShifts, setOpenShifts] = useState(null);
  const [openLoading, setOpenLoading] = useState(false);
  const [openError, setOpenError] = useState(null);
  const [userEvents, setUserEvents] = useState(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState(null);

  // Per-row in-flight tracker for actions. Keyed by request_id (withdraw)
  // or shift_id (cover claim / request). When the same row fires twice
  // before the response, the button stays disabled until the first round
  // trip resolves.
  const [busyKey, setBusyKey] = useState(null);

  // The open RequestSheet target (an open-shift feed row), or null. Requesting
  // a plain open shift now goes through the ranked-role + transport-ack sheet
  // (the request endpoint requires requested_positions), not a bare POST.
  const [requestTarget, setRequestTarget] = useState(null);

  const fetchAvailable = useCallback(async () => {
    setOpenLoading(true);
    setOpenError(null);
    try {
      const res = await api.get('/shifts');
      setOpenShifts(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      setOpenError(err?.message || 'Could not load open shifts.');
    } finally {
      setOpenLoading(false);
    }
  }, []);

  const fetchUserEvents = useCallback(async () => {
    if (!user?.id) return;
    setEventsLoading(true);
    setEventsError(null);
    try {
      const res = await api.get(`/shifts/user/${user.id}/events`);
      setUserEvents(res.data || { upcoming: [], past: [] });
    } catch (err) {
      setEventsError(err?.message || 'Could not load your shifts.');
    } finally {
      setEventsLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    // Available + All share the open-shift feed.
    if (subTab === 'available' || subTab === 'all') fetchAvailable();
    if (subTab === 'mine' || subTab === 'past') fetchUserEvents();
  }, [subTab, fetchAvailable, fetchUserEvents]);

  // Derived rows (memo-free — these are cheap projections, the data is
  // small, and re-deriving each render keeps the read path simple).
  const upcoming = Array.isArray(userEvents?.upcoming) ? userEvents.upcoming : [];
  const past = Array.isArray(userEvents?.past) ? userEvents.past : [];
  const allOpenShifts = Array.isArray(openShifts) ? openShifts : [];
  // Available = open events with at least one unfilled role. All = every open
  // event (full ones included, so a staffer can join a waitlist). Both derive
  // from the same feed; the only difference is this client-side filter.
  const availableShifts = allOpenShifts.filter(isShiftAvailable);
  // Separate pending requests (from the user-events endpoint isn't where they
  // live — pending live on /shifts via my_request_id+my_request_status).
  // Pending requests on Mine come from /shifts where my_request_status is
  // pending; the user-events endpoint only returns approved rows. Refetch
  // /shifts when switching to Mine so the pending bucket is populated.
  const [myRequestPending, setMyRequestPending] = useState([]);

  useEffect(() => {
    if (subTab !== 'mine') return;
    let cancelled = false;
    api.get('/shifts')
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res.data) ? res.data : [];
        setMyRequestPending(list.filter((s) => s.my_request_status === 'pending'));
      })
      .catch(() => {
        // Non-fatal — the upcoming list still renders; just no pending bucket.
        if (!cancelled) setMyRequestPending([]);
      });
    return () => { cancelled = true; };
  }, [subTab]);

  // ── Actions ──────────────────────────────────────────────────────────

  async function withdrawRequest(requestId, isWaitlisted = false) {
    if (!requestId) return;
    setBusyKey(`req:${requestId}`);
    try {
      await api.delete(`/shifts/requests/${requestId}`);
      toast?.success?.(isWaitlisted ? 'Left the waitlist.' : 'Request withdrawn.');
      setMyRequestPending((prev) => prev.filter((s) => s.my_request_id !== requestId));
    } catch (err) {
      const code = err?.code;
      const msg =
        code === 'already_approved'
          ? 'This request is already approved. Use Drop, Cover, or Emergency Drop instead.'
          : err?.message || 'Could not withdraw your request.';
      toast?.error?.(msg);
    } finally {
      setBusyKey(null);
    }
  }

  // Requesting a plain open shift opens the ranked-role + transport-ack sheet.
  // The /shifts/:id/request endpoint requires requested_positions and (when the
  // event needs gear/supplies) a transport acknowledgment, so a bare POST is no
  // longer valid; the sheet collects both.
  function openRequestSheet(shift) {
    if (!shift?.id) return;
    setRequestTarget(shift);
  }

  async function onRequestSubmitted() {
    setRequestTarget(null);
    toast?.success?.('Request sent.');
    await fetchAvailable();
  }

  async function claimCover(shift) {
    const shiftId = shift.id;
    if (!shiftId) return;
    setBusyKey(`cover:${shiftId}`);
    try {
      await api.post(`/shifts/requests/${shiftId}/claim-cover`);
      toast?.success?.('Cover request sent to management.');
      await fetchAvailable();
    } catch (err) {
      const code = err?.code;
      const msg =
        code === 'no_active_cover_request'
          ? 'This shift is no longer requesting cover.'
          : code === 'already_covered'
          ? 'Someone else already picked up this cover.'
          : err?.message || 'Could not claim this cover.';
      toast?.error?.(msg);
    } finally {
      setBusyKey(null);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────

  const counts = {
    available: availableShifts.length,
    all: allOpenShifts.length,
    mine: myRequestPending.length + upcoming.length,
    past: past.length,
  };

  return (
    <>
      <div className="sp-hero">
        <div>
          <h1>Shifts</h1>
          <div className="sp-page-sub">
            Request open shifts, see what you’ve got coming, look back at what you’ve worked.
          </div>
        </div>
      </div>

      <div className="sp-seg" role="tablist" aria-label="Shifts sub-tabs">
        {SUB_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={subTab === t}
            className={subTab === t ? 'active' : ''}
            onClick={() => navigate(`/shifts/${t}`)}
          >
            {labelFor(t)}
            <span className="sp-seg-count">{counts[t]}</span>
          </button>
        ))}
      </div>

      {(subTab === 'available' || subTab === 'all') && (
        <OpenShiftsTab
          mode={subTab}
          loading={openLoading && openShifts == null}
          error={openError}
          onRetry={fetchAvailable}
          shifts={subTab === 'available' ? availableShifts : allOpenShifts}
          busyKey={busyKey}
          onOpenShift={(s) =>
            navigate(`/shifts/${s.id}`, {
              // proposal_id rides along so ShiftDetail can skip the lookup
              // round-trip when the user clicked through from this list.
              state: { proposal_id: s.proposal_id || null, shift: s },
            })
          }
          onRequest={openRequestSheet}
          onClaimCover={claimCover}
        />
      )}
      {subTab === 'mine' && (
        <MineTab
          loading={eventsLoading && userEvents == null}
          error={eventsError}
          onRetry={fetchUserEvents}
          pending={myRequestPending}
          upcoming={upcoming}
          busyKey={busyKey}
          onWithdraw={withdrawRequest}
          onOpenShift={(s) =>
            navigate(`/shifts/${s.id}`, {
              state: { proposal_id: s.proposal_id || null, shift: s },
            })
          }
        />
      )}
      {subTab === 'past' && (
        <PastTab
          loading={eventsLoading && userEvents == null}
          error={eventsError}
          onRetry={fetchUserEvents}
          past={past}
          onOpenPayout={(s) => {
            if (s.payout_id) {
              navigate(`/pay/${s.payout_id}?shift=${s.id}`);
            } else {
              navigate('/pay');
            }
          }}
        />
      )}

      <RequestSheet
        open={!!requestTarget}
        shift={requestTarget}
        onClose={() => setRequestTarget(null)}
        onSubmitted={onRequestSubmitted}
      />
    </>
  );
}

// ── Sub-tab components ──────────────────────────────────────────────────

function OpenShiftsTab({ mode, loading, error, onRetry, shifts, busyKey, onOpenShift, onRequest, onClaimCover }) {
  if (loading) return <ListSkeleton count={3} />;
  if (error) return <InlineError msg={error} onRetry={onRetry} />;
  if (shifts.length === 0) {
    return (
      <EmptyState
        icon={<CalendarIcon size={22} />}
        title={mode === 'all' ? 'No open events right now.' : 'No shifts to grab right now.'}
        sub={
          mode === 'all'
            ? 'New shifts post weekly. Check back soon.'
            : 'Everything posted is fully staffed. Check the All tab to see them, or back soon for new shifts.'
        }
      />
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-gap, 0.7rem)' }}>
      {shifts.map((raw) => {
        const s = normalizeOpenShift(raw);
        const isRequested = !!raw.my_request_id && raw.my_request_status !== 'denied';
        // Only the cover claim has an inline busy state; the Request button opens
        // RequestSheet, which owns its own submitting state.
        const busy = busyKey === `cover:${s.id}`;
        // Per-role fill from the feed (positions_needed + approved_by_role).
        const needed = parsePositionsNeeded(raw.positions_needed);
        const counts = rosterCounts(needed);
        const approved = raw.approved_by_role && typeof raw.approved_by_role === 'object'
          ? raw.approved_by_role
          : {};
        const remaining = computeRemaining(needed, approved);
        const fullyStaffed = needed.length > 0 && isEventFullyStaffed(remaining);
        return (
          <div
            key={s.id}
            className={'sp-shift' + (s.cover_needed ? ' cover-needed' : '')}
            onClick={() => onOpenShift(s)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpenShift(s);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <div className="sp-shift-head">
              <span className="sp-shift-when">
                {fmtShortDate(s.event_date)}
                {s.start_time ? ` · ${s.start_time}` : ''}
              </span>
              <span className="sp-shift-rel">{relDayLabel(s.event_date)}</span>
            </div>
            <div>
              <div className="sp-shift-name">{s.client_name || 'Open shift'}</div>
              <div className="sp-shift-type">
                {getEventTypeLabel({ event_type: s.event_type, event_type_custom: s.event_type_custom })}
                {s.guest_count ? ` · ${s.guest_count} guests` : ''}
              </div>
            </div>
            {s.cover_needed && (
              <div className="sp-cover-banner">
                <UsersIcon size={12} />
                <span>
                  <strong>{s.cover_for_first_initial || 'A teammate'}</strong>{' '}
                  needs a cover, grab the slot.
                </span>
              </div>
            )}
            {(s.location || (s.start_time && s.end_time)) && (
              <div className="sp-shift-meta">
                {s.location && (
                  <span className="sp-shift-meta-row">
                    <LocationIcon size={12} />
                    {s.location}
                  </span>
                )}
                {s.start_time && s.end_time && (
                  <span className="sp-shift-meta-row">
                    <ClockIcon size={12} />
                    {s.start_time}–{s.end_time}
                  </span>
                )}
              </div>
            )}
            {needed.length > 0 && (
              <div className="sp-shift-roster">
                <div className="sp-shift-roster-fill">
                  {CANONICAL_LABELS.filter((role) => counts[role] > 0).map((role, i, arr) => {
                    const total = counts[role] || 0;
                    const filled = Math.min(Number(approved[role]) || 0, total);
                    return (
                      <span key={role} className={'sp-roster-pill' + (filled >= total ? ' full' : '')}>
                        {role} {filled}/{total}
                        {i < arr.length - 1 ? ' ·' : ''}
                      </span>
                    );
                  })}
                </div>
                <LogisticsTag
                  equipment_required={raw.equipment_required}
                  supply_run_required={raw.supply_run_required}
                />
              </div>
            )}
            <div className="sp-shift-foot">
              <div className="sp-shift-foot-l">
                {s.cover_needed && (
                  <span className="sp-chip warn">
                    <span className="sp-chip-dot" />
                    Cover needed
                  </span>
                )}
                {fullyStaffed && !s.cover_needed && (
                  <span className="sp-chip neutral">
                    <span className="sp-chip-dot" />
                    Fully staffed
                  </span>
                )}
              </div>
              {isRequested ? (
                <span className="sp-chip ok">
                  <span className="sp-chip-dot" />
                  Requested
                </span>
              ) : (
                <button
                  type="button"
                  className="sp-btn sp-btn-primary"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (s.cover_needed) {
                      onClaimCover(s);
                    } else {
                      onRequest(raw);
                    }
                  }}
                >
                  {busy
                    ? '…'
                    : s.cover_needed
                    ? 'Cover this'
                    : fullyStaffed
                    ? 'Join waitlist'
                    : 'Request'}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MineTab({ loading, error, onRetry, pending, upcoming, busyKey, onWithdraw, onOpenShift }) {
  if (loading) return <ListSkeleton count={2} />;
  if (error) return <InlineError msg={error} onRetry={onRetry} />;
  if (pending.length === 0 && upcoming.length === 0) {
    return (
      <EmptyState
        icon={<CalendarIcon size={22} />}
        title="No upcoming shifts."
        sub={
          <>
            Browse <strong>Available</strong> to request your next gig.
          </>
        }
      />
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
      {pending.map((s) => (
        <PendingRow
          key={s.my_request_id || `s${s.id}`}
          shift={s}
          busy={busyKey === `req:${s.my_request_id}`}
          onWithdraw={(isWaitlisted) => onWithdraw(s.my_request_id, isWaitlisted)}
        />
      ))}
      {upcoming.map((row) => (
        <ShiftCard
          key={row.id}
          shift={normalizeUserEvent(row)}
          showConfirmFlag
          onClick={() => onOpenShift({ id: row.id, proposal_id: row.proposal_id })}
        />
      ))}
    </div>
  );
}

function PastTab({ loading, error, onRetry, past, onOpenPayout }) {
  if (loading) return <ListSkeleton count={2} />;
  if (error) return <InlineError msg={error} onRetry={onRetry} />;
  if (past.length === 0) {
    return (
      <EmptyState
        icon={<ClockIcon size={22} />}
        title="No past shifts yet."
      />
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
      {past.map((row) => (
        <ShiftCard
          key={row.id}
          shift={normalizePastEvent(row)}
          variant="past"
          onClick={() => onOpenPayout(row)}
        />
      ))}
    </div>
  );
}

// ── Pending request row (Mine sub-tab) ──────────────────────────────────

function PendingRow({ shift, busy, onWithdraw }) {
  // A pending request whose every ranked role is currently full is a waitlist
  // entry (the server keeps status='pending' for both; the waitlist vs
  // actionable split is computed client-side from the same shared classifier).
  // approved_by_role on the feed excludes the viewer's own pending row, so
  // classifyRequest sees the true open slots.
  const ranked = parsePositionsNeeded(shift.my_requested_positions);
  const remaining = computeRemaining(
    parsePositionsNeeded(shift.positions_needed),
    shift.approved_by_role && typeof shift.approved_by_role === 'object' ? shift.approved_by_role : {}
  );
  const isWaitlisted = ranked.length > 0 && classifyRequest(ranked, remaining).state === 'waitlisted';

  return (
    <div className="sp-shift" style={{ opacity: 0.85 }}>
      <div className="sp-shift-head">
        <span className="sp-shift-when">
          {fmtShortDate(shift.event_date)}
          {shift.start_time ? ` · ${shift.start_time}` : ''}
        </span>
        <span className="sp-shift-rel">{relDayLabel(shift.event_date)}</span>
      </div>
      <div>
        <div className="sp-shift-name">{shift.client_name || 'Open shift'}</div>
        <div className="sp-shift-type">
          {isWaitlisted ? "You're on the waitlist" : 'Request pending review'}
        </div>
      </div>
      <div className="sp-shift-foot">
        <div className="sp-shift-foot-l">
          {isWaitlisted ? (
            <span className="sp-chip info">
              <span className="sp-chip-dot" />
              Waitlisted
            </span>
          ) : (
            <span className="sp-chip warn">
              <span className="sp-chip-dot" />
              Pending
            </span>
          )}
          {!isWaitlisted && ranked.length > 0 && (
            <span className="sp-chip neutral">{ranked.join(', ')}</span>
          )}
        </div>
        <button
          type="button"
          className="sp-btn sp-btn-sm sp-btn-ghost"
          disabled={busy}
          onClick={() => onWithdraw(isWaitlisted)}
        >
          {busy ? '…' : isWaitlisted ? 'Leave waitlist' : 'Withdraw'}
        </button>
      </div>
    </div>
  );
}

// ── Shared sub-tab UI ────────────────────────────────────────────────────

function EmptyState({ icon, title, sub }) {
  return (
    <div className="sp-empty">
      <div className="sp-empty-icon">{icon}</div>
      <div className="sp-empty-title">{title}</div>
      {sub && <div>{sub}</div>}
    </div>
  );
}

function InlineError({ msg, onRetry }) {
  return (
    <div className="sp-error-card">
      <div className="sp-error-card-msg">
        <strong>Could not load this list.</strong>
        <div className="sp-error-card-sub">{msg}</div>
      </div>
      <button type="button" className="sp-btn sp-btn-sm" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function ListSkeleton({ count = 3 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 110,
            borderRadius: 10,
            background: 'var(--sp-bg-2)',
            border: '1px solid var(--sp-line-1)',
            opacity: 0.6,
          }}
        />
      ))}
    </div>
  );
}

// ── Normalizers (map endpoint rows to ShiftCard's prop shape) ───────────

function normalizeOpenShift(row) {
  return {
    id: row.id,
    shift_id: row.id,
    event_date: row.event_date && String(row.event_date).slice(0, 10),
    start_time: row.start_time,
    end_time: row.end_time,
    location: row.location,
    event_type: row.event_type,
    event_type_custom: row.event_type_custom,
    client_name: row.client_name,
    guest_count: row.guest_count,
    cover_needed: !!row.cover_requested_at,
    cover_for_first_initial: row.cover_for_first_initial,
  };
}

function normalizeUserEvent(row) {
  return {
    id: row.id,
    shift_id: row.id,
    proposal_id: row.proposal_id,
    event_date: row.event_date && String(row.event_date).slice(0, 10),
    start_time: row.start_time,
    end_time: row.end_time,
    location: row.location,
    event_type: row.event_type || row.proposal_event_type,
    event_type_custom: row.event_type_custom || row.proposal_event_type_custom,
    client_name: row.client_name,
    guest_count: row.guest_count,
    position: row.position,
    beo_confirmed: !!row.my_beo_acknowledged_at,
    drink_plan_finalized_at: row.drink_plan_finalized_at,
  };
}

function normalizePastEvent(row) {
  return {
    id: row.id,
    shift_id: row.id,
    event_date: row.event_date && String(row.event_date).slice(0, 10),
    start_time: row.start_time,
    end_time: row.end_time,
    location: row.location,
    event_type: row.event_type || row.proposal_event_type,
    event_type_custom: row.event_type_custom || row.proposal_event_type_custom,
    client_name: row.client_name,
    guest_count: row.guest_count,
    position: row.position,
    payout_line_total_cents: row.payout_line_total_cents,
    payout_status: row.payout_status,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function labelFor(tab) {
  if (tab === 'available') return 'Available';
  if (tab === 'all') return 'All';
  if (tab === 'mine') return 'Mine';
  if (tab === 'past') return 'Past';
  return tab;
}

function fmtShortDate(iso) {
  if (!iso) return '';
  const dateStr = String(iso).slice(0, 10);
  const d = new Date(dateStr + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function relDayLabel(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff > 0) return `In ${diff}d`;
  if (diff === -1) return 'Yesterday';
  return `${-diff}d ago`;
}

// ── Inline icons ─────────────────────────────────────────────────────────

function CalendarIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
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

function LocationIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function UsersIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
