// The admin staff record's Documents tab: the contractor agreement (its signed PDF through the
// prefix-checked admin-only route when the viewer is an admin, a resend of the signer's copy when
// the sign-time email never went out), the W-9, the alcohol certification, the resume and the
// headshot, each opened in the document lightbox, plus the signature and acknowledgments cards.

import React, { useState } from 'react';
import api from '../../../../utils/api';
import { useToast } from '../../../../context/ToastContext';
import Icon from '../../../../components/adminos/Icon';
import StatusChip from '../../../../components/adminos/StatusChip';
import { ctDay, fmtDateFull } from '../../../../components/adminos/format';

export default function DocumentsTab({ showTax = true, canOpenAgreement = false, agreement, payment, profile, application, previewFile, previewLoading }) {
  const toast = useToast();
  // The signer's copy of the agreement (audit ESIG-04): the PDF exists but the
  // sign-time email never went out, until an admin resends it here.
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const copyNotEmailed = !!(agreement?.pdf_generated_at && !agreement?.pdf_email_sent_at && !resent);
  const resendCopy = async () => {
    if (resending || !agreement?.user_id) return;
    setResending(true);
    try {
      await api.post(`/agreement/admin/${agreement.user_id}/resend-copy`);
      setResent(true);
      toast.success('Copy emailed to the contractor.');
    } catch (e) {
      toast.error(e.message || 'Could not resend the copy.');
    } finally {
      setResending(false);
    }
  };
  // url + filename are derived as a PAIR from the same source (profile vs
  // application). Mixing a profile URL with an application filename would let
  // the extension used for preview-type detection mismatch the file served.
  const alcohol = profile?.alcohol_certification_file_url
    ? { url: profile.alcohol_certification_file_url, filename: profile?.alcohol_certification_filename || null }
    : { url: application?.basset_file_url || null, filename: application?.basset_filename || null };
  const resume = profile?.resume_file_url
    ? { url: profile.resume_file_url, filename: profile?.resume_filename || null }
    : { url: application?.resume_file_url || null, filename: application?.resume_filename || null };
  const headshot = profile?.headshot_file_url
    ? { url: profile.headshot_file_url, filename: profile?.headshot_filename || null }
    : { url: application?.headshot_file_url || null, filename: application?.headshot_filename || null };

  const items = [
    {
      name: 'Contractor agreement',
      sub: agreement?.signed_at
        ? `Signed ${fmtDateFull(ctDay(agreement.signed_at))}${copyNotEmailed ? ' · Copy not emailed' : ''}`
        : 'Not signed yet',
      kind: agreement?.signed_at ? (copyNotEmailed ? 'warn' : 'ok') : 'warn',
      // The stored PDF through the admin-only route (prefix-checked, 15-minute
      // URL); previewFile fetches it and the lightbox renders the PDF. Offered
      // only when the parent says the viewer may open it (an admin): the route
      // refuses a manager, since the PDF shows the signature, IP and user agent
      // the staff record withholds from one. Refuses by default.
      url: canOpenAgreement && agreement?.pdf_storage_key && agreement?.user_id ? `/agreement/admin/${agreement.user_id}/pdf` : null,
      filename: canOpenAgreement && agreement?.pdf_storage_key ? 'contractor-agreement.pdf' : null,
      action: copyNotEmailed ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={resendCopy} disabled={resending}>
          <Icon name="mail" size={11} />{resending ? 'Sending…' : 'Resend copy'}
        </button>
      ) : null,
    },
    {
      name: 'W-9 (current year)',
      // Withheld from a manager with the rest of the payment row.
      tax: true,
      sub: payment?.w9_file_url ? (payment.w9_filename || 'Submitted') : 'Missing',
      kind: payment?.w9_file_url ? 'ok' : 'danger',
      url: payment?.w9_file_url || null,
      filename: payment?.w9_filename || null,
    },
    {
      name: 'Alcohol certification',
      sub: alcohol.filename || (alcohol.url ? 'Submitted' : 'Missing'),
      kind: alcohol.url ? 'ok' : 'warn',
      url: alcohol.url,
      filename: alcohol.filename,
    },
    {
      name: 'Resume',
      sub: resume.filename || (resume.url ? 'Submitted' : 'Not on file'),
      kind: resume.url ? 'ok' : 'neutral',
      url: resume.url,
      filename: resume.filename,
    },
    {
      name: 'Headshot',
      sub: headshot.filename || (headshot.url ? 'Submitted' : 'Not on file'),
      kind: headshot.url ? 'ok' : 'neutral',
      url: headshot.url,
      filename: headshot.filename,
    },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 'var(--gap)' }}>
      <div className="card">
        <div className="card-head"><h3>Documents</h3></div>
        <div className="card-body vstack" style={{ gap: 6 }}>
          {items.filter((it) => showTax || !it.tax).map((it) => (
            <div
              key={it.name}
              className="hstack"
              style={{ padding: '10px 12px', background: 'var(--bg-2)', borderRadius: 3, border: '1px solid var(--line-1)' }}
            >
              <Icon name="clipboard" size={14} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13 }}><strong>{it.name}</strong></div>
                <div className="tiny muted">{it.sub}</div>
              </div>
              <StatusChip kind={it.kind === 'neutral' ? 'neutral' : it.kind}>
                {it.kind === 'ok' ? 'On file' : it.kind === 'danger' ? 'Missing' : it.kind === 'warn' ? 'Action' : '—'}
              </StatusChip>
              {it.url && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => previewFile(it.url, it.filename, it.name)}
                  disabled={previewLoading === it.url}
                >
                  <Icon name="external" size={11} />{previewLoading === it.url ? 'Opening…' : 'Open'}
                </button>
              )}
              {it.action || null}
            </div>
          ))}
        </div>
      </div>

      <div className="vstack" style={{ gap: 'var(--gap)' }}>
        {agreement?.signed_at && agreement?.signature_data && (
          <div className="card">
            <div className="card-head"><h3>Signature</h3></div>
            <div className="card-body">
              <div className="tiny muted" style={{ marginBottom: 8 }}>
                {agreement.signature_method === 'type' ? 'Typed' : 'Drawn'} on {fmtDateFull(ctDay(agreement.signed_at))}
              </div>
              {agreement.signature_method === 'type' ? (
                <div style={{ padding: '0.75rem 1rem', background: 'var(--bg-2)', border: '1px solid var(--line-1)', borderRadius: 3 }}>
                  <span style={{ fontFamily: "'Brush Script MT', 'Segoe Script', cursive", fontSize: '1.5rem', color: 'var(--ink-1)' }}>
                    {agreement.signature_data}
                  </span>
                </div>
              ) : (
                <div style={{ padding: 8, background: 'var(--bg-2)', border: '1px solid var(--line-1)', borderRadius: 3 }}>
                  <img src={agreement.signature_data} alt="Signature" style={{ maxWidth: '100%', display: 'block' }} />
                </div>
              )}
            </div>
          </div>
        )}

        {agreement?.signed_at && (
          <div className="card">
            <div className="card-head"><h3>Acknowledgments</h3></div>
            <div className="card-body">
              <dl className="dl">
                <dt>SMS consent</dt><dd>{agreement.sms_consent ? <StatusChip kind="ok">Yes</StatusChip> : <StatusChip kind="warn">No</StatusChip>}</dd>
                <dt>IC status</dt><dd>{agreement.ack_ic_status ? '✓' : '—'}</dd>
                <dt>Commitment</dt><dd>{agreement.ack_commitment ? '✓' : '—'}</dd>
                <dt>Non-solicit</dt><dd>{(agreement.agreed_non_solicitation || agreement.ack_non_solicit) ? '✓' : '—'}</dd>
                <dt>Damage</dt><dd>{agreement.ack_damage_recoupment ? '✓' : '—'}</dd>
                <dt>Legal</dt><dd>{agreement.ack_legal_protections ? '✓' : '—'}</dd>
                <dt>Field guide</dt><dd>{(agreement.acknowledged_field_guide || agreement.ack_field_guide) ? '✓' : '—'}</dd>
              </dl>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
