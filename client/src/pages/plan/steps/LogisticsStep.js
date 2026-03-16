import React from 'react';

export default function LogisticsStep({ notes, onChange }) {
  return (
    <div className="card">
      <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.5rem' }}>
        Logistics &amp; Final Notes
      </h2>
      <p className="text-muted mb-2">
        Anything else we should know? Guest count, venue details, timing preferences, dietary
        restrictions, or special requests — this is the place.
      </p>

      <div className="form-group">
        <label className="form-label">Additional Notes</label>
        <textarea
          className="form-textarea"
          rows={6}
          placeholder="E.g., 150 guests, outdoor venue, cocktail hour is 5-6pm, some guests are gluten-free..."
          value={notes}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}
