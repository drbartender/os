import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Drawer from '../../../components/adminos/Drawer';
import StatusChip from '../../../components/adminos/StatusChip';
import api from '../../../utils/api';
import { getEventTypeLabel } from '../../../utils/eventTypes';
import { servingLabel } from '../../../utils/servingLabels';
import { drinkPlanStatusMeta } from '../../../utils/drinkPlanStatusMap';

// Client drink plans, compact review list (Potions design 1a). Plans are
// usually reached from their event; this is the quick queue plus a link to
// the kept-alive full index at /drink-plans.

export default function PlansDrawer({ open, onClose }) {
  const [plans, setPlans] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || plans !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/drink-plans?limit=100');
        if (!cancelled) { setPlans(res.data || []); setError(''); }
      } catch (err) {
        if (!cancelled) setError('Could not load plans.');
      }
    })();
    return () => { cancelled = true; };
  }, [open, plans]);

  const retry = () => { setError(''); setPlans(null); };

  return (
    <Drawer open={open} onClose={onClose} crumb={<span className="drawer-crumb">Potions · Client plans</span>}>
      <div className="potions-drawer-intro text-muted text-small">
        Submitted with each event; your menu cocktails are derived from these.
        You will usually open a plan from its event. This is the review queue.
      </div>

      {error && (
        <div className="potions-drawer-state">
          <span className="text-muted">{error}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>Retry</button>
        </div>
      )}
      {!error && plans === null && (
        <div className="potions-drawer-state text-muted">Loading plans…</div>
      )}
      {!error && plans !== null && plans.length === 0 && (
        <div className="potions-drawer-state text-muted">No plans yet.</div>
      )}

      {!error && plans !== null && plans.map((p) => {
        const status = drinkPlanStatusMeta(p.status);
        const meta = [
          p.event_date ? new Date(p.event_date).toLocaleDateString() : null,
          p.guest_count ? `${p.guest_count} guests` : null,
          servingLabel(p.serving_type) || null,
        ].filter(Boolean).join(' · ');
        const drinks = (p.drink_names || []).join(' · ');
        return (
          <Link key={p.id} to={`/drink-plans/${p.id}`} className="potions-drawer-row" onClick={onClose}>
            <div className="potions-drawer-row-main">
              <div className="potions-drawer-row-name">
                {p.client_name || 'Unnamed client'}
                <span className="text-muted"> · {getEventTypeLabel(p)}</span>
              </div>
              {meta && <div className="potions-drawer-row-meta text-muted text-small">{meta}</div>}
              {drinks && <div className="potions-drawer-row-meta text-muted text-small">{drinks}</div>}
            </div>
            <div className="potions-drawer-row-chips">
              <StatusChip kind={status.kind}>{status.label}</StatusChip>
              {p.shopping_list_status === 'pending_review' && (
                <StatusChip kind="warn">List to review</StatusChip>
              )}
            </div>
          </Link>
        );
      })}

      <div className="potions-drawer-footer">
        <Link to="/drink-plans" className="btn btn-secondary btn-sm" onClick={onClose}>Full index</Link>
      </div>
    </Drawer>
  );
}
