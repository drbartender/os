import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import api from '../../utils/api';
import ShiftCard from '../../components/staff/ShiftCard';
import { getEventTypeLabel } from '../../utils/eventTypes';

/**
 * HomePage — staff portal v2 dashboard surface (spec §6.2).
 *
 * One round-trip via GET /api/me/staff-home returns a composite payload:
 *   { next_shift, pending_requests, cover_broadcasts,
 *     current_period, open_shifts_teaser }
 *
 * Sections rendered (top to bottom):
 *   1. Hero — greeting based on time of day + today's full date.
 *   2. "Needs you" tray (conditional). Three entry types:
 *      - Unconfirmed BEOs for an upcoming shift (alert / amber)
 *      - Pending shift requests waiting on admin (clock / neutral)
 *      - Cover-needed broadcasts by teammates (users / info-blue)
 *      Tray is hidden entirely when all three buckets are empty.
 *   3. Next shift card (ShiftCard with showConfirmFlag).
 *   4. This pay period tile — projected total, payday, event count.
 *      Tap → opens PayoutDetail for the current pay period.
 *   5. Open shifts teaser — top 2 entries from `open_shifts_teaser`
 *      with an "All (N) →" link to /staff-v2/shifts/available.
 *
 * Async-state coverage (spec §6.1.5):
 *   - Loading: full-page skeleton on first mount (no chrome competes since
 *     the StaffShell is already painted around <Outlet/>).
 *   - Error: inline error card with Retry; chrome stays visible.
 *   - Empty: per-section empty copy where applicable; the "Needs you" tray
 *     is conditional, so empty-tray means "render nothing" not "render
 *     empty state".
 *
 * Window-focus refetch keeps the BEO-confirm / cover-broadcast counts fresh
 * for a bartender who tab-flips into the portal after seeing a push or SMS.
 * The fetch is cheap (composite endpoint, ~4 parallel SQL queries on the
 * server) so the cooldown isn't required here — the AuthContext visibility
 * handler already throttles its own /auth/me refresh, and any extra round
 * trip on the staff-home endpoint is a single composite read.
 */
