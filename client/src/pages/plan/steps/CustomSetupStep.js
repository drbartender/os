import React, { useState } from 'react';

const TOGGLES = [
  { key: 'signatureDrinks', label: 'Signature Drinks', description: 'Custom cocktails from our menu' },
  { key: 'liquor', label: 'Liquor', description: 'Full spirit selection and mixed drinks' },
  { key: 'beer', label: 'Beer / Seltzer', description: 'Draft, canned, or bottled beer and seltzers' },
  { key: 'wine', label: 'Wine', description: 'Red, white, ros\u00e9, and sparkling' },
  { key: 'mocktails', label: 'Mocktails', description: 'Non-alcoholic handcrafted drinks' },
];

export default function CustomSetupStep({ onConfirm }) {
  const [toggles, setToggles] = useState({
    signatureDrinks: false,
    liquor: false,
    beer: false,
    wine: false,
    mocktails: false,
  });
  const [error, setError] = useState('');

  const handleToggle = (key) => {
    setToggles(prev => ({ ...prev, [key]: !prev[key] }));
    setError('');
  };

  const handleContinue = () => {
    const anySelected = Object.values(toggles).some(Boolean);
    if (!anySelected) {
      setError('Please select at least one option.');
      return;
    }

    const activeModules = {
      signatureDrinks: toggles.signatureDrinks,
      mocktails: toggles.mocktails,
      fullBar: toggles.liquor,
      beerWineOnly: !toggles.liquor && (toggles.beer || toggles.wine),
    };

    onConfirm(activeModules);
  };

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Build Your Custom Setup
        </h2>
        <p className="text-muted">
          Toggle on what you'd like at your event. We'll tailor the questions to match.
        </p>
      </div>

      <div className="card">
        {TOGGLES.map(toggle => (
          <label
            key={toggle.key}
            className="checkbox-label"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              padding: '0.75rem 0',
              borderBottom: '1px solid var(--border-color, #eee)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={toggles[toggle.key]}
              onChange={() => handleToggle(toggle.key)}
              style={{ width: '1.25rem', height: '1.25rem', flexShrink: 0 }}
            />
            <div>
              <strong>{toggle.label}</strong>
              <span className="text-muted text-small" style={{ display: 'block' }}>
                {toggle.description}
              </span>
            </div>
          </label>
        ))}
      </div>

      {error && (
        <div className="alert alert-error mt-1">{error}</div>
      )}

      <div style={{ textAlign: 'center', marginTop: '1.5rem' }}>
        <button className="btn" onClick={handleContinue}>
          Continue
        </button>
      </div>
    </div>
  );
}
