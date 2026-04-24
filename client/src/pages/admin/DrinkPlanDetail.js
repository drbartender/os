import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import DrinkPlanSelections from '../../components/DrinkPlanSelections';
import ShoppingListButton from '../../components/ShoppingList/ShoppingListButton';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { PUBLIC_SITE_URL } from '../../utils/constants';
import { useToast } from '../../context/ToastContext';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import { fmtDateFull } from '../../components/adminos/format';

const STATUS = {
  pending:   { label: 'Pending',   kind: 'warn' },
  draft:     { label: 'Draft',     kind: 'neutral' },
  submitted: { label: 'Submitted', kind: 'info' },
  reviewed:  { label: 'Reviewed',  kind: 'ok' },
};

export default function DrinkPlanDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [plan, setPlan] = useState(null);
  const [cocktails, setCocktails] = useState([]);
  const [mocktailItems, setMocktailItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [notesError, setNotesError] = useState('');
  const [notesFieldErrors, setNotesFieldErrors] = useState({});
  const [copyMessage, setCopyMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function fetchData() {
      try {
        const [planRes, cocktailsRes, mocktailsRes] = await Promise.all([
          api.get(`/drink-plans/${id}`),
          api.get('/cocktails'),
          api.get('/mocktails').catch(() => ({ data: { mocktails: [] } })),
        ]);
        if (cancelled) return;
        setPlan(planRes.data);
        setNotes(planRes.data.admin_notes || '');
        setCocktails(cocktailsRes.data.cocktails || []);
        setMocktailItems(mocktailsRes.data.mocktails || []);
      } catch (err) {
        if (cancelled) return;
        if (err.status !== 404) toast.error('Failed to load drink plan — try refreshing.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchData();
    return () => { cancelled = true; };
  }, [id, toast]);

  const saveNotes = async () => {
    setNotesError('');
    setNotesFieldErrors({});
    setSaving(true);
    try {
      await api.patch(`/drink-plans/${id}/notes`, { admin_notes: notes });
      toast.success('Saved.');
    } catch (err) {
      setNotesError(err.message || 'Failed to save notes.');
      setNotesFieldErrors(err.fieldErrors || {});
    } finally {
      setSaving(false);
    }
  };

  const markReviewed = async () => {
    try {
      const res = await api.patch(`/drink-plans/${id}/status`, { status: 'reviewed' });
      setPlan(prev => ({ ...prev, status: res.data.status }));
      toast.success('Plan marked as reviewed.');
    } catch (err) {
      toast.error(err.message || 'Failed to update status.');
    }
  };

  const deletePlan = async () => {
    if (!window.confirm('Delete this drink plan? This cannot be undone.')) return;
    try {
      await api.delete(`/drink-plans/${id}`);
      toast.success('Drink plan deleted.');
      navigate('/admin/drink-plans');
    } catch (err) {
      toast.error(err.message || 'Failed to delete plan.');
    }
  };

  const copyLink = () => {
    if (!plan?.token) return;
    const url = `${PUBLIC_SITE_URL}/plan/${plan.token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopyMessage('Copied!');
      setTimeout(() => setCopyMessage(''), 2000);
    });
  };

  if (loading) return <div className="page"><div className="muted">Loading drink plan…</div></div>;
  if (!plan) {
    return (
      <div className="page">
        <div className="hstack" style={{ marginBottom: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/drink-plans')}>
            <Icon name="left" size={11} />Drink Plans
          </button>
        </div>
        <div className="muted">Plan not found.</div>
      </div>
    );
  }

  const st = STATUS[plan.status] || { label: plan.status || '—', kind: 'neutral' };
  const eventTypeLabel = getEventTypeLabel({ event_type: plan.event_type, event_type_custom: plan.event_type_custom });

  return (
    <div className="page" style={{ maxWidth: 1200 }}>
      <div className="hstack" style={{ marginBottom: 8 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/drink-plans')}>
          <Icon name="left" size={11} />Drink Plans
        </button>
      </div>

      <div className="card" style={{ padding: '1.5rem 1.75rem', marginBottom: 'var(--gap)' }}>
        <div className="hstack" style={{ gap: 18, alignItems: 'flex-start' }}>
          <div style={{
            width: 56, height: 56, display: 'grid', placeItems: 'center',
            background: 'var(--bg-2)', border: '1px solid var(--line-1)',
            borderRadius: 4, flexShrink: 0,
          }}>
            <Icon name="flask" size={22} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, marginBottom: 4 }}>
              Drink plan · #{plan.id}
            </div>
            <div className="hstack" style={{ gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 500, margin: 0, lineHeight: 1.15 }}>
                {plan.client_name || 'Unnamed Client'}
              </h1>
              <StatusChip kind={st.kind}>{st.label}</StatusChip>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              {eventTypeLabel}
              {plan.event_date && ` · ${fmtDateFull(String(plan.event_date).slice(0, 10))}`}
              {plan.client_email && ` · ${plan.client_email}`}
            </div>
          </div>
          <div className="page-actions" style={{ flexShrink: 0 }}>
            {(plan.status === 'submitted' || plan.status === 'reviewed') && (
              <ShoppingListButton planId={id} planToken={plan.token} />
            )}
            <button type="button" className="btn btn-secondary" onClick={copyLink}>
              <Icon name={copyMessage ? 'check' : 'copy'} size={12} />{copyMessage || 'Copy link'}
            </button>
            {plan.status === 'submitted' && (
              <button type="button" className="btn btn-primary" onClick={markReviewed}>
                <Icon name="check" size={12} />Mark reviewed
              </button>
            )}
            <button type="button" className="btn btn-ghost" onClick={deletePlan} style={{ color: 'hsl(var(--danger-h) var(--danger-s) 65%)' }}>
              Delete
            </button>
          </div>
        </div>
      </div>

      {plan.status !== 'pending' && (
        <div className="card" style={{ marginBottom: 'var(--gap)' }}>
          <div className="card-head"><h3>Selections</h3></div>
          <div className="card-body">
            <DrinkPlanSelections plan={plan} cocktails={cocktails} mocktails={mocktailItems} />
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h3>Admin notes</h3></div>
        <div className="card-body">
          <textarea
            className="input"
            rows={4}
            style={{ height: 'auto', padding: '0.6rem 0.75rem', width: '100%' }}
            placeholder="Internal notes about this plan…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            aria-invalid={!!notesFieldErrors?.admin_notes}
          />
          <FieldError error={notesFieldErrors?.admin_notes} />
          <FormBanner error={notesError} fieldErrors={notesFieldErrors} />
          <div className="hstack" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-primary" onClick={saveNotes} disabled={saving}>
              {saving ? 'Saving…' : 'Save notes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
