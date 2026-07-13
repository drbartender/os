import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import PayoutEventRow from '../../components/staff/PayoutEventRow';
import { formatMoney } from '../../utils/formatMoney';

/**
 * PayPage — staff portal v2 Pay tab landing (spec §6.6).
 *
 * URL: /pay
 *
 * Data fetches (kept lean):
 *   1. GET /api/me/payouts — always. Drives the paystubs list (status === 'paid')
 *      AND the YTD roll-up (sum total_cents where status === 'paid' and
 *      period.payday falls in the current calendar year). Also used to find
 *      the entry whose period covers today — the "current period".
 *   2. GET /api/me/payouts/:periodId — only when a current period is present
 *      in the list. Feeds the per-event PayoutEventRow line items shown on
 *      this page.
 *   3. GET /api/me/staff-home — fallback only. A brand-new hire (or a staffer
 *      who hasn't accrued anything yet this period) has NO payout row for the
 *      current period, so the list endpoint omits it. staff-home always
 *      returns the current period (even with total_cents = 0) — we read its
 *      `current_period` for the banner.
 *
 * Total worst case: 3 round-trips on first paint when there's a current
 * period AND it's NOT yet in the payouts list (fallback). Typical case: 1-2.
 *
 * Async-state coverage (spec §6.1.5):
 *   - Loading: hero + skeleton placeholder stack.
 *   - Error:  inline sp-error-card with Retry; hero stays visible.
 *   - Empty:  brand-new hire — no payouts at all and no current period info.
 *             Renders a friendly empty card explaining the first paystub
 *             appears after the first paid shift.
 *
 * Current-period detection: the list endpoint orders newest period first
 * (ORDER BY pp.start_date DESC), so the first match whose [start_date, end_date]
 * range covers today is THE current period. We DO NOT filter by status here
 * — a period mid-flight is typically `open`/`processing`, and the banner
 * renders the same way regardless. If multiple list rows happened to cover
 * today (shouldn't happen in well-formed data, but periods overlapping by a
 * day at the boundary is a known seed quirk), we take the first (newest).
 *
 * YTD year boundary: filters by period.payday's calendar year (not paid_at).
 * payday is the scheduled date and the most stable handle — paid_at can drift
 * forward by a day or two when the bank/check-cutter delays. A period paid
 * EARLY in January for a December's-end period (payday Jan 2) lands in the
 * new YTD year — matching how the staffer thinks of pay weeks ("I got paid
 * this year for that one").
 */
// Imported-ledger platform → display label (staff-payment-import spec §8.2).
const PLATFORM_LABELS = {
  venmo: 'Venmo', cashapp: 'Cash App', zelle: 'Zelle',
  ach: 'ACH', paypal: 'PayPal', cash_other: 'Cash / other',
};
const platformLabel = (p) => PLATFORM_LABELS[p] || p;

