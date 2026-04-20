// server/utils/agreementPdf.js
const PDFDocument = require('pdfkit');

// PDFKit's built-in Helvetica doesn't support U+2022 (bullet) or U+2014 (em-dash).
// Normalize these to ASCII equivalents for PDF rendering only. Source data remains unchanged.
function normalizeForPdf(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/\u2022/g, '-').replace(/\u2014/g, '--');
}

// Render a string that may contain **bold** markdown runs. Chains runs via continued:true.
// fontSize/normal font must be set by the caller; this helper toggles font between runs.
function renderMixedBoldText(doc, str, options = {}) {
  const text = normalizeForPdf(str);
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  parts.forEach((part, i) => {
    const isLast = i === parts.length - 1;
    const isBold = part.startsWith('**') && part.endsWith('**');
    const content = isBold ? part.slice(2, -2) : part;
    doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica');
    doc.text(content, { ...options, continued: !isLast });
  });
}

/**
 * Render a signed contractor agreement to a PDF buffer.
 *
 * @param {Object} versionData - From contractorAgreement.js (has version, effective_date, clauses[], acknowledgments[]).
 * @param {Object} signerData - {
 *   full_name, email, phone,
 *   signature_data (PNG data URL when method='draw', plain text when method='type'),
 *   signature_method ('draw' or 'type'),
 *   signature_ip, signature_user_agent, signed_at (Date or ISO string),
 *   acknowledgments: { ack_ic_status: true, ack_commitment: true, ... }
 * }
 * @returns {Promise<Buffer>}
 */
function renderAgreementPdf(versionData, signerData) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ── Header ───────────────────────────────────────────────
      doc.fontSize(20).font('Helvetica-Bold').text('Dr. Bartender', { align: 'center' });
      doc.moveDown(0.2);
      doc.fontSize(14).font('Helvetica').text('Independent Contractor Agreement', { align: 'center' });
      doc.moveDown(0.2);
      doc.fontSize(9).fillColor('#555').text(
        `Version: ${versionData.version}  ·  Effective: ${versionData.effective_date}`,
        { align: 'center' }
      );
      doc.fillColor('black');
      doc.moveDown(1);

      // ── Clauses ─────────────────────────────────────────────
      versionData.clauses.forEach((clause) => {
        doc.fontSize(11).font('Helvetica-Bold').text(`${clause.number}. ${clause.title}`);
        doc.moveDown(0.3);
        doc.fontSize(10);
        renderMixedBoldText(doc, clause.formal, { align: 'justify' });
        doc.moveDown(0.7);
      });

      // ── Acknowledgments ─────────────────────────────────────
      doc.addPage();
      doc.fontSize(13).font('Helvetica-Bold').text('Contractor Acknowledgments');
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica').text(
        'The contractor confirmed each of the following at the time of signing:'
      );
      doc.moveDown(0.5);
      versionData.acknowledgments.forEach((ack) => {
        const checked = signerData.acknowledgments?.[ack.key] === true;
        doc.font('Helvetica-Bold').text(checked ? '[X]' : '[ ]', { continued: true });
        doc.font('Helvetica').text(' ' + normalizeForPdf(ack.label));
        doc.moveDown(0.25);
      });

      // ── Signer block ────────────────────────────────────────
      doc.moveDown(1);
      doc.fontSize(13).font('Helvetica-Bold').text('Signature');
      doc.moveDown(0.5);

      // Normalize + cap user-supplied strings once, then reuse below.
      const nName = normalizeForPdf(signerData.full_name || '').slice(0, 200);
      const nEmail = normalizeForPdf(signerData.email || '').slice(0, 200);
      const nPhone = signerData.phone ? normalizeForPdf(signerData.phone).slice(0, 50) : null;
      const nUA = signerData.signature_user_agent
        ? normalizeForPdf(signerData.signature_user_agent).slice(0, 400)
        : null;

      if (signerData.signature_method === 'draw'
          && typeof signerData.signature_data === 'string'
          && /^data:image\/(png|jpe?g);base64,/.test(signerData.signature_data)) {
        const b64 = signerData.signature_data.replace(/^data:image\/(png|jpe?g);base64,/, '');
        const imgBuf = Buffer.from(b64, 'base64');
        try {
          doc.image(imgBuf, { width: 200 });
        } catch (imgErr) {
          doc.fontSize(10).font('Helvetica-Oblique').text('[Signature image could not be rendered]');
        }
      } else if (signerData.signature_method === 'type' && signerData.signature_data) {
        doc.fontSize(20).font('Helvetica-Oblique').text(
          normalizeForPdf(signerData.signature_data).slice(0, 100)
        );
      } else {
        doc.fontSize(10).font('Helvetica-Oblique').text('[No signature captured]');
      }
      doc.moveDown(0.5);

      doc.fontSize(10).font('Helvetica').text(`Name: ${nName}`);
      doc.text(`Email: ${nEmail}`);
      if (nPhone) doc.text(`Phone: ${nPhone}`);

      const signedAt = signerData.signed_at
        ? new Date(signerData.signed_at).toISOString()
        : new Date().toISOString();
      doc.text(`Signed: ${signedAt}`);
      if (signerData.signature_ip) doc.text(`IP: ${signerData.signature_ip}`);
      if (nUA) {
        doc.fontSize(8).fillColor('#666').text(`User Agent: ${nUA}`);
        doc.fillColor('black');
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderAgreementPdf };
