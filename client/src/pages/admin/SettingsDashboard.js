import React, { useState, useEffect, useCallback } from 'react';
import CocktailMenuDashboard from './CocktailMenuDashboard';
import api from '../../utils/api';

const TABS = [
  { key: 'drink-menu', label: 'Drink Menu' },
  { key: 'calendar', label: 'Calendar Sync' },
];

function CalendarSyncSection() {
  const [feedUrl, setFeedUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const fetchToken = useCallback(async () => {
    try {
      const res = await api.get('/calendar/token');
      setFeedUrl(res.data.feed_url);
    } catch (err) {
      console.error('Failed to fetch calendar token:', err);
    } finally {
      setLoading(false);
    }
  }, []);

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
    if (!window.confirm('This will break any existing calendar subscriptions using the current URL. Are you sure?')) return;
    setRegenerating(true);
    try {
      const res = await api.post('/calendar/token/regenerate');
      setFeedUrl(res.data.feed_url);
    } catch (err) {
      console.error('Failed to regenerate token:', err);
    } finally {
      setRegenerating(false);
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
            onClick={handleRegenerate}
            disabled={regenerating}
          >
            {regenerating ? 'Regenerating...' : 'Regenerate URL'}
          </button>
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
    </div>
  );
}
