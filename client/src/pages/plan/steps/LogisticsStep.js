import React from 'react';

const PARKING_OPTIONS = [
  { value: 'yes', label: 'Yes, dedicated parking available' },
  { value: 'street', label: 'Street parking only' },
  { value: 'limited', label: 'Limited parking' },
  { value: 'no', label: 'No parking available' },
];

const ICE_OPTIONS = [
  { value: 'yes', label: 'Yes, there is an ice machine' },
  { value: 'no', label: 'No ice machine available' },
];

export default function LogisticsStep({ logistics, onChange }) {
  const parking = logistics?.parking || '';
  const ice = logistics?.ice || '';
  const other = logistics?.other || '';

  const update = (field, value) => {
    onChange({ ...logistics, [field]: value });
  };

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Logistics &amp; Final Details
        </h2>
        <p className="text-muted">
          A few quick questions to help us prepare for your event.
        </p>
      </div>

      {/* Parking */}
      <div className="card mb-2">
        <div className="form-group">
          <label className="form-label">Is there parking available for our bartender at the venue?</label>
          <div className="checkbox-grid">
            {PARKING_OPTIONS.map(opt => (
              <label key={opt.value} className="checkbox-label">
                <input
                  type="radio"
                  name="parking"
                  checked={parking === opt.value}
                  onChange={() => update('parking', opt.value)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Ice */}
      <div className="card mb-2">
        <div className="form-group">
          <label className="form-label">Do you have access to an ice machine at the venue?</label>
          <div className="checkbox-grid">
            {ICE_OPTIONS.map(opt => (
              <label key={opt.value} className="checkbox-label">
                <input
                  type="radio"
                  name="ice"
                  checked={ice === opt.value}
                  onChange={() => update('ice', opt.value)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Other Notes */}
      <div className="card">
        <div className="form-group">
          <label className="form-label">Anything else we should know?</label>
          <textarea
            className="form-textarea"
            rows={5}
            placeholder="E.g., 150 guests, outdoor venue, cocktail hour is 5-6pm, some guests are gluten-free..."
            value={other}
            onChange={(e) => update('other', e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}
