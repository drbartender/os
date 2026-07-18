import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../../../components/adminos/Icon';
import EntityLink from '../../../components/EntityLink';
import { defaultTabKey } from './queueItems';
import PayrollStatus from './PayrollStatus';

// Tabbed Needs-attention triage card (spec 2026-07-14 §3). Tab headers do the
// summarizing (count + worst-priority dot); the body shows one category at a
// time. ALL panels stay mounted (inactive hidden by CSS) so the admin-only
// PayrollStatus block mounts once and background tabs feed their dots.

// Real-link target for a needs-attention queue item. Entity-backed items get a
// canonical link (cmd-click opens a new tab); hiring and other targetless
// items return null and stay plain text (the row onClick still navigates).
function queueItemHref(a) {
  if (a.target === 'event') return `/events/${a.ref}`;
  if (a.target === 'shift') return `/events/shift/${a.ref}`;
  if (a.target === 'proposal') return `/proposals/${a.ref}`;
  if (a.target === 'client') return `/clients/${a.ref}`;
  if (a.target === 'payouts') return '/dashboard?tab=payouts&show=unmatched';
  if (a.target === 'drink-plan') return `/drink-plans/${a.ref}`;
  if (a.target === 'sms') return `/messages?client=${a.ref}`;
  return null;
}

const QUEUE_ICON = {
  unstaffed: 'userplus', proposal: 'eye', application: 'pen',
  payouts: 'dollar', prep: 'flask', 'change-request': 'pen', sms: 'chat',
  'lead-call': 'alert',
};

const TAB_CAP = 6;

export default function NeedsYouStrip({ tabs = [], loading = false, isAdmin = false, onPayrollOverdue }) {
  const navigate = useNavigate();
  const [picked, setPicked] = useState(null);
  // Derived default follows the data as fetches resolve; a click sticks. A
  // picked Sales tab that empties away falls back to the computed default.
  const active = picked && tabs.some(t => t.key === picked) ? picked : defaultTabKey(tabs, isAdmin);

  const go = (a) => {
    const href = queueItemHref(a);
    if (href) navigate(href);
    else if (a.target === 'hiring') navigate('/hiring');
  };

  // Terminal collapsed state (manager with a clean board): no tab row, one
  // slim line. Never rendered while loading, so it cannot flash-expand.
  if (!loading && tabs.every(t => !t.hasBody)) {
    return (
      <div className="card">
        <div className="card-head">
          <h3><Icon name="alert" size={12} /> Needs attention <span className="k">Live</span></h3>
        </div>
        <div className="muted tiny nat-empty">Nothing pressing right now.</div>
      </div>
    );
  }

  const total = tabs.reduce((n, t) => n + t.count, 0);
  const showTabs = !(loading && total === 0);

  // role="button" activates on Enter AND Space (Space must not scroll the page).
  const rowKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); }
  };

  const renderRow = (a) => (
    <div key={a.id} className="queue-item"
      onClick={() => go(a)}
      role="button" tabIndex={0}
      onKeyDown={rowKeyDown}>
      <div className={`queue-icon ${a.priority}`}>
        <Icon name={QUEUE_ICON[a.type] || 'alert'} />
      </div>
      <div className="queue-main">
        <div className="queue-title">
          {/* tabIndex -1: the row is the one keyboard target; the anchor stays
              for mouse cmd-click-new-tab without doubling every tab stop. */}
          <EntityLink to={queueItemHref(a)} tabIndex={-1} onClick={(e) => e.stopPropagation()}>{a.title}</EntityLink>
        </div>
        <div className="queue-sub">{a.sub}</div>
      </div>
      <div className="queue-meta">{a.meta}</div>
    </div>
  );

  return (
    <div className="card">
      <div className="card-head">
        <h3><Icon name="alert" size={12} /> Needs attention <span className="k">Live</span></h3>
        {total > 0 && <span className="k">{total}</span>}
      </div>

      {!showTabs ? (
        <div className="muted tiny nat-empty">Loading&hellip;</div>
      ) : (
        <>
          <div className="nat-tabs">
            {tabs.map(t => (
              <button key={t.key} type="button"
                aria-pressed={active === t.key}
                className={`nat-tab${active === t.key ? ' is-active' : ''}${t.count === 0 && !t.dot ? ' is-empty' : ''}`}
                onClick={() => setPicked(t.key)}>
                {t.label} <span className="k">{t.count}</span>
                {t.dot && <span className={`nat-dot ${t.dot}`} />}
              </button>
            ))}
          </div>

          {tabs.map(t => (
            <div key={t.key} className={`nat-panel${active === t.key ? '' : ' is-hidden'}`}>
              {t.key === 'money' && isAdmin && <PayrollStatus onOverdue={onPayrollOverdue} />}
              {t.items.slice(0, TAB_CAP).map(renderRow)}
              {t.items.length > TAB_CAP && (
                <div className="queue-item nat-overflow"
                  onClick={() => navigate(t.overflowHref)}
                  role="button" tabIndex={0}
                  onKeyDown={rowKeyDown}>
                  <div className="queue-main">
                    <div className="queue-title">
                      <EntityLink to={t.overflowHref} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
                        {t.items.length - TAB_CAP} more
                      </EntityLink>
                    </div>
                  </div>
                  <div className="queue-meta">{t.items.length - TAB_CAP}</div>
                </div>
              )}
              {t.items.length === 0 && !(t.key === 'money' && isAdmin) && (
                <div className="muted tiny nat-empty">Nothing pressing.</div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