export default function HomePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchHome = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get('/me/staff-home');
      setData(res.data);
    } catch (err) {
      setError(err?.message || 'Could not load your home page.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHome();
  }, [fetchHome]);

  // Refetch on tab focus so a bartender returning from SMS / push sees the
  // updated BEO ack + cover-broadcast counts without a hard reload.
  useEffect(() => {
    function onVisibility() {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'visible') fetchHome();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [fetchHome]);

  if (loading && !data) {
    return (
      <>
        <Hero user={user} />
        <SkeletonHome />
      </>
    );
  }

  if (error && !data) {
    return (
      <>
        <Hero user={user} />
        <div className="sp-error-card">
          <div className="sp-error-card-msg">
            <strong>Something went wrong loading your home.</strong>
            <div className="sp-error-card-sub">{error}</div>
          </div>
          <button type="button" className="sp-btn sp-btn-sm" onClick={fetchHome}>
            Retry
          </button>
        </div>
      </>
    );
  }

  const nextShift = data?.next_shift ? normalizeNextShift(data.next_shift) : null;
  const pendingRequests = Array.isArray(data?.pending_requests) ? data.pending_requests : [];
  const coverBroadcasts = Array.isArray(data?.cover_broadcasts) ? data.cover_broadcasts : [];
  const currentPeriod = data?.current_period || null;
  const openShifts = Array.isArray(data?.open_shifts_teaser) ? data.open_shifts_teaser : [];

  const showNeedsYou =
    (nextShift && !nextShift.beo_confirmed && nextShift.drink_plan_finalized_at) ||
    pendingRequests.length > 0 ||
    coverBroadcasts.length > 0;

  return (
    <>
      <Hero user={user} />

      {showNeedsYou && (
        <section className="sp-card" aria-labelledby="needs-you-title">
          <div className="sp-card-head">
            <div className="sp-card-title" id="needs-you-title">Needs you</div>
          </div>
          {/* BEO not-yet-confirmed for the next shift — surface only when the
              drink plan is finalized so a staffer is never asked to confirm
              a still-evolving BEO. */}
          {nextShift && !nextShift.beo_confirmed && nextShift.drink_plan_finalized_at && (
            <button
              type="button"
              className="sp-action"
              onClick={() =>
                navigate(`/staff-v2/shifts/${nextShift.shift_id}`, {
                  state: { proposal_id: nextShift.proposal_id, shift: nextShift },
                })
              }
            >
              <div className="sp-action-icon">
                <AlertIcon size={15} />
              </div>
              <div className="sp-action-main">
                <div className="sp-action-title">
                  Confirm the {nextShift.client_name || 'event'} BEO
                </div>
                <div className="sp-action-sub">
                  {fmtShortDate(nextShift.event_date)} · {relDayLabel(nextShift.event_date)}
                </div>
              </div>
              <ChevronRightIcon size={14} />
            </button>
          )}
          {coverBroadcasts.map((c) => (
            <CoverBroadcastRow
              key={c.request_id}
              broadcast={c}
              onOpen={() => {
                if (c.you_are_on_team) {
                  navigate(`/staff-v2/shifts/${c.shift_id}`, {
                    state: { proposal_id: c.proposal_id || null },
                  });
                } else {
                  navigate('/staff-v2/shifts/available');
                }
              }}
            />
          ))}
          {pendingRequests.map((r) => (
            <button
              key={r.request_id}
              type="button"
              className="sp-action"
              onClick={() => navigate('/staff-v2/shifts/mine')}
            >
              <div className="sp-action-icon">
                <ClockIcon size={15} />
              </div>
              <div className="sp-action-main">
                <div className="sp-action-title">
                  Request pending, {r.client_name || 'event'}
                </div>
                <div className="sp-action-sub">
                  {fmtShortDate(r.event_date)} · waiting on admin
                </div>
              </div>
              <ChevronRightIcon size={14} />
            </button>
          ))}
        </section>
      )}

      <section className="sp-card">
        <div className="sp-card-head">
          <div className="sp-card-title">Next shift</div>
          <button
            type="button"
            className="sp-card-link"
            onClick={() => navigate('/staff-v2/shifts/mine')}
          >
            All shifts
          </button>
        </div>
        {nextShift ? (
          <ShiftCard
            shift={nextShift}
            showConfirmFlag
            onClick={() =>
              navigate(`/staff-v2/shifts/${nextShift.shift_id}`, {
                state: { proposal_id: nextShift.proposal_id, shift: nextShift },
              })
            }
          />
        ) : (
          <div className="sp-empty">
            <div className="sp-empty-icon">
              <CalendarIcon size={22} />
            </div>
            <div className="sp-empty-title">Nothing on the books.</div>
            <div>Check the Shifts tab for open events.</div>
          </div>
        )}
      </section>

      <section className="sp-card">
        <div className="sp-card-head">
          <div className="sp-card-title">This pay period</div>
          <button
            type="button"
            className="sp-card-link"
            onClick={() => navigate('/staff-v2/pay')}
          >
            Open Pay
          </button>
        </div>
        {currentPeriod ? (
          <div
            className="sp-earnings"
            onClick={() =>
              navigate(
                currentPeriod.pay_period_id
                  ? `/staff-v2/pay/${currentPeriod.pay_period_id}`
                  : '/staff-v2/pay'
              )
            }
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                navigate(
                  currentPeriod.pay_period_id
                    ? `/staff-v2/pay/${currentPeriod.pay_period_id}`
                    : '/staff-v2/pay'
                );
              }
            }}
          >
            <div className="sp-earnings-l">
              <div className="sp-earnings-k">Projected payout</div>
              <div className="sp-earnings-v">{formatCents(currentPeriod.total_cents || 0)}</div>
              <div className="sp-earnings-sub">
                {fmtPeriodRange(currentPeriod.start_date, currentPeriod.end_date)}
                {Number.isFinite(currentPeriod.event_count) && (
                  <>
                    {' · '}
                    {currentPeriod.event_count} event
                    {currentPeriod.event_count !== 1 ? 's' : ''}
                  </>
                )}
              </div>
            </div>
            <div className="sp-earnings-r">
              <div className="sp-earnings-r-k">Payday</div>
              <div className="sp-earnings-r-v">{fmtShortDate(currentPeriod.payday)}</div>
            </div>
          </div>
        ) : (
          <div className="sp-empty">
            <div className="sp-empty-icon">
              <DollarIcon size={22} />
            </div>
            <div className="sp-empty-title">No payouts yet.</div>
            <div>Your first payout will appear here after your first shift.</div>
          </div>
        )}
      </section>

      <section className="sp-card">
        <div className="sp-card-head">
          <div className="sp-card-title">Open shifts</div>
          <button
            type="button"
            className="sp-card-link"
            onClick={() => navigate('/staff-v2/shifts/available')}
          >
            All ({openShifts.length})
          </button>
        </div>
        {openShifts.length > 0 ? (
          openShifts.slice(0, 2).map((s) => (
            <ShiftCard
              key={s.id || s.shift_id}
              shift={normalizeOpenShift(s)}
              variant="open"
              onClick={() => navigate('/staff-v2/shifts/available')}
            />
          ))
        ) : (
          <div className="sp-empty">
            <div className="sp-empty-icon">
              <CalendarIcon size={22} />
            </div>
            <div className="sp-empty-title">No open shifts right now.</div>
            <div>New shifts post weekly. Check back soon.</div>
          </div>
        )}
      </section>
    </>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────

function Hero({ user }) {
  const today = new Date();
  const greeting = greetingFor(today);
  const dateLabel = today.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  // First name only for the hero greeting ("Good morning, Sam."). The full
  // preferred_name shows in the user-pill menu; here we want the warm short form.
  const fullName = user?.preferred_name || (user?.email ? user.email.split('@')[0] : '');
  const name = fullName.split(/\s+/)[0] || '';
  return (
    <div className="sp-hero">
      <div>
        <div className="sp-greeting">
          {greeting}
          {name ? `, ${name}.` : '.'}
        </div>
        <div className="sp-greeting-sub">{dateLabel.toUpperCase()}</div>
      </div>
    </div>
  );
}

