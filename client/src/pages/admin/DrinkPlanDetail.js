import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import DrinkPlanSelections from '../../components/DrinkPlanSelections';
import ShoppingListButton from '../../components/ShoppingList/ShoppingListButton';
import { getEventTypeLabel } from '../../utils/eventTypes';

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

  const formatDate = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  return (
    <div className="page-container">
      {/* Top card: client info + actions */}
      <div className="card mb-2">
        <div className="flex-between" style={{ flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', margin: 0 }}>
              {plan.client_name || 'Unnamed Client'}
            </h2>
            {plan.client_email && <p className="text-muted text-small">{plan.client_email}</p>}
            <p className="mt-1"><strong>Event type:</strong> {getEventTypeLabel({ event_type: plan.event_type, event_type_custom: plan.event_type_custom })}</p>
            {plan.event_date && <p><strong>Date:</strong> {formatDate(plan.event_date)}</p>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem' }}>
            <span className={`badge ${STATUS_CLASSES[plan.status] || ''}`}>
              {STATUS_LABELS[plan.status] || plan.status}
            </span>
          </div>
        </div>
        {/* Action buttons in top card */}
        <div className="flex gap-05 mt-1" style={{ flexWrap: 'wrap' }}>
          {(plan.status === 'submitted' || plan.status === 'reviewed') && (
            <ShoppingListButton planId={id} planToken={plan.token} />
          )}
          <button className="btn btn-sm btn-secondary" onClick={copyLink}>
            {copyMessage || 'Copy Client Link'}
          </button>
          {plan.status === 'submitted' && (
            <button className="btn btn-sm btn-success" onClick={markReviewed}>
              Mark as Reviewed
            </button>
          )}
          <button className="btn btn-sm btn-danger" onClick={deletePlan} style={{ marginLeft: 'auto' }}>
            Delete Plan
          </button>
        </div>
      </div>

      {plan.status !== 'pending' && (
        <div className="card mb-2">
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '1rem' }}>
            Selections
          </h3>
          <DrinkPlanSelections plan={plan} cocktails={cocktails} mocktails={mocktailItems} />
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
    </div>
  );
}
