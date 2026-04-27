import React from 'react';
import { formatPhone } from '../../../../utils/formatPhone';

export default function ApplicationTab({ application }) {
  let positions = [];
  try { positions = JSON.parse(application.positions_interested || '[]'); } catch { positions = []; }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 'var(--gap)' }}>
      <div className="card">
        <div className="card-head"><h3>Original application</h3></div>
        <div className="card-body">
          <dl className="dl">
            <dt>Full name</dt><dd>{application.full_name || '—'}</dd>
            <dt>Phone</dt><dd>{application.phone ? formatPhone(application.phone) : '—'}</dd>
            <dt>DOB</dt>
            <dd>
              {application.birth_month && application.birth_day && application.birth_year
                ? `${application.birth_month}/${application.birth_day}/${application.birth_year}`
                : '—'}
            </dd>
            <dt>Address</dt>
            <dd>{[application.street_address, application.city, application.state, application.zip_code].filter(Boolean).join(', ') || '—'}</dd>
            <dt>Travel</dt><dd>{application.travel_distance || '—'}</dd>
            <dt>Transport</dt><dd>{application.reliable_transportation || '—'}</dd>
            <dt>Bartending exp.</dt><dd>{application.has_bartending_experience ? 'Yes' : 'No'}</dd>
            <dt>Last worked</dt><dd>{application.last_bartending_time || '—'}</dd>
            <dt>Saturdays</dt><dd>{application.available_saturdays || '—'}</dd>
            <dt>Setup confidence</dt><dd>{application.setup_confidence ? `${application.setup_confidence}/5` : '—'}</dd>
          </dl>

          {application.bartending_experience_description && (
            <div style={{ marginTop: 12 }}>
              <div className="meta-k" style={{ marginBottom: 4 }}>Description</div>
              <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55 }}>
                {application.bartending_experience_description}
              </div>
            </div>
          )}

          {application.why_dr_bartender && (
            <div style={{ marginTop: 12 }}>
              <div className="meta-k" style={{ marginBottom: 4 }}>Why Dr. Bartender</div>
              <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55 }}>
                {application.why_dr_bartender}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="vstack" style={{ gap: 'var(--gap)' }}>
        {positions.length > 0 && (
          <div className="card">
            <div className="card-head"><h3>Positions of interest</h3></div>
            <div className="card-body hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
              {positions.map(p => <span key={p} className="tag">{p}</span>)}
            </div>
          </div>
        )}
        {application.favorite_color && (
          <div className="card">
            <div className="card-head"><h3>Fun</h3></div>
            <div className="card-body">
              <dl className="dl">
                <dt>Favorite color</dt><dd>{application.favorite_color}</dd>
              </dl>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
