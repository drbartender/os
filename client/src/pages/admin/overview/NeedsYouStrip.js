import React from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../../../components/adminos/Icon';
import EntityLink from '../../../components/EntityLink';

// Real-link target for a needs-attention queue item. Event/shift/proposal items
// get a canonical entity link (cmd-click opens a new tab); hiring and other
// targetless items return null and stay plain text (the row onClick still
// navigates them).
function queueItemHref(a) {
  if (a.target === 'event') return `/events/${a.ref}`;
  if (a.target === 'shift') return `/events/shift/${a.ref}`;
  if (a.target === 'proposal') return `/proposals/${a.ref}`;
  if (a.target === 'payroll') return '/financials/payroll';
  return null;
}

// Icon by item type; later lanes append their own types (payout, prep) and fall
// through to the alert glyph until they extend this map.
const QUEUE_ICON = { unstaffed: 'userplus', proposal: 'eye', application: 'pen', payroll: 'dollar' };

// Full-width live triage strip. Accepts `items` in the existing actionQueue
// shape ({id,type,priority,title,sub,meta,target,ref}) so lanes c/d/e can append
// typed items (payroll overdue, unmatched payouts, prep stages) without touching
// the render.
export default function NeedsYouStrip({ items = [], loading = false }) {
  const navigate = useNavigate();
  const go = (a) => {
    if (a.target === 'event') navigate(`/events/${a.ref}`);
    else if (a.target === 'shift') navigate(`/events/shift/${a.ref}`);
    else if (a.target === 'proposal') navigate(`/proposals/${a.ref}`);
    else if (a.target === 'payroll') navigate('/financials/payroll');
    else if (a.target === 'hiring') navigate('/hiring');
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3><Icon name="alert" size={12} /> Needs attention <span className="k">Live</span></h3>
        <span className="k">{items.length}</span>
      </div>
      <div className="needs-you-grid">
        {loading && items.length === 0 && (
          <div className="muted tiny" style={{ padding: '0.75rem 1rem', gridColumn: '1 / -1' }}>Loading…</div>
        )}
        {!loading && items.length === 0 && (
          <div className="muted tiny" style={{ padding: '0.75rem 1rem', gridColumn: '1 / -1' }}>Nothing pressing right now.</div>
        )}
        {items.map(a => (
          <div key={a.id} className="queue-item"
            onClick={() => go(a)}
            role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.click(); }}>
            <div className={`queue-icon ${a.priority}`}>
              <Icon name={QUEUE_ICON[a.type] || 'alert'} />
            </div>
            <div className="queue-main">
              <div className="queue-title">
                <EntityLink to={queueItemHref(a)} onClick={(e) => e.stopPropagation()}>{a.title}</EntityLink>
              </div>
              <div className="queue-sub">{a.sub}</div>
            </div>
            <div className="queue-meta">{a.meta}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
