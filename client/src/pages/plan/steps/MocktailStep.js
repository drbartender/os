import React from 'react';

export default function MocktailStep({ notes, onChange, onNext, onSkip }) {
  return (
    <div>
      <div className="card">
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.5rem' }}>
          Mocktail Preferences
        </h2>
        <p className="text-muted mb-2">
          Tell us about the kind of non-alcoholic drinks you'd love to see at your event.
          Think flavors, themes, dietary needs, or any specific drinks you have in mind.
        </p>

        <div className="form-group">
          <label className="form-label">Notes &amp; Preferences</label>
          <textarea
            className="form-textarea"
            rows={6}
            placeholder="E.g., fruity and colorful, nothing too sweet, kid-friendly options, sparkling mocktails..."
            value={notes}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      </div>

      {/* Navigation — handled internally when onNext/onSkip are provided */}
      {(onNext || onSkip) && (
        <div className="step-nav mt-2">
          <div />
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            {onSkip && (
              <button className="btn btn-secondary" onClick={onSkip}>
                Skip
              </button>
            )}
            {onNext && (
              <button className="btn" onClick={onNext}>
                Continue
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
