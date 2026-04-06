import React from 'react';

export default function CampaignMetricsBar({ stats }) {
  if (!stats) return null;

  const totalSends = parseInt(stats.total_sends, 10) || 0;
  if (totalSends === 0) return <p className="em-no-stats">No sends yet.</p>;

  const metrics = [
    { label: 'Sent', value: totalSends, color: '#6b4226' },
    { label: 'Delivered', value: parseInt(stats.total_delivered, 10) || 0, color: '#2d8a4e' },
    { label: 'Opened', value: parseInt(stats.total_opens, 10) || 0, color: '#2d6b8a' },
    { label: 'Clicked', value: parseInt(stats.total_clicks, 10) || 0, color: '#8a6b2d' },
    { label: 'Bounced', value: parseInt(stats.total_bounces, 10) || 0, color: '#c44' },
    { label: 'Complained', value: parseInt(stats.total_complaints, 10) || 0, color: '#c44' },
  ];

  return (
    <div className="em-metrics-bar">
      {metrics.map(m => {
        const pct = totalSends > 0 ? (m.value / totalSends * 100).toFixed(1) : 0;
        return (
          <div key={m.label} className="em-metric">
            <span className="em-metric-value" style={{ color: m.color }}>{m.value}</span>
            <span className="em-metric-label">{m.label}</span>
            {m.label !== 'Sent' && <span className="em-metric-pct">{pct}%</span>}
          </div>
        );
      })}
    </div>
  );
}
