// The W-9 for onboarding: the empty form, its field checks, and the signed PDF built from it.
//
// Split out of components/W9Form.js so the Payday Protocols page can check the W-9 and
// build its PDF inside the one Submit Onboarding press (there is no separate generate
// button any more). The PDF drawing code is unchanged from W9Form.js as of 2026-10-31.
// Nothing here stores the form: the SSN and EIN live only in page state until the PDF
// is posted to /api/payment.

// The IRS form revision this page draws. Printed on the PDF's header line and
// sent beside the file so the server records which revision was certified
// (payment_profiles.w9_form_revision, audit ESIG-07); bump both together.
export const W9_FORM_REVISION = 'Rev. March 2024';

export const EMPTY_W9 = {
  name: '',
  business_name: '',
  tax_classification: 'Individual/sole proprietor or single-member LLC',
  address: '',
  city: '',
  state: '',
  zip: '',
  ssn1: '',
  ssn2: '',
  ssn3: '',
  ein: '',
  use_ein: false,
  exempt_payee_code: '',
  signatureData: '',
  signatureMethod: null,
};

const DIGITS = /^\d+$/;

/**
 * The W-9's required-field checks, one message per field so each can sit under its
 * own input. The SSN's three boxes share the key `ssn`.
 *
 * @param {object} w9  the form, shaped like EMPTY_W9
 * @returns {object}   field name to message; empty when the form is complete
 */
export function validateW9(w9) {
  const errors = {};
  const blank = v => !String(v || '').trim();

  if (blank(w9.name)) errors.name = 'Your legal name (as on your tax return) is required.';
  if (blank(w9.address)) errors.address = 'Street address is required.';
  if (blank(w9.city)) errors.city = 'City is required.';
  if (!w9.state) errors.state = 'State is required.';
  if (blank(w9.zip)) errors.zip = 'ZIP is required.';

  if (!w9.use_ein) {
    if (!w9.ssn1 || !w9.ssn2 || !w9.ssn3) {
      errors.ssn = 'Social Security Number is required.';
    } else if (
      w9.ssn1.length !== 3 || w9.ssn2.length !== 2 || w9.ssn3.length !== 4
      || !DIGITS.test(w9.ssn1 + w9.ssn2 + w9.ssn3)
    ) {
      errors.ssn = 'SSN must be 9 digits, in XXX-XX-XXXX format.';
    }
  } else if (blank(w9.ein)) {
    errors.ein = 'Employer Identification Number is required.';
  }

  if (!w9.signatureData) errors.signature = 'Please sign the W-9.';
  return errors;
}

/**
 * Fetch the PDF library ahead of Submit. Called when the Payday page opens, so a
 * deploy while the recruit is filling in the W-9 cannot leave buildW9File asking
 * for a chunk that is no longer served. A failure here is ignored; buildW9File
 * tries again and reports its own error.
 */
export function preloadW9Pdf() {
  return import('jspdf').catch(() => {});
}

/**
 * Draw the signed W-9 as a letter-size PDF.
 *
 * @param {object} form  a complete form, shaped like EMPTY_W9 (check it with validateW9 first)
 * @returns {Promise<File>}  the PDF, named W9_<name>_<timestamp>.pdf
 */
