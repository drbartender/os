import React, { memo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../utils/api';
import { useToast } from '../context/ToastContext';
import { PUBLIC_SITE_URL } from '../utils/constants';
import Icon from './adminos/Icon';
import StatusChip from './adminos/StatusChip';
import ShoppingListButton from './ShoppingList/ShoppingListButton';

const DRINK_PLAN_STATUS = {
  pending: { label: 'Pending', kind: 'neutral' },
  draft: { label: 'Draft', kind: 'neutral' },
  submitted: { label: 'Submitted', kind: 'info' },
  reviewed: { label: 'Reviewed', kind: 'ok' },
};

function formatDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function DrinkPlanCard({ proposalId, drinkPlan, setDrinkPlan, loading }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    try {
      const res = await api.post(`/drink-plans/for-proposal/${proposalId}`);
      setDrinkPlan(res.data);
      toast.success('Drink plan link generated.');
    } catch (err) {
      toast.error(err.message || 'Failed to generate drink plan.');
    }
  };

  const markReviewed = async () => {
    try {
      const res = await api.patch(`/drink-plans/${drinkPlan.id}/status`, { status: 'reviewed' });
      setDrinkPlan(prev => ({ ...prev, status: res.data.status }));
      toast.success('Drink plan marked as reviewed.');
    } catch (err) {
      toast.error(err.message || 'Failed to update status.');
    }
  };

  const copyLink = () => {
    const url = `${PUBLIC_SITE_URL}/plan/${drinkPlan.token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Drink plan</h3>
        {drinkPlan && (
          <StatusChip kind={(DRINK_PLAN_STATUS[drinkPlan.status] || {}).kind || 'neutral'}>
            {(DRINK_PLAN_STATUS[drinkPlan.status] || {}).label || drinkPlan.status}
          </StatusChip>
        )}
      </div>
      <div className="card-body">
        {loading ? (
          <div className="muted tiny">Loading…</div>
        ) : drinkPlan ? (
          <>
            <dl className="dl" style={{ gridTemplateColumns: '120px 1fr', margin: 0 }}>
              {drinkPlan.submitted_at && (
                <>
                  <dt>Submitted</dt>
                  <dd>{formatDateTime(drinkPlan.submitted_at)}</dd>
                </>
              )}
              {drinkPlan.serving_type && (
                <>
                  <dt>Serving</dt>
                  <dd>{drinkPlan.serving_type.replace(/_/g, ' ')}</dd>
                </>
              )}
            </dl>
            <div className="vstack" style={{ gap: 6, marginTop: 12 }}>
              <button type="button" className="btn btn-secondary btn-sm" style={{ justifyContent: 'center' }}
                onClick={() => navigate(`/drink-plans/${drinkPlan.id}`)}>
                <Icon name="external" size={11} />View details
              </button>
              <button type="button" className="btn btn-ghost btn-sm" style={{ justifyContent: 'center' }}
                onClick={copyLink}>
                <Icon name="copy" size={11} />{copied ? 'Copied!' : 'Copy client link'}
              </button>
              {(drinkPlan.status === 'submitted' || drinkPlan.status === 'reviewed') && (
                <ShoppingListButton planId={drinkPlan.id} planToken={drinkPlan.token} />
              )}
              {drinkPlan.status === 'submitted' && (
                <button type="button" className="btn btn-primary btn-sm" style={{ justifyContent: 'center' }}
                  onClick={markReviewed}>
                  <Icon name="check" size={11} />Mark reviewed
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="muted tiny" style={{ marginBottom: 8 }}>No drink plan yet.</div>
            <button type="button" className="btn btn-primary btn-sm" onClick={generate}>
              <Icon name="plus" size={11} />Generate plan link
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default memo(DrinkPlanCard);
