import React from 'react';

// Small origin badge next to a proposal's client name. Renders only for
// Thumbtack-sourced proposals (source === 'thumbtack'); null source means
// manual/direct and shows nothing. Admin surfaces only.
export default function SourceBadge({ source }) {
  if (source !== 'thumbtack') return null;
  return (
    <span
      className="badge"
      style={{ background: '#e8f0fe', color: '#1a5fb4', marginLeft: 6 }}
      title="From Thumbtack"
    >
      Thumbtack
    </span>
  );
}
