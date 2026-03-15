import React, { useState } from 'react';
import SignaturePad from './SignaturePad';

const TAX_CLASSIFICATIONS = [
  'Individual/sole proprietor or single-member LLC',
  'C Corporation',
  'S Corporation',
  'Partnership',
  'Trust/Estate',
  'LLC – C Corporation',
  'LLC – S Corporation',
  'LLC – Partnership',
  'Other',
];

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY',
];

export default function W9Form({ onComplete }) {
  const [form, setForm] = useState({
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
  });
  const [signatureData, setSignatureData] = useState('');
  const [error, setError] = useState('');
  const [sigError, setSigError] = useState('');
  const [generating, setGenerating] = useState(false);

  function handle(e) {
    const { name, value, type, checked } = e.target;
    setForm(f => ({ ...f, [name]: type === 'checkbox' ? checked : value }));
  }

  async function generate() {
    setError('');
    setSigError('');

    if (!form.name.trim()) return setError('Your legal name (as on tax return) is required.');
    if (!form.address.trim() || !form.city.trim() || !form.state || !form.zip.trim()) {
      return setError('Full address is required.');
    }
    if (!form.use_ein) {
      if (!form.ssn1 || !form.ssn2 || !form.ssn3) return setError('Social Security Number is required.');
      if (form.ssn1.length !== 3 || form.ssn2.length !== 2 || form.ssn3.length !== 4) {
        return setError('SSN must be in XXX-XX-XXXX format.');
      }
    } else {
      if (!form.ein.trim()) return setError('Employer Identification Number is required.');
    }
    if (!signatureData) {
      setSigError('Signature is required — please sign the form above.');
      return;
    }

    setGenerating(true);
    try {
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
      doc.text('Rev. March 2024  |  Department of the Treasury — Internal Revenue Service', ML, 62);

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
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(0, 0, 0);
      doc.text('Part I', ML, y);
      doc.setFontSize(10);
      doc.text('    Taxpayer Identification Number (TIN)', ML, y);

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

      try {
        doc.addImage(signatureData, 'PNG', sigBoxX + 3, y, sigBoxW - 6, sigBoxH - 8);
      } catch (imgErr) {
        doc.setFontSize(8);
        doc.setTextColor(100, 100, 100);
        doc.text('[Signature on file]', sigBoxX + 5, y + 20);
      }

      // Date box
      doc.setFontSize(9);
      doc.setTextColor(0, 0, 0);
      doc.text('Date ►', sigBoxX + sigBoxW + 8, y + 14);
      doc.setDrawColor(160, 160, 160);
      doc.rect(sigBoxX + sigBoxW + 35, y - 2, 100, 24);
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
      onComplete(file);
    } catch (err) {
      console.error('W9 PDF generation error:', err);
      setError('Failed to generate PDF. Please try again.');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div style={{ border: '2px solid var(--border-dark)', borderRadius: 'var(--radius-lg)', padding: '1.5rem', background: 'var(--card-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem', paddingBottom: '0.75rem', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: '1.75rem' }}>📋</div>
        <div>
          <h4 style={{ margin: 0, color: 'var(--deep-brown)' }}>Form W-9 — Fill Out Online</h4>
          <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>Filled out here, signed below, and a PDF will be generated automatically.</p>
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {/* Line 1: Name */}
      <div className="form-group">
        <label className="form-label">1. Name as shown on your income tax return *</label>
        <input name="name" className="form-input" value={form.name} onChange={handle} placeholder="Your full legal name" />
      </div>

      {/* Line 2: Business name */}
      <div className="form-group">
        <label className="form-label">2. Business name / DBA (if different from above)</label>
        <input name="business_name" className="form-input" value={form.business_name} onChange={handle} placeholder="Leave blank if same as above" />
      </div>

      {/* Line 3: Tax classification */}
      <div className="form-group">
        <label className="form-label">3. Federal tax classification *</label>
        <select name="tax_classification" className="form-select" value={form.tax_classification} onChange={handle}>
          {TAX_CLASSIFICATIONS.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Address */}
      <div className="form-group">
        <label className="form-label">5. Street Address *</label>
        <input name="address" className="form-input" value={form.address} onChange={handle} placeholder="123 Main St, Apt 4B" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '0.75rem' }}>
        <div className="form-group">
          <label className="form-label">City *</label>
          <input name="city" className="form-input" value={form.city} onChange={handle} />
        </div>
        <div className="form-group">
          <label className="form-label">State *</label>
          <select name="state" className="form-select" value={form.state} onChange={handle}>
            <option value="">—</option>
            {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">ZIP *</label>
          <input name="zip" className="form-input" value={form.zip} onChange={handle} placeholder="60601" maxLength={10} />
        </div>
      </div>

      {/* Part I: TIN */}
      <div className="form-group">
        <label className="form-label">Part I — Taxpayer Identification Number *</label>
        <label className="checkbox-group" style={{ marginBottom: '0.75rem' }}>
          <input type="checkbox" name="use_ein" checked={form.use_ein} onChange={handle} />
          <span className="checkbox-label">I use an EIN (business) instead of SSN (personal)</span>
        </label>

        {!form.use_ein ? (
          <div>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--warm-brown)', marginBottom: '0.5rem' }}>
              Social Security Number
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                name="ssn1" className="form-input" value={form.ssn1} onChange={handle}
                maxLength={3} placeholder="XXX" inputMode="numeric"
                style={{ width: 72, textAlign: 'center', letterSpacing: '0.25em', fontFamily: 'monospace', fontSize: '1rem' }}
              />
              <span style={{ color: 'var(--warm-brown)', fontWeight: 700, fontSize: '1.1rem' }}>—</span>
              <input
                name="ssn2" className="form-input" value={form.ssn2} onChange={handle}
                maxLength={2} placeholder="XX" inputMode="numeric"
                style={{ width: 56, textAlign: 'center', letterSpacing: '0.25em', fontFamily: 'monospace', fontSize: '1rem' }}
              />
              <span style={{ color: 'var(--warm-brown)', fontWeight: 700, fontSize: '1.1rem' }}>—</span>
              <input
                name="ssn3" className="form-input" value={form.ssn3} onChange={handle}
                maxLength={4} placeholder="XXXX" inputMode="numeric"
                style={{ width: 80, textAlign: 'center', letterSpacing: '0.25em', fontFamily: 'monospace', fontSize: '1rem' }}
              />
            </div>
            <p className="form-helper">Format: XXX-XX-XXXX. Transmitted securely and used only for tax/payment purposes.</p>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--warm-brown)', marginBottom: '0.5rem' }}>
              Employer Identification Number (EIN)
            </div>
            <input
              name="ein" className="form-input" value={form.ein} onChange={handle}
              placeholder="XX-XXXXXXX" inputMode="numeric"
              style={{ maxWidth: 220, fontFamily: 'monospace', letterSpacing: '0.15em' }}
            />
          </div>
        )}
      </div>

      {/* Part II: Certification */}
      <div className="form-group">
        <label className="form-label">Part II — Certification & Signature *</label>
        <div style={{
          background: '#FFFDF5', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: '0.85rem', marginBottom: '0.75rem',
          fontSize: '0.8rem', color: 'var(--deep-brown)', lineHeight: 1.6
        }}>
          Under penalties of perjury, I certify that: <strong>(1)</strong> The number shown on this form is my correct taxpayer identification number;{' '}
          <strong>(2)</strong> I am not subject to backup withholding;{' '}
          <strong>(3)</strong> I am a U.S. citizen or other U.S. person;{' '}
          <strong>(4)</strong> The FATCA code(s) entered on this form (if any) are correct.
        </div>
        <p style={{ fontSize: '0.8rem', color: 'var(--warm-brown)', fontWeight: 600, marginBottom: '0.4rem' }}>
          Sign below with your mouse or finger:
        </p>
        <SignaturePad onChange={setSignatureData} value={signatureData} />
        {sigError && <p style={{ color: 'var(--error)', fontSize: '0.8rem', marginTop: '0.35rem' }}>{sigError}</p>}
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
          Date: <strong>{new Date().toLocaleDateString()}</strong>
        </p>
      </div>

      <button
        type="button"
        className="btn btn-primary btn-full"
        onClick={generate}
        disabled={generating}
        style={{ marginTop: '0.5rem' }}
      >
        {generating ? '⏳ Generating PDF…' : '✓ Generate & Sign W-9'}
      </button>
    </div>
  );
}
