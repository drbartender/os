// The "what you signed" block of the client's sign-time emails (audit ESIG-05): the agreement
// version and its revised date, the signer and the time, the service rows, the gratuity line and
// the acknowledged total, as HTML and as text, read from a proposal row's signed record
// (client_signed_snapshot, the public price view the sign stored). Required by emailTemplates.js
// and lifecycleEmailTemplates.js; depends on htmlEscape.js and agreementVersions.js only, so it
// joins no template require cycle.
//
// The rows are the ones the page drew (hidden lines folded on the server, law 5), so the email
// can never name a label the client did not see. Money is printed through integer cents.

'use strict';

const { esc } = require('./htmlEscape');
const { AGREEMENT_REVISED_DATES } = require('./agreementVersions');

// The palette of both template files (kept identical there by hand).
const BRAND = { primary: '#3b2314', secondary: '#6b4226' };

/** Dollars for display, through integer cents; '' for anything that is not money. */
function dollarsLabel(v) {
  const cents = Math.round(Number(v) * 100);
  if (!Number.isFinite(cents)) return '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  return `${cents < 0 ? '-' : ''}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

// '2026-09-27' -> 'September 27, 2026'; null for anything else.
function longDate(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
}

// The signing moment in the business time zone, the way the lifecycle
// templates print consult slots.
function signedAtLabel(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return `${d.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} Central`;
}

/**
 * The template input from a proposals row (any read carrying client_signed_at,
 * client_signed_name, client_signature_document_version and
 * client_signed_snapshot), or null when the row holds no signed record: an
 * unsigned row, or a signature from before the record was stored.
 */
function signedRecordFromRow(row) {
  const snap = row && row.client_signed_snapshot;
  if (!row || !row.client_signed_at || !snap || typeof snap !== 'object' || Array.isArray(snap)) return null;
  const version = row.client_signature_document_version || snap.document_version || null;
  const gratuity = Number(snap.gratuity_amount);
  return {
    documentVersion: version,
    revisedDate: version && Object.prototype.hasOwnProperty.call(AGREEMENT_REVISED_DATES, version)
      ? AGREEMENT_REVISED_DATES[version] : null,
    signedName: row.client_signed_name || null,
    signedAt: row.client_signed_at,
    rows: Array.isArray(snap.rows) ? snap.rows : [],
    gratuityAmount: Number.isFinite(gratuity) && gratuity > 0 ? gratuity : 0,
    gratuityLabel: snap.gratuity_label || 'Gratuity',
    total: snap.total === null || snap.total === undefined || snap.total === '' ? null : Number(snap.total),
  };
}

/** The block as { html, text }; both empty for a null record. */
function signedRecordBlock(record) {
  if (!record) return { html: '', text: '' };
  const lines = (Array.isArray(record.rows) ? record.rows : [])
    .map((r) => ({ label: r && r.label ? String(r.label) : 'Your package', amount: r ? r.amount : 0 }));
  if (record.gratuityAmount > 0) lines.push({ label: record.gratuityLabel || 'Gratuity', amount: record.gratuityAmount });
  const revised = longDate(record.revisedDate);
  const when = signedAtLabel(record.signedAt);
  const versionLine = [
    record.documentVersion ? `Event Services Agreement, version ${record.documentVersion}` : 'Event Services Agreement',
    revised ? `revised ${revised}` : null,
  ].filter(Boolean).join(', ');
  const signerLine = [
    record.signedName ? `signed by ${record.signedName}` : 'signed',
    when ? `on ${when}` : null,
  ].filter(Boolean).join(' ');
  const hasTotal = record.total !== null && record.total !== undefined && Number.isFinite(Number(record.total));

  const cell = 'padding:6px 12px;border-bottom:1px solid #e0d6cf;';
  const rowsHtml = lines.map((l) =>
    `<tr><td style="${cell}">${esc(l.label)}</td><td style="${cell}text-align:right;">${esc(dollarsLabel(l.amount))}</td></tr>`).join('');
  const totalHtml = hasTotal
    ? `<tr><td style="padding:6px 12px;font-weight:bold;color:${BRAND.primary};">Total</td><td style="padding:6px 12px;text-align:right;font-weight:bold;color:${BRAND.primary};">${esc(dollarsLabel(record.total))}</td></tr>`
    : '';
  const html = `
      <h3 style="color:${BRAND.primary};margin-top:1.5rem;">What you signed</h3>
      <p style="font-size:14px;color:${BRAND.secondary};">${esc(versionLine)}; ${esc(signerLine)}.</p>
      <table style="width:100%;border-collapse:collapse;margin:0.75rem 0;">${rowsHtml}${totalHtml}</table>
      <p style="font-size:13px;color:${BRAND.secondary};">Keep this email as your copy of the terms as signed. The full agreement text is on your proposal page.</p>`;
  const text = [
    'What you signed:',
    `${versionLine}; ${signerLine}.`,
    ...lines.map((l) => `${l.label}: ${dollarsLabel(l.amount)}`),
    hasTotal ? `Total: ${dollarsLabel(record.total)}` : null,
    'Keep this email as your copy of the terms as signed.',
  ].filter((x) => x !== null).join('\n');
  return { html, text };
}

module.exports = { signedRecordFromRow, signedRecordBlock, dollarsLabel };
