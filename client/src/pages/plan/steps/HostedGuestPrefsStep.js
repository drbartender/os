import React from 'react';

const BALANCE_OPTIONS = [
  { value: 'mostly_beer', label: 'Mostly Beer' },
  { value: 'mostly_cocktails', label: 'Mostly Cocktails' },
  { value: 'mostly_wine', label: 'Mostly Wine' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'help_me_decide', label: 'Help me decide' },
];

const NA_OPTIONS = [
  { value: 'yes', label: 'Yes — some guests won’t drink beer or wine' },
  { value: 'no', label: 'No — beer and wine covers everyone' },
  { value: 'unsure', label: 'Not sure yet' },
];

export default function HostedGuestPrefsStep({
  plan,
  selections,
  onChange,
  addOns = {},
  toggleAddOn,
  addonPricing = [],
}) {
  const prefs = selections.guestPreferences || {};
  const barType = plan?.package_bar_type || 'full_bar';
  const showNaQuestion = barType === 'beer_and_wine';

  const update = (patch) => {
    onChange('guestPreferences', { ...prefs, ...patch });
  };

  // Quick-link to mocktail / NA-beer addons if the client flags NA interest
  const naBeerAddon = addonPricing.find((a) => a.slug === 'non-alcoholic-beer');
  const mocktailAddon = addonPricing.find((a) => a.slug === 'pre-batched-mocktail');
  const naBeerOn = !!addOns['non-alcoholic-beer'];
  const mocktailOn = !!addOns['pre-batched-mocktail'];

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Guest Preferences
        </h2>
        <p className="text-muted">
          Your package is locked in &mdash; this just helps us decide how much of each
          category to actually bring.
        </p>
      </div>

      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          What will your guests actually drink?
        </h3>
        <div className="form-group">
          <div className="checkbox-grid">
            {BALANCE_OPTIONS.map((opt) => (
              <label key={opt.value} className="checkbox-label">
                <input
                  type="radio"
                  name="hostedBalance"
                  checked={prefs.balance === opt.value}
                  onChange={() => update({ balance: opt.value })}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {showNaQuestion && (
        <div className="card">
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
            Non-drinkers?
          </h3>
          <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
            Some of your guests may not drink beer or wine. We can bring mocktails or
            non-alcoholic beer as an optional extra.
          </p>
          <div className="form-group">
            <div className="checkbox-grid">
              {NA_OPTIONS.map((opt) => (
                <label key={opt.value} className="checkbox-label">
                  <input
                    type="radio"
                    name="hostedNaInterest"
                    checked={prefs.naInterest === opt.value}
                    onChange={() => update({ naInterest: opt.value })}
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
            {prefs.naInterest === 'yes' && (
              <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
                {mocktailAddon && (
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={mocktailOn}
                      onChange={() => toggleAddOn('pre-batched-mocktail')}
                    />
                    <span>
                      Add a pre-batched mocktail (${Number(mocktailAddon.rate).toFixed(2)}/guest)
                    </span>
                  </label>
                )}
                {naBeerAddon && (
                  <label className="checkbox-label" style={{ marginTop: '0.25rem' }}>
                    <input
                      type="checkbox"
                      checked={naBeerOn}
                      onChange={() => toggleAddOn('non-alcoholic-beer')}
                    />
                    <span>
                      Add non-alcoholic beer (${Number(naBeerAddon.rate).toFixed(2)}/guest)
                    </span>
                  </label>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
