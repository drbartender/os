import React, { useEffect, useMemo, useState } from 'react';
import api from '../../../../utils/api';
import EntityLink from '../../../../components/EntityLink';
import StatusChip from '../../../../components/adminos/StatusChip';
import { fmt$fromCents, fmtDate } from '../../../../components/adminos/format';
import { suggestNames } from './suggestNames';

// One pending review as a workbench card (spec §7). Moved from
// the retired Reviews page's ReviewCard; the credits PATCH, the frozen-credit alert,
// confirm, dismiss and the per-action busy lock are unchanged. What is new:
// a chip row instead of a multi-select, excerpt-derived name suggestions, and
// a Confirm label that tells the truth about when the money lands.

const statusKind = (status) => {
  if (status === 'confirmed') return 'ok';
  if (status === 'dismissed') return 'warn';
  return 'accent';
};

const nameOf = (s) => (s ? (s.display_name || s.preferred_name || s.email) : null);

export default function PendingReviewCard({ review, staff, bountyCents, openPeriod, onChanged, onError }) {
  // Saved credits are the server's truth for this row. Suggestions only fill
  // in when nothing is saved yet, and they are never PATCHed on render: the
  // admin has to press Save names, which is what the dirty guard below
  // enforces before Confirm can write any money.
  const saved = useMemo(
    () => (review.credits || []).map(c => String(c.user_id)),
    [review.credits]
  );
  const suggested = useMemo(
    () => (saved.length ? [] : suggestNames(review.excerpt, staff)),
    [saved, review.excerpt, staff]
  );
  const initial = useMemo(() => (saved.length ? saved : suggested), [saved, suggested]);

  const [selected, setSelected] = useState(initial);
  const [busy, setBusy] = useState(null);

  useEffect(() => { setSelected(initial); }, [initial]);

  const dirty = useMemo(() => (
    selected.length !== saved.length || selected.some(id => !saved.includes(id))
  ), [selected, saved]);

  const showSuggestionCaption = !saved.length && suggested.length > 0
    && selected.some(id => suggested.includes(id));

  async function run(label, fn) {
    setBusy(label);
    try {
      const result = await fn();
      onChanged(result);
    } catch (err) {
      onError(err?.message || 'That action failed. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const saveCredits = () => run('credits', () => api.patch(`/admin/staff-reviews/${review.id}`, {
    credited_user_ids: selected.map(Number),
  }).then((res) => {
    const frozen = res.data?.frozen_credit_removals || [];
    if (frozen.length) {
      onError('A bounty for this review is already paid, so it was left alone. An alert was raised for review.');
    }
  }));

  const stars5 = Number(review.stars) === 5;
  const bountyTotal = stars5 ? bountyCents * saved.length : 0;
  const openNow = !!(openPeriod && openPeriod.exists && openPeriod.status === 'open');
  const confirmLabel = busy === 'confirm' ? 'Confirming…'
    : !stars5 || saved.length === 0 ? 'Confirm, no bounty'
      : openNow ? `Confirm and pay ${fmt$fromCents(bountyTotal)}`
        : `Confirm, ${fmt$fromCents(bountyTotal)} waits for the next open run`;

  // The confirm result carries the third state (spec §7): materialized 0 on a
  // bounty-eligible confirm means the money is waiting for a period to open.
  const confirm = () => run('confirm', () => api
    .post(`/admin/staff-reviews/${review.id}/confirm`)
    .then((res) => ({
      reviewId: review.id,
      materialized: Number(res.data?.materialized),
      bountyEligible: stars5 && saved.length > 0,
    })));
  const dismiss = () => run('dismiss', () => api.post(`/admin/staff-reviews/${review.id}/dismiss`));

  return (
    <article className="card">
      <div className="card-head">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: 'hsl(var(--warn-h) var(--warn-s) 60%)', letterSpacing: 2 }}>
            {'★'.repeat(Number(review.stars) || 0)}
          </span>
          <StatusChip kind={statusKind(review.status)}>{review.status}</StatusChip>
          <span className="muted tiny">{review.source}</span>
        </h3>
        <span className="muted tiny">{fmtDate(String(review.review_date || '').slice(0, 10), { year: 'numeric' })}</span>
      </div>
      <div className="card-body">
        {review.excerpt
          ? <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>"{review.excerpt}"</p>
          : <p className="muted" style={{ margin: 0 }}>No excerpt.</p>}

        {review.proposal_id && (
          <p className="muted tiny" style={{ marginTop: 8, marginBottom: 0 }}>
            Linked event: <EntityLink to={`/proposals/${review.proposal_id}`}>proposal {review.proposal_id}</EntityLink>
          </p>
        )}

        <div style={{ marginTop: 12, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 280px' }}>
            <div className="section-title">Named staff</div>
            <div className="hstack" style={{ gap: 6, flexWrap: 'wrap' }}>
              {selected.map(id => {
                const s = staff.find(x => String(x.id) === id);
                return (
                  <span key={id} className="chip accent" style={{ height: 24, padding: '1px 4px 1px 10px' }}>
                    {nameOf(s) || `user ${id}`}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label={`Remove ${nameOf(s) || id}`}
                      onClick={() => setSelected(sel => sel.filter(x => x !== id))}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
              <select
                value=""
                aria-label="Add a name"
                onChange={e => {
                  const v = e.target.value;
                  if (v && !selected.includes(v)) setSelected(sel => [...sel, v]);
                }}
              >
                <option value="">{staff.length >= 100 ? '+ Add a name (first 100 staff shown)' : '+ Add a name'}</option>
                {staff.filter(s => !selected.includes(String(s.id))).map(s => (
                  <option key={s.id} value={String(s.id)}>{nameOf(s)}</option>
                ))}
              </select>
            </div>
            {showSuggestionCaption && (
              <div className="tiny muted" style={{ marginTop: 4 }}>Suggested from the excerpt. Save names to keep them.</div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn"
              disabled={!dirty || busy !== null}
              onClick={saveCredits}
            >
              {busy === 'credits' ? 'Saving…' : 'Save names'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null || dirty || review.status === 'confirmed'}
              title={dirty ? 'Save names first' : undefined}
              onClick={confirm}
            >
              {confirmLabel}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy !== null || review.status === 'dismissed'}
              onClick={dismiss}
            >
              {busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
            </button>
          </div>
        </div>

        <p className="muted tiny" style={{ marginTop: 10, marginBottom: 0 }}>
          {stars5
            ? 'Confirming pays each named staffer the bounty into the open pay run, or the next one to open.'
            : 'Only five-star reviews carry a bounty.'}
        </p>
      </div>
    </article>
  );
}