function CoverBroadcastRow({ broadcast, onOpen }) {
  // First + last initial: "Diego R." — the requester_preferred_name carries
  // the staffer's preferred name; we strip a trailing event-type word from
  // the client_name to keep the action-row title compact.
  const preferred = (broadcast.requester_preferred_name || '').trim();
  const parts = preferred.split(/\s+/).filter(Boolean);
  const who =
    parts.length >= 2
      ? `${parts[0]} ${parts[parts.length - 1][0]}.`
      : parts[0] || 'A teammate';
  const eventLabel = getEventTypeLabel({
    event_type: broadcast.event_type,
    event_type_custom: broadcast.event_type_custom,
  });
  const clientName = (broadcast.client_name || '').trim();
  return (
    <button type="button" className="sp-action" onClick={onOpen}>
      <div className="sp-action-icon info">
        <UsersIcon size={15} />
      </div>
      <div className="sp-action-main">
        <div className="sp-action-title">
          Cover needed: {who}
          {clientName ? `, ${clientName}` : ''}
          {!clientName && eventLabel ? `, ${eventLabel}` : ''}
        </div>
        <div className="sp-action-sub">
          {fmtShortDate(broadcast.event_date)} ·{' '}
          {broadcast.you_are_on_team
            ? 'you’re already on this gig'
            : 'open shift, you’re qualified'}
        </div>
      </div>
      <ChevronRightIcon size={14} />
    </button>
  );
}

function SkeletonHome() {
  return (
    <>
      <div className="sp-card" aria-hidden="true">
        <div className="sp-card-head">
          <div className="sp-card-title">Loading…</div>
        </div>
        <div
          style={{
            height: 88,
            borderRadius: 8,
            background: 'var(--sp-bg-3)',
            opacity: 0.4,
          }}
        />
      </div>
      <div className="sp-card" aria-hidden="true">
        <div
          style={{
            height: 64,
            borderRadius: 8,
            background: 'var(--sp-bg-3)',
            opacity: 0.4,
          }}
        />
      </div>
    </>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Normalize the `next_shift` row from /staff-home into ShiftCard's prop
 * shape. The endpoint returns `request_status` / `request_id` (own approved
 * shift_request), so we project those into the ShiftCard fields plus the
 * derived `beo_confirmed` flag from the BEO ack timestamp.
 */
function normalizeNextShift(row) {
  return {
    id: row.shift_id,
    shift_id: row.shift_id,
    proposal_id: row.proposal_id,
    event_date: row.event_date && String(row.event_date).slice(0, 10),
    start_time: row.start_time,
    end_time: row.end_time,
    location: row.location,
    event_type: row.event_type,
    event_type_custom: row.event_type_custom,
    client_name: row.client_name,
    position: row.position,
    beo_confirmed: !!row.beo_acknowledged_at,
    drink_plan_finalized_at: row.drink_plan_finalized_at,
  };
}

/**
 * Normalize an open-shift row for the teaser. The /staff-home endpoint
 * currently returns an empty list for open_shifts_teaser (spec §6.2 ack:
 * "intentionally a hardcoded empty array for now") — this normalizer is a
 * forward-fit for when the backend wires the projection in.
 */
function normalizeOpenShift(row) {
  return {
    id: row.id || row.shift_id,
    shift_id: row.id || row.shift_id,
    event_date: row.event_date && String(row.event_date).slice(0, 10),
    start_time: row.start_time,
    end_time: row.end_time,
    location: row.location,
    event_type: row.event_type,
    event_type_custom: row.event_type_custom,
    client_name: row.client_name,
    pay_cents_estimate: row.pay_cents_estimate,
    requested_by_count: row.requested_by_count,
    cover_needed: !!row.cover_requested_at,
  };
}

function greetingFor(d) {
  const h = d.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function fmtShortDate(iso) {
  if (!iso) return '';
  const dateStr = String(iso).slice(0, 10);
  const d = new Date(dateStr + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtPeriodRange(startIso, endIso) {
  if (!startIso || !endIso) return '';
  const s = new Date(String(startIso).slice(0, 10) + 'T12:00:00');
  const e = new Date(String(endIso).slice(0, 10) + 'T12:00:00');
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '';
  const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
  if (sameMonth) {
    return `${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${e.getDate()}`;
  }
  return `${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
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

function formatCents(cents) {
  const safe = Number.isFinite(cents) ? cents : 0;
  const v = Math.abs(safe) / 100;
  const formatted = v.toFixed(2).replace(/\.00$/, '');
  return (safe < 0 ? '-' : '') + '$' + formatted;
}

// ── Inline icons (Lucide-style strokes at 1.75, matches StaffShell) ─────

function AlertIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function ClockIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function CalendarIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
    </svg>
  );
}

function DollarIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v18M16 7c0-1.7-1.8-3-4-3s-4 1.3-4 3 1.8 3 4 3 4 1.3 4 3-1.8 3-4 3-4-1.3-4-3" />
    </svg>
  );
}

function UsersIcon({ size = 15 }) {
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

function ChevronRightIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
