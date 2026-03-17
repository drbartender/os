import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { QUICK_PICKS } from '../plan/data/servingTypes';

const STATUS_LABELS = {
  pending: 'Pending',
  draft: 'Draft',
  submitted: 'Submitted',
  reviewed: 'Reviewed',
};
const STATUS_CLASSES = {
  pending: 'badge-inprogress',
  draft: 'badge-inprogress',
  submitted: 'badge-submitted',
  reviewed: 'badge-approved',
};

// Legacy serving types for backward compatibility with old plans
const LEGACY_SERVING_TYPES = {
  'full-bar-signature': 'Full Bar + Signature Drinks',
  'signature-beer-wine': 'Signature Drinks + Beer & Wine',
  'signature-matching-mixers': 'Signature Drinks + Matching Mixers',
  'signature-only': 'Signature Drinks Only',
  'beer-wine-only': 'Beer & Wine Only',
  'mocktail': 'Mocktail / Non-Alcoholic Bar',
};

function isNewFormat(sel) {
  return sel && sel.activeModules;
}

export default function DrinkPlanDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [plan, setPlan] = useState(null);
  const [cocktails, setCocktails] = useState([]);
  const [mocktailItems, setMocktailItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');

  useEffect(() => {
    async function fetchData() {
      try {
        const [planRes, cocktailsRes, mocktailsRes] = await Promise.all([
          api.get(`/drink-plans/${id}`),
          api.get('/cocktails'),
          api.get('/mocktails').catch(() => ({ data: { mocktails: [] } })),
        ]);
        setPlan(planRes.data);
        setNotes(planRes.data.admin_notes || '');
        setCocktails(cocktailsRes.data.cocktails || []);
        setMocktailItems(mocktailsRes.data.mocktails || []);
      } catch (err) {
        if (err.response?.status !== 404) {
          console.error('Failed to fetch plan:', err);
        }
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [id]);

  const saveNotes = async () => {
    setSaving(true);
    try {
      await api.patch(`/drink-plans/${id}/notes`, { admin_notes: notes });
    } catch (err) {
      console.error('Failed to save notes:', err);
    } finally {
      setSaving(false);
    }
  };

  const markReviewed = async () => {
    try {
      const res = await api.patch(`/drink-plans/${id}/status`, { status: 'reviewed' });
      setPlan(prev => ({ ...prev, status: res.data.status }));
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  };

  const deletePlan = async () => {
    if (!window.confirm('Delete this drink plan? This cannot be undone.')) return;
    try {
      await api.delete(`/drink-plans/${id}`);
      navigate('/admin/drink-plans');
    } catch (err) {
      console.error('Failed to delete plan:', err);
    }
  };

  const copyLink = () => {
    const url = `${window.location.origin}/plan/${plan.token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopyMessage('Copied!');
      setTimeout(() => setCopyMessage(''), 2000);
    });
  };

  if (loading) {
    return (
      <div className="page-container" style={{ textAlign: 'center', paddingTop: '2rem' }}>
        <div className="spinner" />
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="page-container">
        <div className="card" style={{ textAlign: 'center' }}>
          <p className="text-muted">Plan not found.</p>
          <button className="btn btn-secondary mt-1" onClick={() => navigate('/admin/drink-plans')}>
            Back to Drink Plans
          </button>
        </div>
      </div>
    );
  }

  const sel = plan.selections || {};
  const formatDate = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  const renderSelections = () => {
    if (isNewFormat(sel)) {
      return renderNewSelections();
    }
    return renderLegacySelections();
  };

  const renderNewSelections = () => {
    const am = sel.activeModules;
    const pick = QUICK_PICKS.find(p => p.key === plan.serving_type);
    const selectedDrinks = cocktails.filter(d => (sel.signatureDrinks || []).includes(d.id));
    const selectedMocktails = mocktailItems.filter(d => (sel.mocktails || []).includes(d.id));
    const logistics = sel.logistics || {};

    return (
      <>
        {pick && (
          <p className="mb-1"><strong>Package:</strong> {pick.emoji} {pick.label}</p>
        )}
        {plan.serving_type === 'custom' && (
          <p className="mb-1"><strong>Package:</strong> Custom Setup</p>
        )}

        {/* Signature Drinks */}
        {am.signatureDrinks && selectedDrinks.length > 0 && (
          <div className="mb-2">
            <strong>Signature Cocktails:</strong>
            <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
              {selectedDrinks.map(d => (
                <li key={d.id}>{d.emoji} {d.name}{d.base_spirit ? ` (${d.base_spirit})` : ''}</li>
              ))}
            </ul>
            {sel.signatureDrinkSpirits?.length > 0 && (
              <p className="text-muted text-small">Extracted spirits: {sel.signatureDrinkSpirits.join(', ')}</p>
            )}
            {sel.mixersForSignatureDrinks === true && (
              <p className="text-muted text-small">Basic mixers requested for signature drink spirits</p>
            )}
            {sel.mixersForSignatureDrinks === false && (
              <p className="text-muted text-small">No mixers for signature drink spirits</p>
            )}
          </div>
        )}

        {/* Mocktails */}
        {am.mocktails && selectedMocktails.length > 0 && (
          <div className="mb-2">
            <strong>Mocktails:</strong>
            <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
              {selectedMocktails.map(d => (
                <li key={d.id}>{d.emoji} {d.name}</li>
              ))}
            </ul>
            {sel.mocktailNotes && (
              <p className="text-muted text-small">Notes: {sel.mocktailNotes}</p>
            )}
          </div>
        )}
        {/* Legacy mocktail notes (text only) */}
        {am.mocktails && !selectedMocktails.length && sel.mocktailNotes && (
          <div className="mb-1"><strong>Mocktail Preferences:</strong><p className="text-muted">{sel.mocktailNotes}</p></div>
        )}

        {/* Full Bar */}
        {am.fullBar && (
          <div className="mb-2">
            {sel.spirits?.length > 0 && (
              <p className="mb-1"><strong>Spirits:</strong> {sel.spirits.join(', ')}
                {sel.spiritsOther && `, ${sel.spiritsOther}`}
              </p>
            )}
            {sel.mixersForSpirits === true && (
              <p className="text-muted text-small mb-1">Mixers included for bar spirits</p>
            )}
            {sel.beerFromFullBar?.length > 0 && (
              <p className="mb-1"><strong>Beer:</strong> {sel.beerFromFullBar.join(', ')}</p>
            )}
            {sel.wineFromFullBar?.length > 0 && (
              <p className="mb-1"><strong>Wine:</strong> {sel.wineFromFullBar.join(', ')}
                {sel.wineOtherFullBar && ` (${sel.wineOtherFullBar})`}
              </p>
            )}
            {sel.beerWineBalanceFullBar && (
              <p className="mb-1"><strong>Guest preference:</strong> {sel.beerWineBalanceFullBar.replace(/_/g, ' ')}</p>
            )}
          </div>
        )}

        {/* Beer & Wine Only */}
        {am.beerWineOnly && !am.fullBar && (
          <div className="mb-2">
            {sel.beerFromBeerWine?.length > 0 && (
              <p className="mb-1"><strong>Beer:</strong> {sel.beerFromBeerWine.join(', ')}</p>
            )}
            {sel.wineFromBeerWine?.length > 0 && (
              <p className="mb-1"><strong>Wine:</strong> {sel.wineFromBeerWine.join(', ')}
                {sel.wineOtherBeerWine && ` (${sel.wineOtherBeerWine})`}
              </p>
            )}
            {sel.beerWineBalanceBeerWine && (
              <p className="mb-1"><strong>Balance:</strong> {sel.beerWineBalanceBeerWine.replace(/_/g, ' ')}</p>
            )}
          </div>
        )}

        {/* Menu Design */}
        {sel.customMenuDesign === true && (
          <div className="mb-2">
            <p className="mb-1"><strong>Custom Menu Design:</strong> Yes</p>
            {sel.menuTheme && <p className="text-muted mb-1">Theme: {sel.menuTheme}</p>}
            {sel.drinkNaming && <p className="text-muted mb-1">Custom naming: {sel.drinkNaming}</p>}
            {sel.menuDesignNotes && <p className="text-muted mb-1">Design notes: {sel.menuDesignNotes}</p>}
          </div>
        )}
        {sel.customMenuDesign === false && (
          <p className="mb-1"><strong>Custom Menu Design:</strong> No</p>
        )}

        {/* Logistics */}
        <div className="mb-1">
          <strong>Logistics:</strong>
          {logistics.dayOfContact?.name && (
            <p className="text-muted">
              Day-of contact: {logistics.dayOfContact.name}
              {logistics.dayOfContact.phone && ` — ${logistics.dayOfContact.phone}`}
            </p>
          )}
          {logistics.parking && (
            <p className="text-muted">Parking: {logistics.parking.replace(/_/g, ' ')}</p>
          )}
          {logistics.equipment?.length > 0 && (
            <p className="text-muted">
              Equipment: {logistics.equipment.map(e => e.replace(/_/g, ' ')).join(', ')}
              {logistics.equipmentOther && ` (${logistics.equipmentOther})`}
            </p>
          )}
          {logistics.accessNotes && (
            <p className="text-muted">Event notes: {logistics.accessNotes}</p>
          )}
          {/* Backward compat */}
          {logistics.ice && <p className="text-muted">Ice machine: {logistics.ice}</p>}
          {logistics.other && !logistics.accessNotes && <p className="text-muted">Notes: {logistics.other}</p>}
        </div>
      </>
    );
  };

  const renderLegacySelections = () => {
    const typeName = LEGACY_SERVING_TYPES[plan.serving_type];
    const selectedDrinks = cocktails.filter(d => (sel.signatureCocktails || []).includes(d.id));

    return (
      <>
        {typeName && (
          <p className="mb-1"><strong>Package:</strong> {typeName}</p>
        )}

        {selectedDrinks.length > 0 && (
          <div className="mb-2">
            <strong>Signature Cocktails:</strong>
            <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
              {selectedDrinks.map(d => (
                <li key={d.id}>{d.emoji} {d.name}</li>
              ))}
            </ul>
          </div>
        )}

        {sel.spirits?.length > 0 && (
          <p className="mb-1"><strong>Spirits:</strong> {sel.spirits.join(', ')}</p>
        )}
        {sel.barFocus && (
          <p className="mb-1"><strong>Bar Focus:</strong> {sel.barFocus.replace(/-/g, ' ')}</p>
        )}
        {sel.wineStyles?.length > 0 && (
          <p className="mb-1"><strong>Wine Styles:</strong> {sel.wineStyles.join(', ')}</p>
        )}
        {sel.beerStyles?.length > 0 && (
          <p className="mb-1"><strong>Beer Styles:</strong> {sel.beerStyles.join(', ')}</p>
        )}
        {sel.beerWineBalance && (
          <p className="mb-1"><strong>Balance:</strong> {sel.beerWineBalance.replace(/-/g, ' ')}</p>
        )}
        {sel.beerWineNotes && (
          <div className="mb-1"><strong>Drink Notes:</strong><p className="text-muted">{sel.beerWineNotes}</p></div>
        )}
        {sel.fullBarNotes && (
          <div className="mb-1"><strong>Full Bar Notes:</strong><p className="text-muted">{sel.fullBarNotes}</p></div>
        )}
        {sel.mocktailNotes && (
          <div className="mb-1"><strong>Mocktail Preferences:</strong><p className="text-muted">{sel.mocktailNotes}</p></div>
        )}
        {sel.logisticsNotes && (
          <div className="mb-1"><strong>Logistics:</strong><p className="text-muted">{sel.logisticsNotes}</p></div>
        )}

        {!typeName && !sel.spirits?.length && !sel.logisticsNotes && (
          <p className="text-muted">Client hasn't made any selections yet.</p>
        )}
      </>
    );
  };

  return (
    <div className="page-container">
      <button
        className="btn btn-secondary btn-sm mb-2"
        onClick={() => navigate('/admin/drink-plans')}
      >
        &larr; All Drink Plans
      </button>

      <div className="card mb-2">
        <div className="flex-between" style={{ flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', margin: 0 }}>
              {plan.client_name || 'Unnamed Client'}
            </h2>
            {plan.client_email && <p className="text-muted text-small">{plan.client_email}</p>}
            {plan.event_name && <p className="mt-1"><strong>Event:</strong> {plan.event_name}</p>}
            {plan.event_date && <p><strong>Date:</strong> {formatDate(plan.event_date)}</p>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem' }}>
            <span className={`badge ${STATUS_CLASSES[plan.status] || ''}`}>
              {STATUS_LABELS[plan.status] || plan.status}
            </span>
            <button className="btn btn-sm btn-secondary" onClick={copyLink}>
              {copyMessage || 'Copy Client Link'}
            </button>
          </div>
        </div>
      </div>

      {plan.status !== 'pending' && (
        <div className="card mb-2">
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '1rem' }}>
            Selections
          </h3>
          {renderSelections()}
        </div>
      )}

      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Admin Notes
        </h3>
        <textarea
          className="form-textarea"
          rows={4}
          placeholder="Internal notes about this plan..."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <button
          className="btn btn-sm mt-1"
          onClick={saveNotes}
          disabled={saving}
        >
          {saving ? 'Saving...' : 'Save Notes'}
        </button>
      </div>

      <div className="flex gap-1">
        {plan.status === 'submitted' && (
          <button className="btn btn-success" onClick={markReviewed}>
            Mark as Reviewed
          </button>
        )}
        <button className="btn btn-danger btn-sm" onClick={deletePlan}>
          Delete Plan
        </button>
      </div>
    </div>
  );
}
