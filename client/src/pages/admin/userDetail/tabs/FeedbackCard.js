import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../../../utils/api';
import { useToast } from '../../../../context/ToastContext';
import StatusChip from '../../../../components/adminos/StatusChip';

// Guest feedback left on this bartender's tip thank-you page (spec section 9).
// Per-person, so it lives on the profile; the server also emails the inbox on
// every submission. Endpoints are adminOnly: the parent renders this card for
// admins only, so a manager never sees a 403 card.
// tip_page_feedback.rating is 1..3 by DB CHECK (server/db/schema.sql): 3 = good.
function ratingKind(rating) {
  const r = Number(rating);
  if (r >= 3) return 'ok';
  if (r >= 2) return 'warn';
  return 'danger';
}

export default function FeedbackCard({ userId }) {
  const toast = useToast();
  const [feedback, setFeedback] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busyId, setBusyId] = useState(null);
  // Sequence guard: the profile can swap userId without unmounting this card,
  // and Retry can be clicked twice, so only the newest read may write state.
  const reqSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++reqSeq.current;
    setLoading(true); setError(false);
    api.get(`/admin/tip-feedback?status=all&target_user_id=${encodeURIComponent(userId)}`)
      .then(r => { if (seq === reqSeq.current) setFeedback(r.data?.feedback || []); })
      .catch(() => { if (seq === reqSeq.current) setError(true); })
      .finally(() => { if (seq === reqSeq.current) setLoading(false); });
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  async function markReviewed(id) {
    setBusyId(id);
    try { await api.post(`/admin/tip-feedback/${id}/review`); load(); }
    catch (err) { toast.error(err?.message || 'Failed to mark reviewed.'); }
    finally { setBusyId(null); }
  }

  return (
    <div className="card">
      <div className="card-head"><h3>Feedback</h3><span className="k">{feedback.length}</span></div>
      <div className="card-body vstack" style={{ gap: 12 }}>
        {loading && <div className="muted">Loading…</div>}
        {!loading && error && (
          <div className="hstack" style={{ gap: 8 }}><span className="muted">Could not load feedback.</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={load}>Retry</button></div>
        )}
        {!loading && !error && feedback.length === 0 && (
          <p className="muted" style={{ margin: 0 }}>No feedback yet. Guests can leave a rating and a note from this bartender's thank-you page; each one also emails the inbox.</p>
        )}
        {!loading && feedback.map(f => (
          <article key={f.id} style={{ borderTop: '1px solid var(--line-1)', paddingTop: 10 }}>
            <div className="hstack" style={{ gap: 8, flexWrap: 'wrap' }}>
              <StatusChip kind={ratingKind(f.rating)}>{f.rating}/3</StatusChip>
              {f.reviewed_at && <span className="muted tiny">reviewed</span>}
              <span className="spacer" />
              <span className="muted tiny">{f.created_at ? new Date(f.created_at).toLocaleString('en-US', { hour12: false }) : '—'}</span>
            </div>
            {f.comment ? <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>"{f.comment}"</p> : <p className="muted" style={{ margin: '6px 0 0' }}>No comment.</p>}
            {f.submitter_email && <p className="muted tiny" style={{ margin: '6px 0 0' }}>Customer: {f.submitter_email}</p>}
            {!f.reviewed_at && (
              <div style={{ marginTop: 8 }}>
                <button type="button" className="btn btn-sm" disabled={busyId === f.id} onClick={() => markReviewed(f.id)}>
                  {busyId === f.id ? 'Marking…' : 'Mark reviewed'}
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
