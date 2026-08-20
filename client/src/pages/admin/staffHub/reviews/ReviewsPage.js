import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import api from '../../../../utils/api';
import { useToast } from '../../../../context/ToastContext';
import { fmt$fromCents } from '../../../../components/adminos/format';
import LogReviewForm from './LogReviewForm';
import PendingReviewCard from './PendingReviewCard';
import ResolvedTable from './ResolvedTable';
import ContestRail from './ContestRail';

/**
 * Reviews, a Staff hub child (spec §7): no internal tabs. Pending reviews are
 * workbench cards, resolved ones are table rows, the contest is a rail. The
 * bounty figure and the all-time totals come from the list envelope; the page
 * embeds no dollar literal.
 *
 * The hub owns the page header, so this child registers its one action
 * ("Log a Google review") through setActions and owns the modal it opens.
 */
export default function ReviewsPage() {
  const toast = useToast();
  const { summary, refresh, setActions } = useOutletContext() || {};
  const [reviews, setReviews] = useState([]);
  const [staff, setStaff] = useState([]);
  const [meta, setMeta] = useState({ bounty_cents: 0, bounties_paid_cents: 0, total_logged: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [duplicateWarning, setDuplicateWarning] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  // Review ids whose confirm returned materialized:0 this session (bounty
  // waiting for an open period). The server has no such flag on the row; the
  // resolved table shows the marker until the next reload proves otherwise.
  const [waitingIds, setWaitingIds] = useState(() => new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, roster] = await Promise.all([
        api.get('/admin/staff-reviews'),
        api.get('/admin/active-staff?limit=100'),
      ]);
      setReviews(list.data?.reviews || []);
      setMeta({
        bounty_cents: Number(list.data?.bounty_cents) || 0,
        bounties_paid_cents: Number(list.data?.bounties_paid_cents) || 0,
        total_logged: Number(list.data?.total_logged) || 0,
      });
      setStaff(roster.data?.staff || []);
    } catch (err) {
      setError(err?.message || 'Failed to load reviews.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!setActions) return undefined;
    setActions(
      <button type="button" className="btn btn-primary" onClick={() => setLogOpen(true)}>
        Log a Google review
      </button>
    );
    return () => setActions(null);
  }, [setActions]);

  const changed = useCallback((result) => {
    if (result && result.reviewId && result.materialized === 0 && result.bountyEligible) {
      setWaitingIds(s => new Set([...s, result.reviewId]));
      toast.success('Confirmed. The bounty waits for the next open pay run.');
    }
    load();
    if (refresh) refresh();
  }, [load, refresh, toast]);

  const pending = useMemo(() => reviews.filter(r => r.status === 'pending'), [reviews]);
  // The rail's floor pointer needs the SAVED credit names of the first pending
  // review; a suggestion is not a credit and must not appear here.
  const pendingNames = useMemo(
    () => (pending.length ? (pending[0].credits || []).map(c => c.name) : []),
    [pending]
  );

  // The modal renders in every state so the header action is never dead: the
  // hub keeps showing it while the list is loading or errored.
  let content;
  if (loading && reviews.length === 0) {
    content = <div className="muted">Loading…</div>;
  } else if (error) {
    content = (
      <div className="card"><div className="card-body">
        <p style={{ marginTop: 0 }}>{error}</p>
        <button type="button" className="btn" onClick={load}>Retry</button>
      </div></div>
    );
  } else {
    content = (
      <>
        <div className="muted tiny" style={{ marginBottom: 12 }}>
          Thumbtack reviews arrive on their own · log Google reviews by hand
        </div>

        {duplicateWarning && (
          <div className="card" style={{ marginBottom: 'var(--gap)', borderColor: 'hsl(var(--warn-h) var(--warn-s) 50%)' }}>
            <div className="card-body">
              <strong>Possible duplicate.</strong>{' '}
              A Thumbtack review is already logged for that date. Check the list below before confirming both.
            </div>
          </div>
        )}

        <div className="reviews-grid">
          <div className="vstack" style={{ gap: 'var(--gap)' }}>
            {pending.map(r => (
              <PendingReviewCard
                key={r.id}
                review={r}
                staff={staff}
                bountyCents={meta.bounty_cents}
                openPeriod={summary?.open_period || null}
                onChanged={changed}
                onError={(msg) => toast.error(msg)}
              />
            ))}
            <ResolvedTable
              reviews={reviews}
              bountyCents={meta.bounty_cents}
              waitingIds={waitingIds}
              onChanged={changed}
              onError={(msg) => toast.error(msg)}
            />
            <p className="tiny muted" style={{ margin: 0 }}>
              All time: {meta.total_logged} logged · {fmt$fromCents(meta.bounties_paid_cents)} in bounties paid ·
              {' '}bounty is {fmt$fromCents(meta.bounty_cents)} flat, five stars with a name required.
            </p>
          </div>
          <div className="vstack" style={{ gap: 'var(--gap)' }}>
            <ContestRail
              openPeriod={summary?.open_period || null}
              pendingNames={pendingNames}
              onAwarded={() => { if (refresh) refresh(); }}
            />
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <LogReviewForm
        open={logOpen}
        onClose={() => setLogOpen(false)}
        onCreated={(dup) => { setDuplicateWarning(dup); setLogOpen(false); changed(); }}
        onError={(msg) => toast.error(msg)}
      />
      {content}
    </>
  );
}
