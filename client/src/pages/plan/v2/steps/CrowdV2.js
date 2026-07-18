import React from 'react';

// The crowd screen (spec §3.1): two questions the quantity math actually
// uses, and nothing else. "Not sure" is a dignified first-class answer.
const PROFILES = [
  ['cocktail_forward', 'Cocktail-forward crowd'],
  ['wine', 'Wine crowd'],
  ['beer', 'Beer crowd'],
  ['even', 'An even mix'],
  ['help', 'Help me decide'],
];

export default function CrowdV2({ plan, selections, updateSelections }) {
  const crowd = selections.crowd || { drinkers: null, unsure: false, profile: null };
  const guests = plan.guest_count || null;
  const setCrowd = (patch) => updateSelections('crowd', { ...crowd, ...patch });

  const chips = guests ? [
    { label: `Most (${Math.round(guests * 0.85)})`, value: Math.round(guests * 0.85) },
    { label: `About half (${Math.round(guests * 0.5)})`, value: Math.round(guests * 0.5) },
    { label: `A handful (${Math.max(1, Math.round(guests * 0.15))})`, value: Math.max(1, Math.round(guests * 0.15)) },
  ] : [];

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>A Quick Word on Your Crowd</h2>
        <p className="text-muted">Two questions that size your shopping list. We only ask what the math uses.</p>
      </div>

      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.25rem' }}>
          About how many of your {guests || ''} guests drink?
        </h3>
        <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
          This number carries real weight. It drives how much we tell you to buy.
        </p>
        <div className="pp2-drinkers-row">
          <input
            type="number"
            className="form-input pp2-drinkers-input"
            min="0"
            max={guests || undefined}
            value={crowd.drinkers === null || crowd.drinkers === undefined ? '' : crowd.drinkers}
            onChange={(e) => {
              const v = e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value)));
              setCrowd({ drinkers: Number.isFinite(v) ? v : null, unsure: false });
            }}
            aria-label="Number of guests who drink"
          />
          {chips.map((c) => (
            <button
              key={c.label}
              type="button"
              className={`btn btn-secondary btn-sm${crowd.drinkers === c.value ? ' pp2-chip-active' : ''}`}
              onClick={() => setCrowd({ drinkers: c.value, unsure: false })}
            >
              {c.label}
            </button>
          ))}
        </div>
        <label className="checkbox-label" style={{ marginTop: '0.75rem' }}>
          <input
            type="checkbox"
            checked={crowd.unsure === true && crowd.drinkers === null}
            onChange={(e) => setCrowd(e.target.checked ? { drinkers: null, unsure: true } : { unsure: false })}
          />
          <span>Not sure yet. That's a real answer, we'll plan around it.</span>
        </label>
      </div>

      <div className="card">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.25rem' }}>What's their speed?</h3>
        <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
          A light thumb on the scale for the mix of what we'll {plan.package_category === 'hosted' ? 'bring' : 'tell you to buy'}. If you're guessing, that's fine.
        </p>
        <div className="radio-group">
          {PROFILES.map(([value, label]) => (
            <label key={value} className={`radio-option${crowd.profile === value ? ' selected' : ''}`}>
              <input type="radio" name="crowdProfile" checked={crowd.profile === value} onChange={() => setCrowd({ profile: value })} />
              <span className="radio-label">{label}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