export default function PayPage() {
  const navigate = useNavigate();

  const [payoutsList, setPayoutsList] = useState(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(null);

  // Current-period detail (line items). Loaded once a current period is found
  // in the list. Null when there is no current-list-period (we render the
  // fallback banner from /staff-home with an empty line-items state).
  const [currentDetail, setCurrentDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);

  // Fallback current-period summary from /staff-home — only fetched when the
  // payouts list has no period covering today.
  const [fallbackPeriod, setFallbackPeriod] = useState(null);

  // Imported pre-OS payment history + blended all-time total (spec §8.2).
  const [paymentHistory, setPaymentHistory] = useState([]);
  const [blendedCents, setBlendedCents] = useState(0);
  const [historyError, setHistoryError] = useState(null);

  const fetchAll = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    setDetailLoading(false);
    setDetailError(null);
    setCurrentDetail(null);
    setFallbackPeriod(null);
    setPaymentHistory([]);
    setBlendedCents(0);
    setHistoryError(null);

    try {
      const listRes = await api.get('/me/payouts');
      const payouts = Array.isArray(listRes.data?.payouts) ? listRes.data.payouts : [];
      setPayoutsList(payouts);

      // Independent of the payouts flow: imported pre-OS history. A failure
      // here surfaces inline in its own section, never blanks the page.
      try {
        const histRes = await api.get('/me/payment-history');
        setPaymentHistory(Array.isArray(histRes.data?.history) ? histRes.data.history : []);
        setBlendedCents(Number.isFinite(histRes.data?.blended_total_cents) ? histRes.data.blended_total_cents : 0);
      } catch (err) {
        setHistoryError(err?.message || 'Could not load your payment history.');
        setPaymentHistory([]);
      }

      // Find the entry whose period covers today and is not yet paid. The
      // list is newest-first; first match wins.
      const todayIso = todayYmd();
      const current = payouts.find(
        (p) =>
          p.status !== 'paid' &&
          p.period?.start_date &&
          p.period?.end_date &&
          todayIso >= p.period.start_date &&
          todayIso <= p.period.end_date
      );

      if (current) {
        // Load this period's detail for the line-item PayoutEventRows.
        setDetailLoading(true);
        try {
          const detailRes = await api.get(`/me/payouts/${current.period.id}`);
          setCurrentDetail(detailRes.data);
        } catch (err) {
          // A detail-fetch failure shouldn't blank the whole page; the banner
          // still renders from the list row. Surface an inline retry next to
          // the line-items section.
          setDetailError(err?.message || 'Could not load this period’s line items.');
        } finally {
          setDetailLoading(false);
        }
      } else {
        // No payout row yet for the current period — fall back to /staff-home
        // for the banner. Empty/no-activity state for line items.
        try {
          const homeRes = await api.get('/me/staff-home');
          setFallbackPeriod(homeRes.data?.current_period || null);
        } catch (err) {
          // Non-fatal: paystubs + YTD still render from the list. We just
          // can't show the projected banner.
          setFallbackPeriod(null);
        }
      }
    } catch (err) {
      setListError(err?.message || 'Could not load your pay history.');
      setPayoutsList(null);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // ── Loading state ──────────────────────────────────────────────────────
  if (listLoading && payoutsList == null) {
    return (
      <>
        <Hero />
        <Skeleton />
      </>
    );
  }

  // ── Hard error state ───────────────────────────────────────────────────
  if (listError && payoutsList == null) {
    return (
      <>
        <Hero />
        <div className="sp-error-card">
          <div className="sp-error-card-msg">
            <strong>Couldn’t load your pay.</strong>
            <div className="sp-error-card-sub">{listError}</div>
          </div>
          <button type="button" className="sp-btn sp-btn-sm" onClick={fetchAll}>
            Retry
          </button>
        </div>
      </>
    );
  }

  const payouts = Array.isArray(payoutsList) ? payoutsList : [];
  const paidPayouts = payouts.filter((p) => p.status === 'paid');

  // Banner data: prefer the in-list current-period detail (canonical numbers),
  // fall back to /staff-home, fall back to "no current period" suppression.
  // Single `today` per render so the current-period match can't drift between
  // the two comparisons (or across a midnight re-render).
  const today = todayYmd();
  const listCurrent = payouts.find(
    (p) =>
      p.status !== 'paid' &&
      p.period?.start_date &&
      p.period?.end_date &&
      today >= p.period.start_date &&
      today <= p.period.end_date
  );

  const banner = pickBanner(listCurrent, currentDetail, fallbackPeriod);

  const ytdCents = computeYtdCents(paidPayouts);
  const ytdYear = new Date().getFullYear();

  // ── Brand-new-hire empty state ─────────────────────────────────────────
  // No paid history AND no current-period banner data AND no imported pre-OS
  // history (and that fetch didn't error). The friendly empty card replaces
  // every section — an imported staffer with ledger history but no OS payouts
  // must NOT see "No pay history yet", so the payment-history presence gates
  // this too (spec §8.2).
  if (paidPayouts.length === 0 && !banner && paymentHistory.length === 0 && !historyError) {
    return (
      <>
        <Hero />
        <div className="sp-empty">
          <div className="sp-empty-icon">
            <DollarIcon size={22} />
          </div>
          <div className="sp-empty-title">No pay history yet.</div>
          <div>Your first paystub appears here after your first paid shift.</div>
        </div>
      </>
    );
  }

  return (
    <>
      <Hero />

      {banner && (
        <button
          type="button"
          className={'sp-period-banner' + (banner.isPaid ? '' : ' processing')}
          onClick={() => banner.periodId && navigate(`/pay/${banner.periodId}`)}
          style={{
            textAlign: 'left',
            cursor: banner.periodId ? 'pointer' : 'default',
            width: '100%',
            font: 'inherit',
            color: 'inherit',
          }}
        >
          <div className="sp-period-banner-head">
            <span className="sp-period-banner-dates">
              Current period · {fmtPeriodRange(banner.startDate, banner.endDate)}
            </span>
            {banner.isPaid ? (
              <span className="sp-chip ok">
                <span className="sp-chip-dot" />
                Paid
              </span>
            ) : (
              <span className="sp-chip info">
                <span className="sp-chip-dot" />
                Processing
              </span>
            )}
          </div>
          <div className="sp-period-banner-total">{formatMoney(banner.totalCents)}</div>
          <div className="sp-period-banner-foot">
            <span>Projected: live until payday.</span>
            {banner.payday && (
              <span>
                <strong>Pays {fmtShortDate(banner.payday)}</strong>
              </span>
            )}
          </div>
        </button>
      )}

      {/* Current-period line items */}
      {banner && (
        <section className="sp-card">
          <div className="sp-card-head">
            <div className="sp-card-title">Line items, this period</div>
            {banner.periodId && (
              <button
                type="button"
                className="sp-card-link"
                onClick={() => navigate(`/pay/${banner.periodId}`)}
              >
                Full breakdown
              </button>
            )}
          </div>
          {detailLoading && !currentDetail ? (
            <LineItemsSkeleton />
          ) : detailError ? (
            <div className="sp-error-card" style={{ marginTop: 0 }}>
              <div className="sp-error-card-msg">
                <strong>Couldn’t load line items.</strong>
                <div className="sp-error-card-sub">{detailError}</div>
              </div>
              <button type="button" className="sp-btn sp-btn-sm" onClick={fetchAll}>
                Retry
              </button>
            </div>
          ) : Array.isArray(currentDetail?.events) && currentDetail.events.length > 0 ? (
            currentDetail.events.map((ev) => (
              <PayoutEventRow key={ev.shift_id} event={ev} />
            ))
          ) : (
            <div className="sp-empty" style={{ padding: '1.4rem 1rem' }}>
              <div className="sp-empty-title">No activity yet this period.</div>
              <div>Shifts you work this period will show up here.</div>
            </div>
          )}
        </section>
      )}

      {/* Year-to-date */}
      <section className="sp-card">
        <div className="sp-card-head">
          <div className="sp-card-title">Year to date · {ytdYear}</div>
        </div>
        <div className="sp-stats">
          <div className="sp-stat">
            <div className="sp-stat-k">Paid out</div>
            <div className="sp-stat-v">{formatMoney(ytdCents)}</div>
            <div className="sp-stat-sub">
              across {paidPayouts.length} period{paidPayouts.length !== 1 ? 's' : ''}
            </div>
          </div>
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--sp-ink-3)',
            marginTop: 6,
            fontStyle: 'italic',
            lineHeight: 1.55,
          }}
        >
          1099 income, no taxes withheld. Cash &amp; app tips you split honor-system aren’t
          on this ledger.
        </div>
      </section>

      {/* Paystubs list */}
      <section className="sp-card">
        <div className="sp-card-head">
          <div className="sp-card-title">Paystubs</div>
        </div>
        {paidPayouts.length === 0 ? (
          <div className="sp-empty" style={{ padding: '1.4rem 1rem' }}>
            <div className="sp-empty-title">No paystubs yet.</div>
            <div>Closed pay periods will appear here after each payday.</div>
          </div>
        ) : (
          paidPayouts.map((pp) => (
            <button
              key={pp.id}
              type="button"
              className="sp-paystub"
              onClick={() => navigate(`/pay/${pp.period.id}`)}
            >
              <div className="sp-paystub-head">
                <span className="sp-paystub-when">{fmtPeriodRange(pp.period.start_date, pp.period.end_date)}</span>
                <span className="sp-paystub-amount">{formatMoney(pp.total_cents || 0)}</span>
              </div>
              <div className="sp-paystub-foot">
                <span>
                  Paid {fmtShortDate(pp.paid_at) || '—'}
                  {Number.isFinite(pp.event_count) && (
                    <>
                      {' · '}
                      {pp.event_count} event{pp.event_count !== 1 ? 's' : ''}
                    </>
                  )}
                </span>
              </div>
            </button>
          ))
        )}
      </section>

      {/* Imported pre-OS payment history (spec §8.2). Blended all-time total on
          top; the row list is collapsed behind a disclosure. Hidden entirely
          when there is nothing to show (and the fetch didn't error). */}
      {(paymentHistory.length > 0 || historyError) && (
        <section className="sp-card">
          <div className="sp-card-head">
            <div className="sp-card-title">Payment history</div>
          </div>
          {historyError && paymentHistory.length === 0 ? (
            <div className="sp-error-card" style={{ marginTop: 0 }}>
              <div className="sp-error-card-msg">
                <strong>Couldn’t load your payment history.</strong>
                <div className="sp-error-card-sub">{historyError}</div>
              </div>
              <button type="button" className="sp-btn sp-btn-sm" onClick={fetchAll}>
                Retry
              </button>
            </div>
          ) : (
            <>
              <div className="sp-stats">
                <div className="sp-stat">
                  <div className="sp-stat-k">All-time paid</div>
                  <div className="sp-stat-v">{formatMoney(blendedCents)}</div>
                  <div className="sp-stat-sub">imported history + this system</div>
                </div>
              </div>
              <details className="sph-details">
                <summary className="sph-summary">
                  Payments before this system · {paymentHistory.length}
                </summary>
                <div className="sph-list">
                  {paymentHistory.map((h, i) => (
                    <div key={i} className="sph-row">
                      <span className="sph-when">{fmtHistoryDate(h.paid_on)}</span>
                      <span className="sph-platform-chip">{platformLabel(h.platform)}</span>
                      <span className="sph-amount">{formatMoney(h.amount_cents)}</span>
                    </div>
                  ))}
                </div>
              </details>
            </>
          )}
        </section>
      )}
    </>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function Hero() {
  return (
    <div className="sp-hero">
      <div>
        <h1>My Pay</h1>
        <div className="sp-page-sub">
          Each event you work shows up here. Paystubs land the second working day after
          the period closes.
        </div>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}
      aria-hidden="true"
    >
      <div
        style={{
          height: 140,
          borderRadius: 10,
          background: 'var(--sp-bg-2)',
          border: '1px solid var(--sp-line-1)',
          opacity: 0.6,
        }}
      />
      {Array.from({ length: 2 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 110,
            borderRadius: 10,
            background: 'var(--sp-bg-2)',
            border: '1px solid var(--sp-line-1)',
            opacity: 0.5,
          }}
        />
      ))}
    </div>
  );
}

