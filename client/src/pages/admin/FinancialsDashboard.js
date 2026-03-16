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
      <div className="card" style={{ textAlign: 'center', padding: '4rem 1rem' }}>
        <p style={{ color: 'var(--deep-brown)', fontSize: '1.1rem' }}>Coming soon</p>
        <p className="text-muted text-small" style={{ marginTop: '0.5rem' }}>
          Monitor revenue, track expenses, and manage invoicing.
        </p>
      </div>
    </div>
  );
}
