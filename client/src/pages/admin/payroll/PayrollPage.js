import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const TABS = [
  { id: 'current', label: 'Current period' },
  { id: 'history', label: 'History' },
  { id: 'unassigned', label: 'Unassigned tips' },
];

export default function PayrollPage() {
  const [tab, setTab] = useState('current');
  const navigate = useNavigate();

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Payroll</div>
          <div className="page-subtitle">Weekly payroll worklist, history, and stray tips.</div>
        </div>
        <div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/financials')}>
            ← Financials
          </button>
        </div>
      </div>

      <div className="hstack" style={{ gap: 4, marginBottom: 'var(--gap)' }}>
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            className={`btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'current' && <CurrentTab />}
      {tab === 'history' && <HistoryTab />}
      {tab === 'unassigned' && <UnassignedTab />}
    </div>
  );
}

// Stubs filled in by later tasks.
function CurrentTab() { return <div className="muted">Current-period worklist coming online.</div>; }
function HistoryTab() { return <div className="muted">Past periods coming online.</div>; }
function UnassignedTab() { return <div className="muted">Unassigned-tips panel coming online.</div>; }
