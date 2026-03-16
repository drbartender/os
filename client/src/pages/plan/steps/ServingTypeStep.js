import React from 'react';
import { SERVING_TYPES } from '../data/servingTypes';

export default function ServingTypeStep({ selected, onSelect }) {
  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          What's on the Menu?
        </h2>
        <p className="text-muted">
          This choice determines what drinks will be served and guides the questions that follow.
        </p>
      </div>

      <div className="serving-type-grid">
        {SERVING_TYPES.map(type => (
          <button
            key={type.key}
            className={`card serving-type-card${selected === type.key ? ' selected' : ''}`}
            onClick={() => onSelect(type.key)}
          >
            <span className="serving-type-emoji">{type.emoji}</span>
            <h3 className="serving-type-label">{type.label}</h3>
            <p className="serving-type-desc">{type.description}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