function LineItemsSkeleton() {
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
      aria-hidden="true"
    >
      {Array.from({ length: 2 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 76,
            borderRadius: 8,
            background: 'var(--sp-bg-2)',
            opacity: 0.5,
          }}
        />
      ))}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Decide what to render in the banner. Preference order:
 *   1. Detail-fetch payload (canonical totals, period.* from server JOIN).
 *   2. List-row current period (totals correct, no per-event breakdown).
 *   3. /staff-home fallback (banner only — list endpoint had no row).
 *   4. null (no current period to show — usually a brand-new hire).
 *
 * Returns a tiny normalized object so the banner JSX doesn't have to branch
 * on which source it came from.
 */
function pickBanner(listCurrent, detail, fallback) {
  if (detail?.period && detail?.payout) {
    return {
      periodId: detail.period.id,
      startDate: detail.period.start_date,
      endDate: detail.period.end_date,
      payday: detail.period.payday,
      totalCents: Number.isFinite(detail.payout.total_cents) ? detail.payout.total_cents : 0,
      isPaid: detail.payout.status === 'paid',
    };
  }
  if (listCurrent?.period) {
    return {
      periodId: listCurrent.period.id,
      startDate: listCurrent.period.start_date,
      endDate: listCurrent.period.end_date,
      payday: listCurrent.period.payday,
      totalCents: Number.isFinite(listCurrent.total_cents) ? listCurrent.total_cents : 0,
      isPaid: listCurrent.status === 'paid',
    };
  }
  if (fallback?.pay_period_id) {
    return {
      periodId: fallback.pay_period_id,
      startDate: fallback.start_date,
      endDate: fallback.end_date,
      payday: fallback.payday,
      totalCents: Number.isFinite(fallback.total_cents) ? fallback.total_cents : 0,
      isPaid: false,
    };
  }
  return null;
}

