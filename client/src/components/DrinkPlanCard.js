import React, { memo, useState, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../utils/api';
import { useToast } from '../context/ToastContext';
import { PUBLIC_SITE_URL } from '../utils/constants';
import Icon from './adminos/Icon';
import StatusChip from './adminos/StatusChip';
import ShoppingListButton from './ShoppingList/ShoppingListButton';

// Lazy so the consult form (and its cocktail/mocktail dependency graph) stays
// out of the bundle for sessions that never open it.
const ConsultationForm = lazy(() => import('./ShoppingList/ConsultationForm'));

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

// `fullControls` turns on the admin-prep controls (consult input + the
// shopping-list button gated the same way as the full drink-plan page). It's
// the canonical event-side surface; the proposal-side card stays a lean
// preview and leaves these off.
function DrinkPlanCard({ proposalId, drinkPlan, setDrinkPlan, loading, fullControls = false, guestCount, reload }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [consultOpen, setConsultOpen] = useState(false);
  const [consultCatalogs, setConsultCatalogs] = useState(null);
  const [consultLoading, setConsultLoading] = useState(false);

  const generate = async () => {
    try {
      const res = await api.post(`/drink-plans/for-proposal/${proposalId}`);
      setDrinkPlan(res.data);
      if (reload) await reload(); // refresh the Messages card if a client email fired
      toast.success('Drink plan link generated.');
    } catch (err) {
      toast.error(err.message || 'Failed to generate drink plan.');
    }
  };

  const refetch = async () => {
    try {
      const res = await api.get(`/drink-plans/by-proposal/${proposalId}`);
      setDrinkPlan(res.data);
    } catch (err) {
      // Non-fatal — the action that triggered this already toasted on failure.
    }
  };

  const markReviewed = async () => {
    try {
      const res = await api.patch(`/drink-plans/${drinkPlan.id}/status`, { status: 'reviewed' });
      setDrinkPlan(prev => ({ ...prev, status: res.data.status }));
      if (reload) await reload(); // refresh the Messages card if a client email fired
      toast.success('Drink plan marked as reviewed.');
    } catch (err) {
      toast.error(err.message || 'Failed to update status.');
    }
  };

  const finalize = async () => {
    // Soft-warn on unpaid drink-plan extras. The server is the real gate (it
    // re-detects the open extras invoice and requires overrideUnpaidExtras); this
    // confirm is UX, and we forward the override only after the admin agrees.
    const unpaidCents = Number(drinkPlan.extras_unpaid_cents) || 0;
    if (unpaidCents > 0) {
      const dollars = (unpaidCents / 100).toFixed(2);
      if (!window.confirm(`This plan has $${dollars} in unpaid extras. Finalize anyway? The extras invoice stays open and can still be collected.`)) return;
    }
    try {
      const res = await api.post(
        `/drink-plans/${drinkPlan.id}/finalize`,
        unpaidCents > 0 ? { overrideUnpaidExtras: true } : {}
      );
      setDrinkPlan(res.data);
      if (reload) await reload(); // refresh the Messages card if a client email fired
      toast.success('BEO finalized. Staff will be nudged 3 days before the event.');
    } catch (err) {
      // If the server's authoritative gate rejects (409) — e.g. our badge was
      // stale and we finalized without the override — refetch so the unpaid-extras
      // badge appears and the admin can retry through the confirm flow.
      if (err.response?.status === 409) { await refetch(); }
      toast.error(err.response?.data?.error || err.message || 'Finalize failed.');
    }
  };

  const unfinalize = async () => {
    if (!window.confirm('Unfinalize the BEO? Pending staff nudges will be suppressed and all acknowledgments cleared.')) return;
    try {
      const res = await api.post(`/drink-plans/${drinkPlan.id}/unfinalize`);
      setDrinkPlan(res.data);
      toast.success('BEO unfinalized.');
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Unfinalize failed.');
    }
  };

  const copyLink = () => {
    const url = `${PUBLIC_SITE_URL}/plan/${drinkPlan.token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const openConsult = async () => {
    if (consultCatalogs) {
      setConsultOpen(true);
      return;
    }
    setConsultLoading(true);
    try {
      const [cocktailsRes, mocktailsRes] = await Promise.all([
        api.get('/cocktails'),
        api.get('/mocktails').catch(() => ({ data: { mocktails: [] } })),
      ]);
      setConsultCatalogs({
        cocktails: cocktailsRes.data.cocktails || [],
        mocktails: mocktailsRes.data.mocktails || [],
      });
      setConsultOpen(true);
    } catch (err) {
      toast.error(err.message || 'Failed to load drink catalog.');
    } finally {
      setConsultLoading(false);
    }
  };

  const showShoppingList = drinkPlan && (
    drinkPlan.status === 'submitted' ||
    drinkPlan.status === 'reviewed' ||
    (fullControls && drinkPlan.has_shopping_list)
  );

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
            {Number(drinkPlan.extras_unpaid_cents) > 0 && (
              <div className="tiny" style={{ marginTop: 10, fontWeight: 600, color: '#c0392b' }}>
                Extras unpaid: ${(Number(drinkPlan.extras_unpaid_cents) / 100).toFixed(2)}
              </div>
            )}
            <div className="vstack" style={{ gap: 6, marginTop: 12 }}>
              <button type="button" className="btn btn-secondary btn-sm" style={{ justifyContent: 'center' }}
                onClick={() => navigate(`/drink-plans/${drinkPlan.id}`)}>
                <Icon name="external" size={11} />View details
              </button>
              <button type="button" className="btn btn-secondary btn-sm" style={{ justifyContent: 'center' }}
                onClick={copyLink}>
                <Icon name="copy" size={11} />{copied ? 'Copied!' : 'Copy client link'}
              </button>
              {fullControls && (
                <button type="button" className="btn btn-secondary btn-sm" style={{ justifyContent: 'center' }}
                  onClick={openConsult} disabled={consultLoading}>
                  <Icon name="flask" size={11} />
                  {consultLoading
                    ? 'Loading…'
                    : drinkPlan.has_consult_selections ? 'Edit consult input' : 'Input from consult'}
                </button>
              )}
              {showShoppingList && (
                <ShoppingListButton
                  planId={drinkPlan.id}
                  planToken={drinkPlan.token}
                  className="btn btn-secondary btn-sm"
                  style={{ justifyContent: 'center' }}
                  iconSize={11}
                />
              )}
              {drinkPlan.status === 'submitted' && (
                <button type="button" className="btn btn-primary btn-sm" style={{ justifyContent: 'center' }}
                  onClick={markReviewed}>
                  <Icon name="check" size={11} />Mark reviewed
                </button>
              )}
              {drinkPlan.status === 'reviewed' && !drinkPlan.finalized_at && (
                <button type="button" className="btn btn-primary btn-sm" style={{ justifyContent: 'center' }} onClick={finalize}>
                  <Icon name="check" size={11} />Finalize BEO
                </button>
              )}
              {drinkPlan.finalized_at && (
                <>
                  <div className="muted tiny" style={{ marginTop: 4 }}>
                    Finalized {formatDateTime(drinkPlan.finalized_at)}
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm" style={{ justifyContent: 'center' }} onClick={unfinalize}>
                    Unfinalize
                  </button>
                </>
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

      {fullControls && consultOpen && consultCatalogs && (
        <Suspense fallback={null}>
          <ConsultationForm
            planId={drinkPlan.id}
            isOpen={consultOpen}
            onClose={() => setConsultOpen(false)}
            onSaved={refetch}
            cocktails={consultCatalogs.cocktails}
            mocktails={consultCatalogs.mocktails}
            planContext={{ guest_count: drinkPlan.guest_count ?? guestCount }}
          />
        </Suspense>
      )}
    </div>
  );
}

export default memo(DrinkPlanCard);
