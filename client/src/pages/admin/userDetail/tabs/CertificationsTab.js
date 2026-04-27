import React from 'react';
import Icon from '../../../../components/adminos/Icon';
import StatusChip from '../../../../components/adminos/StatusChip';

export default function CertificationsTab({ profile, application, downloadFile }) {
  const alcoholUrl = profile?.alcohol_certification_file_url || application?.basset_file_url;
  const alcoholName = profile?.alcohol_certification_filename || application?.basset_filename;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 'var(--gap)' }}>
      <div className="card">
        <div className="card-head">
          <h3>Certifications & licenses</h3>
          <button type="button" className="btn btn-secondary btn-sm" disabled>
            <Icon name="plus" size={11} />Upload
          </button>
        </div>
        <div className="card-body">
          {alcoholUrl ? (
            <div className="vstack" style={{ gap: 8 }}>
              <div className="hstack" style={{ padding: '10px 12px', background: 'var(--bg-2)', borderRadius: 3, border: '1px solid var(--line-1)' }}>
                <Icon name="clipboard" size={14} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13 }}><strong>Alcohol certification</strong></div>
                  <div className="tiny muted">{alcoholName || 'Uploaded'}</div>
                </div>
                <StatusChip kind="ok">On file</StatusChip>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => downloadFile(alcoholUrl)}
                >
                  <Icon name="external" size={11} />Open
                </button>
              </div>
            </div>
          ) : (
            <div className="muted tiny" style={{ padding: 8 }}>
              No certifications on file. A general cert table isn't tracked yet — upload alcohol cert via the contractor profile.
            </div>
          )}
        </div>
      </div>

      <div className="vstack" style={{ gap: 'var(--gap)' }}>
        <div className="card">
          <div className="card-head"><h3>Compliance</h3></div>
          <div className="card-body">
            <dl className="dl">
              <dt>Alcohol cert</dt>
              <dd>{alcoholUrl ? <StatusChip kind="ok">On file</StatusChip> : <StatusChip kind="warn">Missing</StatusChip>}</dd>
              <dt>Eligible for</dt>
              <dd>{alcoholUrl ? 'All event types' : 'NA-only events'}</dd>
            </dl>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h3>Reminders</h3></div>
          <div className="card-body vstack" style={{ gap: 8 }}>
            <div className="tiny muted">Renewal-tracking schema not built yet — set up before launch if you'll auto-email staff before expirations.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
