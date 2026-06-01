import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api from '../../utils/api';
import PayoutEventRow from '../../components/staff/PayoutEventRow';
import { formatMoney } from '../../utils/formatMoney';

/**
 * PayoutDetail — staff portal v2 single-pay-period detail (spec §6.7).
 *
 * URL: /staff-v2/pay/:periodId
 * Optional query: ?shift=:shiftId — when present, scroll-to + highlight the
 *                  matching PayoutEventRow so a deep-link from a Past-shift
 *                  tap lands on the right line.
 *
 * Data source: GET /api/me/payouts/:periodId
 *   {
 *     period:  { id, start_date, end_date, payday, status },
 *     payout:  { id, status, total_cents, paid_at, paystub_storage_key },
 *     events:  [ { shift_id, event_date, client_name, event_type,
 *                  event_type_custom, contracted_hours, hours, rate_cents,
 *                  wage_cents, late, gratuity_share_cents,
 *                  card_tip_gross_cents, card_tip_fee_cents,
 *                  card_tip_net_cents, adjustment_cents, adjustment_note,
 *                  line_total_cents } ],
 *     summary: { wages_cents, gratuity_cents, card_tips_gross_cents,
 *                card_processing_fee_cents, adjustments_cents, total_cents },
 *   }
 *
 * Status semantics: payout.status is 'processing' (also reads as 'pending'
 * in earlier seeds) or 'paid'. Anything that isn't `'paid'` is treated as
 * in-progress for the banner chip — keeps the page robust to seeded states
 * the spec hasn't formalized.
 *
 * 404 handling: a periodId that exists but isn't this staffer's, OR doesn't
 * exist at all, returns 404 from the server (IDOR guard in payouts.js — both
 * cases collapse to the same "Payout not found" response). The page surfaces
 * a friendly empty card with a back-to-Pay button.
 *
 * Async-state coverage (spec §6.1.5):
 *   - Loading: skeleton placeholder stack with the back button visible so
 *              the user can bail out before the first paint.
 *   - Error:  inline sp-error-card with a Retry button.
 *   - Empty:  events array empty (rare — a payout with zero events) renders
 *             the summary card + a friendly "No line items yet" empty state
 *             below it.
 *   - 404:   dedicated NotFound branch with a back-to-Pay link.
 *
 * Pay actions: per spec, "Download PDF" + "Email a copy" are shown when the
 * payout is paid. PDF generation lives in Phase 3 of the staff-payment plan
 * (`paystub_storage_key` is populated by an admin-side worker that doesn't
 * exist yet on `main`); for v1 we render the Download button disabled with
 * a TODO note when `paystub_storage_key` is set but no client-side download
 * endpoint exists. Email a copy is rendered as a stub button — both wire
 * up cleanly when the backend lands.
 */
