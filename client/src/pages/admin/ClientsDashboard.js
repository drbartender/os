import React from 'react';

export default function ClientsDashboard() {
  return (
    <div className="page-container wide">
      <div className="flex-between mb-3" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 style={{ marginBottom: '0.2rem' }}>Clients</h1>
          <p className="text-muted text-small">Client relationships and lead management</p>
        </div>
      </div>
      <div className="card" style={{ textAlign: 'center', padding: '4rem 1rem' }}>
        <p style={{ color: 'var(--deep-brown)', fontSize: '1.1rem' }}>Coming soon</p>
        <p className="text-muted text-small" style={{ marginTop: '0.5rem' }}>
          Track clients, manage leads, and build lasting relationships.
        </p>
      </div>
    </div>
  );
}
