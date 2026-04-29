import React from 'react';
import { fmtDate } from '../../../../components/adminos/format';
import { relDay, dayDiff, SCORECARD_DIMS } from '../helpers';

// Pipeline stats summary on the right rail. Pure presentational.
export default function StatsCard({ a, scorecard }) {
  const days = dayDiff(a.applied_at);
  const total = scorecard
    ? SCORECARD_DIMS.reduce((s, d) => s + (scorecard[d.key] || 0), 0)
    : 0;
  const filled = scorecard
    ? SCORECARD_DIMS.filter(d => scorecard[d.key] != null).length
    : 0;

  return (
    <div className="card">
      <div className="card-head"><h3>Pipeline stats</h3></div>
      <div className="card-body">
        <dl className="dl">
          <dt>Applied</dt>
          <dd>{relDay(a.applied_at)} <span className="muted">· {fmtDate(a.applied_at)}</span></dd>
          <dt>Days in pipeline</dt>
          <dd className="num">{days != null ? days : '—'}</dd>
          {a.referral_source && (<><dt>Referral</dt><dd>{a.referral_source}</dd></>)}
          {a.interview_at && (
            <>
              <dt>Interview</dt>
              <dd>
                {new Date(a.interview_at).toLocaleString([], {
                  weekday: 'short', month: 'short', day: 'numeric',
                  hour: 'numeric', minute: '2-digit',
                })}
              </dd>
            </>
          )}
          {scorecard && filled > 0 && (
            <>
              <dt>Score</dt>
              <dd className="num">{total} / 25</dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}
