import React, { useState, useEffect } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';

export default function EmailAnalyticsDashboard() {
  const toast = useToast();
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/email-marketing/analytics/overview');
        setAnalytics(res.data);
      } catch (err) {
        toast.error('Failed to load analytics. Try refreshing.');
      } finally {
        setLoading(false);
      }
    })();
  }, [toast]);

  if (loading) return <div className="loading"><div className="spinner" />Loading...</div>;
  if (!analytics) return <div className="em-empty">Unable to load analytics.</div>;

  const { leads, campaigns, sends } = analytics;

  return (
    <div className="em-analytics">
      {/* Summary Cards */}
      <div className="em-stat-cards">
        <div className="em-stat-card">
          <div className="em-stat-value">{leads.total}</div>
          <div className="em-stat-label">Total Leads</div>
          <div className="em-stat-sub">{leads.active} active</div>
        </div>
        <div className="em-stat-card">
          <div className="em-stat-value">{campaigns.total}</div>
          <div className="em-stat-label">Campaigns</div>
          <div className="em-stat-sub">{campaigns.active} active</div>
        </div>
        <div className="em-stat-card">
          <div className="em-stat-value">{sends.total_sends}</div>
          <div className="em-stat-label">Emails Sent</div>
          <div className="em-stat-sub">{sends.total_delivered} delivered</div>
        </div>
        <div className="em-stat-card em-stat-highlight">
          <div className="em-stat-value">{sends.open_rate}%</div>
          <div className="em-stat-label">Open Rate</div>
        </div>
        <div className="em-stat-card em-stat-highlight">
          <div className="em-stat-value">{sends.click_rate}%</div>
          <div className="em-stat-label">Click Rate</div>
        </div>
        <div className="em-stat-card em-stat-warn">
          <div className="em-stat-value">{sends.bounce_rate}%</div>
          <div className="em-stat-label">Bounce Rate</div>
        </div>
      </div>

      {/* Breakdown */}
      <div className="em-section">
        <h3>Delivery Breakdown</h3>
        <div className="em-breakdown-bars">
          {[
            { label: 'Delivered', value: parseInt(sends.total_delivered, 10), color: '#2d8a4e' },
            { label: 'Opened', value: parseInt(sends.total_opens, 10), color: '#2d6b8a' },
            { label: 'Clicked', value: parseInt(sends.total_clicks, 10), color: '#8a6b2d' },
            { label: 'Bounced', value: parseInt(sends.total_bounces, 10), color: '#c44' },
            { label: 'Complained', value: parseInt(sends.total_complaints, 10), color: '#c44' },
          ].map(item => {
            const total = parseInt(sends.total_sends, 10) || 1;
            const pct = (item.value / total * 100).toFixed(1);
            return (
              <div key={item.label} className="em-bar-row">
                <span className="em-bar-label">{item.label}</span>
                <div className="em-bar-track">
                  <div className="em-bar-fill" style={{ width: `${pct}%`, background: item.color }} />
                </div>
                <span className="em-bar-value">{item.value} ({pct}%)</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
