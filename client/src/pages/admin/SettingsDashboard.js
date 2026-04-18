import React, { useState, useEffect, useCallback } from 'react';
import CocktailMenuDashboard from './CocktailMenuDashboard';
import ConfirmModal from '../../components/ConfirmModal';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';

const TABS = [
  { key: 'drink-menu', label: 'Drink Menu' },
  { key: 'calendar', label: 'Calendar Sync' },
  { key: 'auto-assign', label: 'Auto-Assign' },
];

function CalendarSyncSection() {
  const toast = useToast();
  const [feedUrl, setFeedUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [showRegenConfirm, setShowRegenConfirm] = useState(false);

  const fetchToken = useCallback(async () => {
    try {
      const res = await api.get('/calendar/token');
      setFeedUrl(res.data.feed_url);
    } catch (err) {
      toast.error('Failed to load calendar token. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchToken(); }, [fetchToken]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(feedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const input = document.createElement('input');
      input.value = feedUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      const res = await api.post('/calendar/token/regenerate');
      setFeedUrl(res.data.feed_url);
      toast.success('Calendar URL regenerated.');
    } catch (err) {
      toast.error(err.message || 'Failed to regenerate calendar URL.');
    } finally {
      setRegenerating(false);
      setShowRegenConfirm(false);
    }
  };

  if (loading) return <div className="card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* Feed URL */}
      <div className="card" style={{ padding: '1.5rem' }}>
        <h3 style={{ marginBottom: '0.75rem', fontSize: '1rem' }}>Your Calendar Feed URL</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
          Subscribe to this URL in your calendar app to see all your events with client details, staffing, and locations.
        </p>

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <input
            type="text"
            readOnly
            value={feedUrl}
            onClick={e => e.target.select()}
            style={{
              flex: 1, padding: '0.6rem 0.75rem', fontSize: '0.82rem',
              border: '1px solid var(--border)', borderRadius: '6px',
              background: 'var(--cream)', fontFamily: 'monospace',
            }}
          />
          <button className="btn btn-primary btn-sm" onClick={handleCopy} style={{ whiteSpace: 'nowrap' }}>
            {copied ? 'Copied!' : 'Copy URL'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setShowRegenConfirm(true)}
            disabled={regenerating}
          >
            {regenerating ? 'Regenerating...' : 'Regenerate URL'}
          </button>
          <ConfirmModal
            isOpen={showRegenConfirm}
            title="Regenerate Calendar URL?"
            message="This will break any existing calendar subscriptions using the current URL. Are you sure?"
            onConfirm={handleRegenerate}
            onCancel={() => setShowRegenConfirm(false)}
          />
          <span style={{ fontSize: '0.78rem', color: 'var(--warm-brown)' }}>
            Anyone with this link can view your event calendar.
          </span>
        </div>
      </div>

      {/* Instructions */}
      <div className="card" style={{ padding: '1.5rem' }}>
        <h3 style={{ marginBottom: '0.75rem', fontSize: '1rem' }}>How to Subscribe</h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', fontSize: '0.88rem' }}>
          <div>
            <strong style={{ color: 'var(--deep-brown)' }}>Google Calendar</strong>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginLeft: '0.5rem' }}>(desktop browser only)</span>
            <ol style={{ margin: '0.4rem 0 0 1.25rem', color: 'var(--warm-brown)' }}>
              <li>Open Google Calendar on your computer</li>
              <li>Click the <strong>+</strong> next to "Other calendars" in the left sidebar</li>
              <li>Select <strong>"From URL"</strong></li>
              <li>Paste the feed URL above and click <strong>"Add calendar"</strong></li>
            </ol>
          </div>

          <div>
            <strong style={{ color: 'var(--deep-brown)' }}>Apple Calendar</strong>
            <ol style={{ margin: '0.4rem 0 0 1.25rem', color: 'var(--warm-brown)' }}>
              <li>Open Calendar and go to <strong>File → New Calendar Subscription</strong></li>
              <li>Paste the feed URL and click <strong>Subscribe</strong></li>
            </ol>
          </div>

          <div>
            <strong style={{ color: 'var(--deep-brown)' }}>Outlook</strong>
            <ol style={{ margin: '0.4rem 0 0 1.25rem', color: 'var(--warm-brown)' }}>
              <li>Go to <strong>Add calendar → Subscribe from web</strong></li>
              <li>Paste the feed URL and click <strong>Import</strong></li>
            </ol>
          </div>
        </div>

        <p style={{ marginTop: '1rem', fontSize: '0.82rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
          Google Calendar subscriptions are not instant and may refresh only about once per day.
          Apple Calendar and Outlook typically refresh more frequently.
        </p>
      </div>
    </div>
  );
}

function AutoAssignSettings() {
  const toast = useToast();
  const [, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState(null);
  const [showBackfillConfirm, setShowBackfillConfirm] = useState(false);
  const [form, setForm] = useState({
    auto_assign_default_days_before: '3',
    seniority_weight_events: '0.7',
    seniority_weight_tenure: '0.3',
    geo_max_distance_miles: '100',
  });

  useEffect(() => {
    api.get('/admin/settings')
      .then(r => {
        setSettings(r.data);
        setForm(f => ({ ...f, ...r.data }));
      })
      .catch(() => toast.error('Failed to load settings. Try refreshing.'))
      .finally(() => setLoading(false));
  }, [toast]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await api.put('/admin/settings', form);
      setSettings(r.data);
      toast.success('Settings saved!');
    } catch (e) {
      toast.error(e.message || 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleBackfill = async () => {
    setBackfilling(true);
    setBackfillResult(null);
    try {
      const r = await api.post('/admin/backfill-geocodes');
      setBackfillResult(r.data);
    } catch (e) {
      setBackfillResult({ error: e.message || 'Backfill failed' });
    } finally {
      setBackfilling(false);
      setShowBackfillConfirm(false);
    }
  };

  if (loading) return <div className="card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: 560 }}>
      <div className="card" style={{ padding: '1.5rem' }}>
        <h3 style={{ marginBottom: '1rem', fontSize: '1rem' }}>Algorithm Weights</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
          Control how the auto-assign algorithm scores candidates. Seniority uses a weighted combination of events worked and tenure.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
          <div className="form-group">
            <label className="form-label">Events Weight</label>
            <input type="number" className="form-input" step="0.1" min="0" max="1"
              value={form.seniority_weight_events}
              onChange={e => setForm(f => ({ ...f, seniority_weight_events: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-label">Tenure Weight</label>
            <input type="number" className="form-input" step="0.1" min="0" max="1"
              value={form.seniority_weight_tenure}
              onChange={e => setForm(f => ({ ...f, seniority_weight_tenure: e.target.value }))} />
          </div>
        </div>

        <p className="text-small text-muted" style={{ marginBottom: '1rem' }}>
          Events and tenure weights should ideally sum to 1.0. Currently: {(parseFloat(form.seniority_weight_events || 0) + parseFloat(form.seniority_weight_tenure || 0)).toFixed(1)}
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
          <div className="form-group">
            <label className="form-label">Default Auto-Assign Days Before</label>
            <input type="number" className="form-input" min="0" max="30"
              value={form.auto_assign_default_days_before}
              onChange={e => setForm(f => ({ ...f, auto_assign_default_days_before: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-label">Max Distance (miles)</label>
            <input type="number" className="form-input" min="1" max="500"
              value={form.geo_max_distance_miles}
              onChange={e => setForm(f => ({ ...f, geo_max_distance_miles: e.target.value }))} />
          </div>
        </div>

        <button className="btn btn-primary btn-sm" disabled={saving} onClick={handleSave}>
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
      </div>

      <div className="card" style={{ padding: '1.5rem' }}>
        <h3 style={{ marginBottom: '0.75rem', fontSize: '1rem' }}>Geocode Backfill</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
          Geocode all staff addresses and shift locations that don't have coordinates yet. Also backfills hire dates for existing staff. This is rate-limited and may take a while.
        </p>
        <button className="btn btn-secondary btn-sm" disabled={backfilling} onClick={() => setShowBackfillConfirm(true)}>
          {backfilling ? 'Backfilling…' : 'Run Backfill'}
        </button>
        <ConfirmModal
          isOpen={showBackfillConfirm}
          title="Run Geocode Backfill?"
          message="This will geocode all staff and shift addresses. It may take a while due to rate limits. Continue?"
          onConfirm={handleBackfill}
          onCancel={() => setShowBackfillConfirm(false)}
        />
        {backfillResult && (
          <div className={`alert ${backfillResult.error ? 'alert-error' : 'alert-success'}`} style={{ marginTop: '0.75rem' }}>
            {backfillResult.error
              ? backfillResult.error
              : `Done: ${backfillResult.profiles_geocoded} profiles, ${backfillResult.shifts_geocoded} shifts geocoded, ${backfillResult.hire_dates_backfilled} hire dates set.`}
          </div>
        )}
      </div>
    </div>
  );
}

export default function SettingsDashboard() {
  const [activeTab, setActiveTab] = useState('drink-menu');

  return (
    <div className="page-container wide">
      <div className="flex-between mb-2" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 style={{ marginBottom: '0.2rem' }}>Settings</h1>
          <p className="text-muted text-small">Platform configuration</p>
        </div>
      </div>

      <div className="tab-nav mb-2">
        {TABS.map(tab => (
          <button
            key={tab.key}
            className={`tab-btn${activeTab === tab.key ? ' active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'drink-menu' && <CocktailMenuDashboard embedded />}
      {activeTab === 'calendar' && <CalendarSyncSection />}
      {activeTab === 'auto-assign' && <AutoAssignSettings />}
    </div>
  );
}
