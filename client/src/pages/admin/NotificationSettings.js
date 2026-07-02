import React, { useState, useEffect, useCallback } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';

// Human-readable label + helper text for each notification category.
const CATEGORY_LABELS = {
  urgent_booking: {
    label: 'New bookings',
    help: 'A client signs and pays, or a last-minute booking comes in.',
  },
  urgent_consult: {
    label: 'Consults booked',
    help: 'A client books a phone consult.',
  },
  urgent_staffing: {
    label: 'Staffing alerts',
    help: 'A staff member requests a shift or drops one.',
  },
  urgent_client_reply: {
    label: 'Client text replies',
    help: 'A client texts back to one of our messages.',
  },
  payment_failure: {
    label: 'Payment failures',
    help: 'An autopay charge or a one-off payment fails.',
  },
  feedback: {
    label: 'Low-rating feedback',
    help: 'A client submits a low post-event rating.',
  },
  system_error: {
    label: 'System alerts',
    help: 'A scheduler or delivery problem needs attention.',
  },
  routine_admin: {
    label: 'Routine admin',
    help: 'General admin notices, such as an unrecognized inbound text.',
  },
  routine_thumbtack: {
    label: 'Thumbtack leads',
    help: 'A new lead arrives from Thumbtack.',
  },
  routine_hiring: {
    label: 'New applications',
    help: 'A new staff application is submitted.',
  },
  routine_finance: {
    label: 'Finance notices',
    help: 'Routine payment receipts and finance updates.',
  },
  stripe_payout_failed: {
    label: 'Stripe payout failures',
    help: 'A payout to the bank account fails.',
  },
};

export default function NotificationSettings() {
  const toast = useToast();
  const [categories, setCategories] = useState([]);
  const [prefs, setPrefs] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await api.get('/me/notification-preferences');
      setCategories(res.data.categories || []);
      setPrefs(res.data.notification_preferences || {});
    } catch (err) {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = async (category) => {
    const next = !prefs[category];
    // Optimistic update; revert on failure.
    const prev = prefs;
    setPrefs({ ...prefs, [category]: next });
    setSaving(true);
    try {
      const res = await api.patch('/me/notification-preferences', { [category]: next });
      setPrefs(res.data.notification_preferences || { ...prev, [category]: next });
      toast.success('Notification preferences saved.');
    } catch (err) {
      setPrefs(prev);
      toast.error(err.message || 'Failed to save. Try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
        Loading...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="card" style={{ padding: '1.5rem' }}>
        <div className="alert alert-error" style={{ marginBottom: '1rem' }}>
          Could not load your notification preferences.
        </div>
        <button className="btn btn-secondary btn-sm" onClick={load}>Retry</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: 560 }}>
      <div className="card" style={{ padding: '1.5rem' }}>
        <h3 style={{ marginBottom: '0.5rem', fontSize: '1rem' }}>Notification Subscriptions</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
          Choose which notifications you receive. These apply only to your account. Other admins
          and managers set their own.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          {categories.map((cat) => {
            const meta = CATEGORY_LABELS[cat] || { label: cat, help: '' };
            return (
              <label
                key={cat}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
                  cursor: saving ? 'wait' : 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={prefs[cat] !== false}
                  disabled={saving}
                  onChange={() => toggle(cat)}
                  style={{ marginTop: '0.2rem' }}
                />
                <span>
                  <span style={{ fontWeight: 600, color: 'var(--deep-brown)' }}>{meta.label}</span>
                  {meta.help && (
                    <span style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                      {meta.help}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}