export default function PayoutDetail() {
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams] = useSearchParams();

  const periodId = parsePositiveInt(params.periodId);
  const highlightShiftId = parsePositiveInt(searchParams.get('shift'));

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notFound, setNotFound] = useState(false);

  const fetchDetail = useCallback(async () => {
    if (!Number.isFinite(periodId)) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const res = await api.get(`/me/payouts/${periodId}`);
      setData(res.data);
    } catch (err) {
      if (err?.status === 404) {
        setNotFound(true);
      } else {
        setError(err?.message || 'Could not load this payout.');
      }
    } finally {
      setLoading(false);
    }
  }, [periodId]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  function goBackToPay() {
    navigate('/staff-v2/pay');
  }

  // ── Render: loading ───────────────────────────────────────────────────
  if (loading && !data) {
    return (
      <>
        <DetailHead onBack={goBackToPay} />
        <Skeleton />
      </>
    );
  }

  // ── Render: 404 (no payout for this staffer + period) ─────────────────
  if (notFound) {
    return (
      <>
        <DetailHead onBack={goBackToPay} />
        <div className="sp-empty">
          <div className="sp-empty-icon">
            <DollarIcon size={22} />
          </div>
          <div className="sp-empty-title">No payout found.</div>
          <div>This pay period either doesn’t exist or you weren’t paid in it.</div>
          <button
            type="button"
            className="sp-btn sp-btn-sm"
            style={{ marginTop: '0.6rem' }}
            onClick={goBackToPay}
          >
            Back to Pay
          </button>
        </div>
      </>
    );
  }

  // ── Render: hard error ────────────────────────────────────────────────
  if (error && !data) {
    return (
      <>
        <DetailHead onBack={goBackToPay} />
        <div className="sp-error-card" style={{ marginTop: '0.6rem' }}>
          <div className="sp-error-card-msg">
            <strong>Couldn’t load this payout.</strong>
            <div className="sp-error-card-sub">{error}</div>
          </div>
          <button type="button" className="sp-btn sp-btn-sm" onClick={fetchDetail}>
            Retry
          </button>
        </div>
      </>
    );
  }

  // ── Render: detail ────────────────────────────────────────────────────
  const period = data?.period || {};
  const payout = data?.payout || {};
  const events = Array.isArray(data?.events) ? data.events : [];
  const summary = data?.summary || {};

  const isPaid = payout.status === 'paid';
  const total = Number.isFinite(payout.total_cents) ? payout.total_cents : 0;
  const eventCount = events.length;

  // PDF download wiring: paystub_storage_key signals an R2 object exists.
  // The client-facing download endpoint is NOT yet implemented (Phase 3 of
  // the staff-payment plan generates the PDF + serves it). Render the
  // button disabled with a TODO note when no endpoint exists, so the UX
  // path is visible to the staffer without a misleading "click does
  // nothing" state.
  const hasPaystub = !!payout.paystub_storage_key;

  return (
    <>
      <DetailHead onBack={goBackToPay} />

      <div>
        <div className="sp-detail-title">
          {isPaid ? 'Paystub' : 'Period preview'}
        </div>
        <div className="sp-detail-sub">
          {fmtPeriodRange(period.start_date, period.end_date)}
          {eventCount > 0 ? ` · ${eventCount} event${eventCount !== 1 ? 's' : ''}` : ''}
        </div>
      </div>

      {/* Total banner */}
      <div
        className={'sp-period-banner' + (isPaid ? '' : ' processing')}
        style={{ marginTop: '0.6rem' }}
      >
        <div className="sp-period-banner-head">
          <span className="sp-period-banner-dates">
            {isPaid ? 'Paid total' : 'Projected total'}
          </span>
          {isPaid ? (
            <span className="sp-chip ok">
              <span className="sp-chip-dot" />
              Paid
            </span>
          ) : (
            <span className="sp-chip info">
              <span className="sp-chip-dot" />
              {period.payday ? `Pays ${fmtShortDate(period.payday)}` : 'Processing'}
            </span>
          )}
        </div>
        <div className="sp-period-banner-total">{formatMoney(total)}</div>
        {isPaid && payout.paid_at && (
          <div className="sp-period-banner-foot">
            <span>Paid {fmtShortDate(payout.paid_at)}</span>
          </div>
        )}
        {!isPaid && period.payday && (
          <div className="sp-period-banner-foot">
            <span>Projected — live until payday.</span>
            <span>
              <strong>Pays {fmtShortDate(period.payday)}</strong>
            </span>
          </div>
        )}
      </div>

      {/* Summary card */}
      <div className="sp-card tight">
        <div className="sp-card-head">
          <div className="sp-card-title">Summary</div>
        </div>
        <div className="sp-line">
          <div className="sp-line-k">Wages</div>
          <div className="sp-line-v">{formatMoney(coerceCents(summary.wages_cents))}</div>
        </div>
        {coerceCents(summary.gratuity_cents) > 0 && (
          <div className="sp-line">
            <div className="sp-line-k">Gratuity share</div>
            <div className="sp-line-v">{formatMoney(coerceCents(summary.gratuity_cents))}</div>
          </div>
        )}
        {coerceCents(summary.card_tips_gross_cents) > 0 && (
          <>
            <div className="sp-line">
              <div className="sp-line-k">Card tips (gross)</div>
              <div className="sp-line-v">
                {formatMoney(coerceCents(summary.card_tips_gross_cents))}
              </div>
            </div>
            <div className="sp-line">
              <div className="sp-line-k">Card processing fee</div>
              <div className="sp-line-v neg">
                {formatMoney(-Math.abs(coerceCents(summary.card_processing_fee_cents)))}
              </div>
            </div>
          </>
        )}
        {coerceCents(summary.adjustments_cents) !== 0 && (
          <div className="sp-line">
            <div className="sp-line-k">Adjustments</div>
            <div
              className={
                'sp-line-v' + (coerceCents(summary.adjustments_cents) < 0 ? ' neg' : '')
              }
            >
              {formatMoney(coerceCents(summary.adjustments_cents))}
            </div>
          </div>
        )}
        <div className="sp-line total">
          <div className="sp-line-k">Payout total</div>
          <div className="sp-line-v">{formatMoney(total)}</div>
        </div>
      </div>

      {/* Per-event detail cards */}
      <div className="sp-section-title">Events worked</div>
      {events.length === 0 ? (
        <div className="sp-empty">
          <div className="sp-empty-icon">
            <DollarIcon size={22} />
          </div>
          <div className="sp-empty-title">No line items yet.</div>
          <div>Events you worked this period will show here.</div>
        </div>
      ) : (
        events.map((ev) => (
          <PayoutEventRow
            key={ev.shift_id}
            event={ev}
            highlight={
              Number.isFinite(highlightShiftId) && ev.shift_id === highlightShiftId
            }
          />
        ))
      )}

      {/* Pay actions */}
      <div className="sp-row" style={{ gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.8rem' }}>
        {isPaid && (
          // TODO: wire to GET /api/me/payouts/:periodId/paystub.pdf when the
          // backend lands (Phase 3 of the staff-payment plan). Until then we
          // render the button disabled so the UX path is visible and so a
          // staffer doesn't tap a no-op affordance.
          <button
            type="button"
            className="sp-btn"
            disabled={!hasPaystub}
            title={hasPaystub ? 'Paystub download coming soon' : 'Paystub not yet generated'}
          >
            <DownloadIcon size={13} />
            Download PDF
          </button>
        )}
        {/* TODO: wire to POST /api/me/payouts/:periodId/email when the backend
            lands. Until then this button stays disabled — see Phase 3 plan. */}
        <button
          type="button"
          className="sp-btn sp-btn-ghost"
          disabled
          title="Email-a-copy coming soon"
        >
          <MailIcon size={13} />
          Email a copy
        </button>
      </div>

      {/* 1099 reminder per spec §6.7 — small italic footer */}
      <div
        style={{
          fontSize: 11,
          color: 'var(--sp-ink-3)',
          marginTop: '0.8rem',
          fontStyle: 'italic',
          lineHeight: 1.55,
        }}
      >
        Cash &amp; app tips you split honor-system the night of the event aren’t on this
        document. Figures are 1099 income, no taxes withheld.
      </div>
    </>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function DetailHead({ onBack }) {
  return (
    <div className="sp-detail-head">
      <button type="button" className="sp-back" onClick={onBack}>
        <BackIcon size={14} />
        Back to Pay
      </button>
    </div>
  );
}

function Skeleton() {
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}
      aria-hidden="true"
    >
      {Array.from({ length: 3 }).map((_, i) => (
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

// ── Helpers ───────────────────────────────────────────────────────────────

function parsePositiveInt(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function coerceCents(v) {
  return Number.isFinite(v) ? v : 0;
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

function fmtPeriodRange(startIso, endIso) {
  if (!startIso || !endIso) return '';
  const s = new Date(`${String(startIso).slice(0, 10)}T12:00:00`);
  const e = new Date(`${String(endIso).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '';
  const sameMonth =
    s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
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

// ── Inline icons (Lucide-style at 1.75 stroke, matches StaffShell) ────────

function BackIcon({ size = 14 }) {
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
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function DownloadIcon({ size = 13 }) {
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
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function MailIcon({ size = 13 }) {
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
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <polyline points="3 7 12 13 21 7" />
    </svg>
  );
}

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