/**
 * Sum total_cents across paid payouts whose payday lands in the current
 * calendar year. payday is the scheduled date and is the most stable handle
 * — paid_at can drift forward by a day or two when the bank/check-cutter
 * delays, so a period paid EARLY in January for a December's-end period
 * (payday Jan 2) belongs to the new YTD year by payday, which matches how
 * the staffer thinks of pay weeks.
 */
function computeYtdCents(paidPayouts) {
  const year = new Date().getFullYear();
  return paidPayouts.reduce((sum, p) => {
    const payday = p.period?.payday;
    if (!payday) return sum;
    const paydayYear = Number(String(payday).slice(0, 4));
    if (paydayYear !== year) return sum;
    return sum + (Number.isFinite(p.total_cents) ? p.total_cents : 0);
  }, 0);
}

// Today as YYYY-MM-DD in LOCAL time. The period start/end_date columns are
// DATE (no zone) and we want today in the staffer's local calendar.
function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtShortDate(iso) {
  if (!iso) return '';
  const dateStr = String(iso).slice(0, 10);
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

// Imported history spans multiple calendar years, so the year is meaningful
// here (unlike the current-period short dates above).
function fmtHistoryDate(iso) {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function fmtPeriodRange(startIso, endIso) {
  if (!startIso || !endIso) return '';
  const s = new Date(`${String(startIso).slice(0, 10)}T12:00:00`);
  const e = new Date(`${String(endIso).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '';
  const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
  if (sameMonth) {
    return `${s.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    })}–${e.getDate()}`;
  }
  return `${s.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })}–${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

// ── Inline icons (Lucide-style 1.75 stroke, matches StaffShell). ──────────

function DollarIcon({ size = 22 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v18M16 7c0-1.7-1.8-3-4-3s-4 1.3-4 3 1.8 3 4 3 4 1.3 4 3-1.8 3-4 3-4-1.3-4-3" />
    </svg>
  );
}
