import React, { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import api from '../../utils/api';
import { WHATSAPP_GROUP_URL, COMPANY_PHONE, COMPANY_PHONE_TEL } from '../../utils/constants';

export default function StaffResources() {
  const [calFeedUrl, setCalFeedUrl] = useState('');
  const [calCopied, setCalCopied] = useState(false);
  const [calLoading, setCalLoading] = useState(false);

  const fetchCalendarUrl = useCallback(async () => {
    if (calFeedUrl) return;
    setCalLoading(true);
    try {
      const res = await api.get('/calendar/token');
      setCalFeedUrl(res.data.feed_url);
    } catch (err) {
      console.error('Failed to fetch calendar URL:', err);
    } finally {
      setCalLoading(false);
    }
  }, [calFeedUrl]);

  async function copyCalUrl() {
    try {
      await navigator.clipboard.writeText(calFeedUrl);
    } catch {
      const input = document.createElement('input');
      input.value = calFeedUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
    }
    setCalCopied(true);
    setTimeout(() => setCalCopied(false), 2000);
  }

  return (
    <div className="page-container" style={{ maxWidth: 860 }}>
      <h1 style={{ fontFamily: 'var(--font-display)', marginBottom: '1.25rem' }}>Resources</h1>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        <div className="card">
          <h3 style={{ marginBottom: '1rem', fontSize: '1rem' }}>Quick Links</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            <Link to="/field-guide" className="btn btn-secondary" style={{ textAlign: 'left', textDecoration: 'none' }}>
              Field Guide
            </Link>
            <Link to="/agreement" className="btn btn-secondary" style={{ textAlign: 'left', textDecoration: 'none' }}>
              My Signed Agreement
            </Link>
            <Link to="/payday-protocols" className="btn btn-secondary" style={{ textAlign: 'left', textDecoration: 'none' }}>
              Payday Protocols
            </Link>
            <a
              href={WHATSAPP_GROUP_URL}
              target="_blank" rel="noopener noreferrer"
              className="btn btn-secondary" style={{ textAlign: 'left', textDecoration: 'none' }}
            >
              WhatsApp Group
            </a>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div className="card">
            <h3 style={{ marginBottom: '0.75rem', fontSize: '1rem' }}>Calendar Sync</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
              Subscribe to your confirmed shifts in any calendar app.
            </p>

            {!calFeedUrl ? (
              <button className="btn btn-secondary btn-sm" onClick={fetchCalendarUrl} disabled={calLoading}>
                {calLoading ? 'Loading...' : 'Get Sync URL'}
              </button>
            ) : (
              <>
                <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.6rem' }}>
                  <input
                    type="text" readOnly value={calFeedUrl}
                    onClick={e => e.target.select()}
                    style={{
                      flex: 1, padding: '0.45rem 0.6rem', fontSize: '0.75rem',
                      border: '1px solid var(--border)', borderRadius: '6px',
                      background: 'var(--cream)', fontFamily: 'monospace',
                    }}
                  />
                  <button className="btn btn-primary btn-sm" onClick={copyCalUrl} style={{ whiteSpace: 'nowrap' }}>
                    {calCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  <strong>Google Calendar</strong> (desktop): "+" next to Other calendars &rarr; From URL &rarr; paste<br />
                  <strong>Apple Calendar</strong>: File &rarr; New Calendar Subscription &rarr; paste<br />
                  <strong>Outlook</strong>: Add calendar &rarr; Subscribe from web &rarr; paste
                </div>
                <p style={{ fontSize: '0.75rem', color: 'var(--warm-brown)', marginTop: '0.5rem', marginBottom: 0, fontStyle: 'italic' }}>
                  Keep this link private — anyone with it can see your schedule.
                </p>
              </>
            )}
          </div>

          <div className="card">
            <h3 style={{ marginBottom: '0.5rem', fontSize: '1rem' }}>Support</h3>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Questions? Text <a href={COMPANY_PHONE_TEL} style={{ color: 'var(--amber)' }}>{COMPANY_PHONE}</a>
              {' '}or email <a href="mailto:contact@drbartender.com" style={{ color: 'var(--amber)' }}>contact@drbartender.com</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
