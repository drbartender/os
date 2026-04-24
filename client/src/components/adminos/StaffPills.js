import React from 'react';

/**
 * positions: array of { role, name, status } where
 *   status === 'approved' → filled pill (green)
 *   status === 'pending'  → pending pill (amber)
 *   anything else         → empty (open)
 */
export default function StaffPills({ positions = [] }) {
  const filled = positions.filter(p => p.status === 'approved').length;
  const pending = positions.filter(p => p.status === 'pending').length;
  const total = positions.length;
  const shortBy = total - filled - pending;
  return (
    <span className="hstack" style={{ gap: 6 }}>
      <span className="staff-pills">
        {positions.map((p, i) => (
          <span
            key={i}
            className={`staff-pill ${p.status === 'approved' ? 'filled' : p.status === 'pending' ? 'pending' : ''}`}
            title={`${p.role}${p.name ? ': ' + p.name : ' (open)'}`}
          />
        ))}
      </span>
      <span className={`staff-count ${shortBy > 0 ? 'short' : ''}`}>
        {filled}/{total}{shortBy > 0 && ` · ${shortBy} open`}
      </span>
    </span>
  );
}