export async function buildW9File(form) {
  const { signatureData, signatureMethod } = form;
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });

  const ML = 42;
  const PW = 612;
  const CW = PW - ML * 2;
  const today = new Date().toLocaleDateString('en-US');

  // ── HEADER ────────────────────────────────────────────────
  doc.setFillColor(220, 220, 220);
  doc.rect(ML, 20, CW, 2, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(0, 0, 0);
  doc.text('Form W-9', ML, 50);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  doc.text(`${W9_FORM_REVISION}  |  Department of the Treasury — Internal Revenue Service`, ML, 62);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(0, 0, 0);
  doc.text('Request for Taxpayer Identification Number and Certification', PW - ML, 45, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  doc.text('Give Form to the requester. Do not send to the IRS.', PW - ML, 60, { align: 'right' });

  doc.setDrawColor(180, 180, 180);
  doc.line(ML, 70, PW - ML, 70);

  // ── FIELDS ────────────────────────────────────────────────
  let y = 86;

  function box(lineNum, labelText, valueText, x, bY, bW, bH) {
    doc.setDrawColor(160, 160, 160);
    doc.rect(x, bY, bW, bH);
    doc.setFontSize(7);
    doc.setTextColor(90, 90, 90);
    doc.text(`${lineNum}  ${labelText}`, x + 3, bY + 10);
    doc.setFontSize(10.5);
    doc.setTextColor(0, 0, 0);
    if (valueText) doc.text(valueText, x + 5, bY + bH - 8, { maxWidth: bW - 10 });
  }

  // Line 1 – Name
  box('1', 'Name (as shown on your income tax return). Name is required on this line.', form.name, ML, y, CW, 30);
  y += 34;

  // Line 2 – Business name + exemptions (side by side)
  const bW = CW * 0.65;
  const eW = CW - bW - 5;
  box('2', 'Business name/disregarded entity name, if different from above', form.business_name, ML, y, bW, 30);
  box('4', 'Exemptions (exempt payee code, if any)', form.exempt_payee_code || '', ML + bW + 5, y, eW, 30);
  y += 34;

  // Line 3 – Tax classification
  box('3a', 'Check appropriate box for federal tax classification of the person whose name is entered on line 1.',
    form.tax_classification, ML, y, CW, 30);
  y += 34;

  // Line 5 – Address
  box('5', 'Address (number, street, and apt. or suite no.)', form.address, ML, y, CW, 30);
  y += 34;

  // Line 6 – City, State, ZIP
  const cityStateZip = [form.city, form.state, form.zip].filter(Boolean).join(', ');
  box('6', 'City, state, and ZIP code', cityStateZip, ML, y, CW, 30);
  y += 42;

  // ── PART I: TIN ───────────────────────────────────────────
  doc.setDrawColor(180, 180, 180);
  doc.line(ML, y - 6, PW - ML, y - 6);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(0, 0, 0);
  doc.text('Part I    Taxpayer Identification Number (TIN)', ML, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(80, 80, 80);
  y += 13;
  doc.text('Enter your TIN in the appropriate box. The TIN provided must match the name given on line 1.', ML, y, { maxWidth: CW });
  y += 20;

  if (!form.use_ein) {
    doc.setFontSize(9);
    doc.setTextColor(0, 0, 0);
    doc.text('Social security number:', ML, y + 15);
    const ssn = `${form.ssn1}  —  ${form.ssn2}  —  ${form.ssn3}`;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(ssn, ML + 140, y + 15);
    doc.setFont('helvetica', 'normal');
    doc.setDrawColor(160, 160, 160);
    doc.rect(ML + 135, y, 140, 24);
  } else {
    doc.setFontSize(9);
    doc.setTextColor(0, 0, 0);
    doc.text('Employer identification number (EIN):', ML, y + 15);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(form.ein, ML + 175, y + 15);
    doc.setFont('helvetica', 'normal');
    doc.setDrawColor(160, 160, 160);
    doc.rect(ML + 170, y, 130, 24);
  }
  y += 40;

  // ── PART II: CERTIFICATION ────────────────────────────────
  doc.setDrawColor(180, 180, 180);
  doc.line(ML, y - 6, PW - ML, y - 6);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(0, 0, 0);
  doc.text('Part II    Certification', ML, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(60, 60, 60);
  y += 13;

  const certText = [
    'Under penalties of perjury, I certify that:',
    '1. The number shown on this form is my correct taxpayer identification number (or I am waiting for a number to be issued to me); and',
    '2. I am not subject to backup withholding because: (a) I am exempt from backup withholding, or (b) I have not been notified by the Internal Revenue',
    '   Service (IRS) that I am subject to backup withholding as a result of a failure to report all interest or dividends, or (c) the IRS has notified me',
    '   that I am no longer subject to backup withholding; and',
    '3. I am a U.S. citizen or other U.S. person; and',
    '4. The FATCA code(s) entered on this form (if any) indicating that I am exempt from FATCA reporting is correct.',
  ];
  certText.forEach(line => {
    doc.text(line, ML, y, { maxWidth: CW });
    y += 10;
  });
  y += 8;

  // Signature line
  doc.setFontSize(9);
  doc.setTextColor(0, 0, 0);
  doc.text('Signature of U.S. person  ►', ML, y + 14);

  const sigBoxX = ML + 160;
  const sigBoxW = 220;
  const sigBoxH = 40;
  doc.setDrawColor(160, 160, 160);
  doc.rect(sigBoxX, y - 2, sigBoxW, sigBoxH);

  if (signatureMethod === 'draw') {
    try {
      doc.addImage(signatureData, 'PNG', sigBoxX + 3, y, sigBoxW - 6, sigBoxH - 8);
    } catch (imgErr) {
      doc.setFontSize(8);
      doc.setTextColor(100, 100, 100);
      doc.text('[Signature on file]', sigBoxX + 5, y + 20);
    }
  } else {
    // Typed signature — render the name in italic
    doc.setFont('helvetica', 'bolditalic');
    doc.setFontSize(16);
    doc.setTextColor(0, 0, 0);
    doc.text(signatureData, sigBoxX + 8, y + 24);
    doc.setFont('helvetica', 'normal');
  }

  // Date box
  doc.setFontSize(9);
  doc.setTextColor(0, 0, 0);
  doc.text('Date ►', sigBoxX + sigBoxW + 8, y + 14);
  doc.setDrawColor(160, 160, 160);
  doc.rect(sigBoxX + sigBoxW + 35, y - 2, 100, sigBoxH);
  doc.text(today, sigBoxX + sigBoxW + 38, y + 14);

  y += 50;

  // Footer
  doc.setDrawColor(180, 180, 180);
  doc.line(ML, y, PW - ML, y);
  y += 10;
  doc.setFontSize(7);
  doc.setTextColor(130, 130, 130);
  doc.text(
    `Printed name: ${form.name}   |   Generated via Dr. Bartender Onboarding System   |   ${today}`,
    ML, y
  );

  // Build File from blob
  const blob = doc.output('blob');
  const safeName = form.name.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
  const file = new File([blob], `W9_${safeName}_${Date.now()}.pdf`, { type: 'application/pdf' });
  return file;
}
