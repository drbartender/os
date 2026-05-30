import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import api from '../../utils/api';
import ShiftCard from '../../components/staff/ShiftCard';
import { getEventTypeLabel } from '../../utils/eventTypes';
import ShiftDetail from './ShiftDetail';

const SUB_TABS = ['available', 'mine', 'past'];

/**
 * ShiftsPage — staff portal v2 (spec §6.3).
 *
 * URL-driven sub-tab selector. Three sub-routes share one page:
 *   /staff-v2/shifts/available — open shifts (GET /api/shifts staff path)
 *   /staff-v2/shifts/mine      — pending + upcoming approved
 *   /staff-v2/shifts/past      — completed / past approved
 *
 * Mounted from App.js as `<Route path="shifts/*">`. The component reads the
 * sub-tab segment from useParams() so the active sub-tab survives reload,
 * direct link, and back/forward navigation. A bare /staff-v2/shifts URL
 * redirects to /available to give every load a deterministic landing tab.
 *
 * Action surface per sub-tab:
 *   - Available: ShiftCard with `variant='open'`. Cover-needed rows show
 *     the accent border (via ShiftCard) + inline banner + "Cover this"
 *     button → POST /api/shifts/requests/:shiftId/claim-cover. Plain open
 *     rows show "Request" → POST /api/shifts/:id/request.
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
    return <Navigate to="/staff-v2/shifts/available" replace />;
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
    if (subTab === 'available') fetchAvailable();
    if (subTab === 'mine' || subTab === 'past') fetchUserEvents();
  }, [subTab, fetchAvailable, fetchUserEvents]);

  // Derived rows (memo-free — these are cheap projections, the data is
  // small, and re-deriving each render keeps the read path simple).
  const upcoming = Array.isArray(userEvents?.upcoming) ? userEvents.upcoming : [];
  const past = Array.isArray(userEvents?.past) ? userEvents.past : [];
  const allOpenShifts = Array.isArray(openShifts) ? openShifts : [];
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

  async function withdrawRequest(requestId) {
    if (!requestId) return;
    setBusyKey(`req:${requestId}`);
    try {
      await api.delete(`/shifts/requests/${requestId}`);
      toast?.success?.('Request withdrawn.');
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

  async function requestShift(shift) {
    const shiftId = shift.id;
    if (!shiftId) return;
    setBusyKey(`req-shift:${shiftId}`);
    try {
      await api.post(`/shifts/${shiftId}/request`, {
        position: shift.my_request_position || null,
      });
      toast?.success?.('Request sent.');
      await fetchAvailable();
    } catch (err) {
      toast?.error?.(err?.message || 'Could not send the request.');
    } finally {
      setBusyKey(null);
    }
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
    available: allOpenShifts.length,
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
            onClick={() => navigate(`/staff-v2/shifts/${t}`)}
          >
            {labelFor(t)}
            <span className="sp-seg-count">{counts[t]}</span>
          </button>
        ))}
      </div>

      {subTab === 'available' && (
        <AvailableTab
          loading={openLoading && openShifts == null}
          error={openError}
          onRetry={fetchAvailable}
          shifts={allOpenShifts}
          busyKey={busyKey}
          onOpenShift={(s) =>
            navigate(`/staff-v2/shifts/${s.id}`, {
              // proposal_id rides along so ShiftDetail can skip the lookup
              // round-trip when the user clicked through from this list.
              state: { proposal_id: s.proposal_id || null, shift: s },
            })
          }
          onRequest={requestShift}
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
            navigate(`/staff-v2/shifts/${s.id}`, {
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
              navigate(`/staff-v2/pay/${s.payout_id}?shift=${s.id}`);
            } else {
              navigate('/staff-v2/pay');
            }
          }}
        />
      )}
    </>
  );
}

// ── Sub-tab components ──────────────────────────────────────────────────

function AvailableTab({ loading, error, onRetry, shifts, busyKey, onOpenShift, onRequest, onClaimCover }) {
  if (loading) return <ListSkeleton count={3} />;
  if (error) return <InlineError msg={error} onRetry={onRetry} />;
  if (shifts.length === 0) {
    return (
      <EmptyState
        icon={<CalendarIcon size={22} />}
        title="No open shifts right now."
        sub="New shifts post weekly. Check back soon."
      />
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-gap, 0.7rem)' }}>
      {shifts.map((raw) => {
        const s = normalizeOpenShift(raw);
        const isRequested = !!raw.my_request_id && raw.my_request_status !== 'denied';
        const busy = busyKey === `cover:${s.id}` || busyKey === `req-shift:${s.id}`;
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
            <div className="sp-shift-foot">
              <div className="sp-shift-foot-l">
                {s.cover_needed && (
                  <span className="sp-chip warn">
                    <span className="sp-chip-dot" />
                    Cover needed
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
                  className="sp-btn sp-btn-sm sp-btn-primary"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (s.cover_needed) {
                      onClaimCover(s);
                    } else {
                      onRequest(s);
                    }
                  }}
                >
                  {busy ? '…' : s.cover_needed ? 'Cover this' : 'Request'}
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
          onWithdraw={() => onWithdraw(s.my_request_id)}
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
        <div className="sp-shift-type">Request pending review</div>
      </div>
      <div className="sp-shift-foot">
        <div className="sp-shift-foot-l">
          <span className="sp-chip warn">
            <span className="sp-chip-dot" />
            Pending
          </span>
          {shift.my_request_position && (
            <span className="sp-chip neutral">{shift.my_request_position}</span>
          )}
        </div>
        <button
          type="button"
          className="sp-btn sp-btn-sm sp-btn-ghost"
          disabled={busy}
          onClick={onWithdraw}
        >
          {busy ? '…' : 'Withdraw'}
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
