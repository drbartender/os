import React from 'react';

export default function FinancialsDashboard() {
  return (
    <div className="page-container wide">
      <div className="flex-between mb-3" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 style={{ marginBottom: '0.2rem' }}>Financials</h1>
          <p className="text-muted text-small">Income and expense tracking</p>
        </div>
      </div>

      <div className="dashboard-stats">
        <div className="dashboard-stat-card" style={{ cursor: 'default' }}>
          <div className="dashboard-stat-number">$0</div>
          <div className="dashboard-stat-label">Revenue</div>
        </div>
        <div className="dashboard-stat-card" style={{ cursor: 'default' }}>
          <div className="dashboard-stat-number">$0</div>
          <div className="dashboard-stat-label">Outstanding</div>
        </div>
        <div className="dashboard-stat-card" style={{ cursor: 'default' }}>
          <div className="dashboard-stat-number">$0</div>
          <div className="dashboard-stat-label">Collected</div>
        </div>
      </div>

      <div className="card" style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
        <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>🔬</div>
        <h2 style={{ marginBottom: '0.5rem', fontSize: '1.15rem', color: 'var(--deep-brown)' }}>Feature in Development</h2>
        <p className="text-muted" style={{ maxWidth: 460, margin: '0 auto', lineHeight: 1.6 }}>
          Financial tracking features are coming soon. You'll be able to monitor revenue,
          track outstanding balances, manage invoicing, and view expense reports all in one place.
        </p>
      </div>
    </div>
  );
}
