import React, { useState } from 'react';
import api from '../../../../utils/api';
import EntityLink from '../../../../components/EntityLink';
import StatusChip from '../../../../components/adminos/StatusChip';
import { fmt$fromCents, fmtDate } from '../../../../components/adminos/format';
import { sourceLabel } from './reviewSource';

// Confirmed and dismissed reviews collect here as rows (spec §7). Bounty is
// derived from the row plus the envelope's bounty_cents, never a literal:
// five stars with at least one credited staffer pays bounty x credits, a
// confirmed row without either pays nothing, a dismissed row pays nothing at
// all. waitingIds carries the third state: a confirm whose bounty line could
// not be written because no pay period is open.
//
// LOCK COPY, one place, because the button title and the toast must not tell an
// admin two different stories about the same row. Keyed on the server's
// `bounty_lock` ('paid' | 'processing' | null), which is derived from the same
// lockReasonOf() the dismiss refusal uses.
const LOCK_REASON = {
  paid: 'That bounty is already paid, so it cannot be dismissed.',
  processing: 'That bounty is in a pay run that is processing. Dismiss reopens once it finishes.',
};

// A confirmed row keeps its Dismiss (spec §7): dismissal has to stay reachable
// after a confirm, both to undo one and because the server's refusal while a
// bounty is paid or frozen only exists for confirmed rows.
// FIXED 2026-08-21: this used to say "the list payload carries no per-review
// paid flag, so the button cannot state that reason up front; the server's 409
// is what surfaces". The payload carries `bounty_lock` now, so the button is
// disabled with the reason BEFORE the click, which is what spec §7 promised and
// only half of what was built. The 409 stays as the real gate -- a row can lock
// between render and click -- and its sentence now names the same state.
const statusKind = (s) => (s === 'confirmed' ? 'ok' : s === 'dismissed' ? 'warn' : 'accent');

const excerptOf = (text) => (text.length > 60 ? `${text.slice(0, 60)}…` : text);

export default function ResolvedTable({ reviews, bountyCents, waitingIds, onChanged, onError }) {
  const rows = (reviews || []).filter(r => r.status !== 'pending');
  // Busy is held per row, so one dismissal in flight never freezes the others.
  const [busyId, setBusyId] = useState(null);

  async function dismiss(id) {
    setBusyId(id);
    try {
      await api.post(`/admin/staff-reviews/${id}/dismiss`);
      if (onChanged) onChanged();
    } catch (err) {
      if (onError) onError(err?.message || 'That action failed. Try again.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="card-head"><h3>Resolved</h3><span className="k">{rows.length}</span></div>
      {rows.length === 0 ? (
        <div className="card-body muted">Nothing resolved yet. Confirmed and dismissed reviews collect here as rows.</div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Date</th>
                <th>Review</th>
                <th>Credited</th>
                <th>Status</th>
                <th className="num">Bounty</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const credits = r.credits || [];
                const paysBounty = r.status === 'confirmed' && Number(r.stars) === 5 && credits.length > 0;
                const waiting = !!(waitingIds && waitingIds.has(r.id));
                return (
                  <tr key={r.id}>
                    <td className="muted">{fmtDate(String(r.review_date || '').slice(0, 10))}</td>
                    <td>
                      <span style={{ color: 'hsl(var(--warn-h) var(--warn-s) 60%)' }}>★{Number(r.stars) || 0}</span>
                      {' · '}<span className="muted tiny">{sourceLabel(r.source)}</span>{' · '}
                      {r.excerpt
                        ? <span className="muted" title={r.excerpt}>"{excerptOf(r.excerpt)}"</span>
                        : <span className="muted">no excerpt</span>}
                    </td>
                    <td>
                      {credits.length
                        ? credits.map((c, i) => (
                          <React.Fragment key={c.user_id}>
                            {i > 0 && ', '}
                            <EntityLink to={`/staffing/users/${c.user_id}`}>{c.name}</EntityLink>
                          </React.Fragment>
                        ))
                        : <span className="muted">no staffer named</span>}
                    </td>
                    <td><StatusChip kind={statusKind(r.status)}>{r.status}</StatusChip></td>
                    <td className="num">
                      {r.status === 'dismissed'
                        ? <span className="muted">—</span>
                        : paysBounty
                          ? (
                            <>
                              {fmt$fromCents(bountyCents * credits.length)}
                              {waiting && <span className="muted tiny"> · waiting for an open period</span>}
                            </>
                          )
                          : <span className="muted">no bounty</span>}
                    </td>
                    <td className="shrink">
                      {r.status === 'confirmed' && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={busyId === r.id || !!r.bounty_lock}
                          title={r.bounty_lock ? LOCK_REASON[r.bounty_lock] : undefined}
                          onClick={() => dismiss(r.id)}
                        >
                          {busyId === r.id ? 'Dismissing…' : 'Dismiss'}
                        </button>
                      )}
                      {r.status === 'confirmed' && r.bounty_lock && (
                        // The reason has to be READABLE, not only hoverable: a
                        // title attribute is invisible on touch and to a keyboard
                        // user, and this is the whole point of the disable.
                        <div className="muted tiny">
                          {r.bounty_lock === 'paid' ? 'bounty paid' : 'pay run processing'}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
