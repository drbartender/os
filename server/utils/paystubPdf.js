// server/utils/paystubPdf.js
const PDFDocument = require('pdfkit');
const { getEventTypeLabel } = require('./eventTypes');

// Helvetica (pdfkit default) lacks some Unicode glyphs; fold to ASCII for the
// PDF only. Source data is unchanged. \u escapes (not literal glyphs) for
// encoding-safety, matching agreementPdf.js's style.
function normalizeForPdf(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/[\u2022\u2013]/g, '-')   // bullet, en dash
    .replace(/\u2014/g, '--')          // em dash
    .replace(/[\u2018\u2019]/g, "'")   // curly single quotes
    .replace(/[\u201C\u201D]/g, '"');  // curly double quotes
}

// Integer cents -> "$1,234.56" ("-$19.36" for negatives). Mirrors client formatMoney.
function formatUsdCents(cents) {
  const n = Math.round(Number(cents) || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  const rem = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}$${dollars}.${rem}`;
}

// NUMERIC(5,2) hours arrive from pg as strings ("6.00"); render "6h" / "5.5h",
// never "6.00h". Number() drops trailing zeros; guards null/garbage to ''.
function formatHours(h) {
  const n = Number(h);
  return Number.isFinite(n) ? String(n) : '';
}

// Canonical event-type label (CLAUDE.md event-identity rule) — never the raw
// slug. getEventTypeLabel maps ids/custom text to a human label ('event'
// fallback) so a real booking reads "Smith Family / Birthday Party", not
// "Smith Family / birthday-party".
function eventLabel(ev) {
  const t = getEventTypeLabel(ev);
  return ev.client_name ? `${ev.client_name} / ${t}` : t;
}

/**
 * @param {object} data { contractorName, period:{start_date,end_date,payday},
 *   paid:{at,method}, events:[...], thisPeriod:{..._cents}, ytd:{..._cents} }
 * @returns {Promise<Buffer>}
 */
function renderPaystubPdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const M = 54;            // left margin
      const COL_A = 320;       // "this period" column x
      const COL_B = 430;       // "year to date" column x
      const COL_W = 110;       // numeric column width

      // -- Header --------------------------------------------------
      doc.fontSize(18).font('Helvetica-Bold').text('Dr. Bartender', M, M, { continued: false });
      doc.fontSize(12).font('Helvetica').text('PAYSTUB', M, M + 2, { align: 'right' });
      doc.moveDown(0.6);
      doc.fontSize(12).font('Helvetica-Bold').text(normalizeForPdf(data.contractorName || 'Contractor'));
      doc.fontSize(9).font('Helvetica').fillColor('#555');
      doc.text(`Pay period: ${data.period.start_date} to ${data.period.end_date}`);
      doc.text(`Payday: ${data.period.payday}`);
      if (data.paid && data.paid.at) {
        // Method only — no payment_handle on the document (PII).
        const via = data.paid.method ? ` via ${data.paid.method}` : '';
        doc.text(`Paid: ${data.paid.at}${via}`);
      }
      doc.fillColor('black').moveDown(1);

      // -- Line items ----------------------------------------------
      doc.fontSize(11).font('Helvetica-Bold').text('Shifts this period');
      doc.moveDown(0.3);
      doc.fontSize(9).font('Helvetica');
      (data.events || []).forEach((ev) => {
        const y = doc.y;
        doc.text(`${ev.event_date || ''}  ${normalizeForPdf(eventLabel(ev))}`, M, y, { width: 250 });
        doc.text(`${formatHours(ev.hours)}h`, 300, y, { width: 40, align: 'right' });
        doc.text(formatUsdCents(ev.line_total_cents), 460, y, { width: 80, align: 'right' });
        if (Number(ev.adjustment_cents) !== 0) {
          doc.fillColor('#555').fontSize(8).text(
            `   ${formatUsdCents(ev.adjustment_cents)} adjustment${ev.adjustment_note ? `: ${normalizeForPdf(ev.adjustment_note)}` : ''}`,
            M, doc.y, { width: 480 }
          );
          doc.fillColor('black').fontSize(9);
        }
        doc.moveDown(0.15);
      });
      doc.moveDown(0.6);

      // -- Totals: this period | year to date ----------------------
      const tp = data.thisPeriod, ytd = data.ytd;
      const headY = doc.y;
      doc.fontSize(8).fillColor('#555');
      doc.text('This period', COL_A, headY, { width: COL_W, align: 'right' });
      doc.text('Year to date', COL_B, headY, { width: COL_W, align: 'right' });
      doc.fillColor('black').moveDown(0.2);
      const totalsRow = (label, a, b, bold) => {
        const y = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5);
        doc.text(label, M, y, { width: 200 });
        doc.text(formatUsdCents(a), COL_A, y, { width: COL_W, align: 'right' });
        doc.text(formatUsdCents(b), COL_B, y, { width: COL_W, align: 'right' });
        doc.moveDown(0.25);
      };
      totalsRow('Wages', tp.wages_cents, ytd.wages_cents);
      totalsRow('Gratuity', tp.gratuity_cents, ytd.gratuity_cents);
      totalsRow('Card tips', tp.card_tips_net_cents, ytd.card_tips_net_cents);
      totalsRow('Adjustments', tp.adjustments_cents, ytd.adjustments_cents);
      doc.moveDown(0.15);
      totalsRow('NET PAID', tp.net_cents, ytd.net_cents, true);
      doc.moveDown(1);

      doc.fontSize(8).font('Helvetica').fillColor('#777')
        .text('Independent contractor payment, no taxes withheld (1099).', M, doc.y);
      doc.fillColor('black');

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderPaystubPdf, formatUsdCents, eventLabel };
