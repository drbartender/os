import React from 'react';
import { formatPhone } from '../../../../utils/formatPhone';

const formatDOB = (m, d, y) => {
  if (!m || !d || !y) return '—';
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
};

const formatAddress = (a) => {
  const parts = [
    a.street_address,
    [a.city, a.state].filter(Boolean).join(', '),
    a.zip_code,
  ].filter(Boolean);
  return parts.join(' · ') || '—';
};

// Contact and identity from `applications` columns. No edit affordance yet —
// admin can correct via the legacy admin user flow if needed.
export default function SectionContact({ a }) {
  return (
    <div className="card">
      <div className="card-head"><h3>Contact &amp; identity</h3></div>
      <div className="card-body">
        <dl className="dl">
          <dt>Email</dt>
          <dd>{a.email}</dd>
          <dt>Phone</dt>
          <dd className="mono">{formatPhone(a.phone) || a.phone}</dd>
          <dt>Address</dt>
          <dd>{formatAddress(a)}</dd>
          <dt>Date of birth</dt>
          <dd>{formatDOB(a.birth_month, a.birth_day, a.birth_year)}</dd>
          <dt>Emergency contact</dt>
          <dd>
            {a.emergency_contact_name || '—'}
            {a.emergency_contact_relationship && (
              <span className="muted"> · {a.emergency_contact_relationship}</span>
            )}
            {a.emergency_contact_phone && (
              <div className="tiny muted mono">
                {formatPhone(a.emergency_contact_phone) || a.emergency_contact_phone}
              </div>
            )}
          </dd>
        </dl>
      </div>
    </div>
  );
}
