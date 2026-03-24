import React, { useState, useEffect } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import FileUpload from '../components/FileUpload';
import api from '../utils/api';
import { formatPhoneInput, stripPhone } from '../utils/formatPhone';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const STATES = ['Illinois','Indiana','Michigan','Minnesota','Wisconsin','AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
const TRAVEL_OPTIONS = ['Up to 25 miles', 'Up to 50 miles', 'Up to 100 miles', 'More than 100 miles'];

export default function ContractorProfile() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { setProgress } = useOutletContext();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [fromApplication, setFromApplication] = useState(false);
  const [files, setFiles] = useState({ alcohol_certification: null, resume: null, headshot: null });
  const [existingFiles, setExistingFiles] = useState({});

  const [form, setForm] = useState({
    preferred_name: '', phone: '', email: user?.email || '',
    birth_month: '', birth_day: '', birth_year: '',
    street_address: '', city: '', state: '', zip_code: '',
    travel_distance: '', reliable_transportation: '',
    equipment_portable_bar: false, equipment_cooler: false,
    equipment_table_with_spandex: false, equipment_none_but_open: false, equipment_no_space: false,
    equipment_will_pickup: false,
    emergency_contact_name: '', emergency_contact_phone: '', emergency_contact_relationship: '',
  });

  useEffect(() => {
    api.get('/contractor').then(r => {
      const d = r.data;
      if (d._from_application || d.preferred_name) {
        if (d._from_application) setFromApplication(true);
        setForm({
          preferred_name: d.preferred_name || '',
          phone: d.phone || '',
          email: d.email || user?.email || '',
          birth_month: d.birth_month || '',
          birth_day: d.birth_day || '',
          birth_year: d.birth_year || '',
          street_address: d.street_address || '',
          city: d.city || '',
          state: d.state || '',
          zip_code: d.zip_code || '',
          travel_distance: d.travel_distance || '',
          reliable_transportation: d.reliable_transportation || '',
          equipment_portable_bar: d.equipment_portable_bar || false,
          equipment_cooler: d.equipment_cooler || false,
          equipment_table_with_spandex: d.equipment_table_with_spandex || false,
          equipment_none_but_open: d.equipment_none_but_open || false,
          equipment_no_space: d.equipment_no_space || false,
          equipment_will_pickup: d.equipment_will_pickup || false,
          emergency_contact_name: d.emergency_contact_name || '',
          emergency_contact_phone: d.emergency_contact_phone || '',
          emergency_contact_relationship: d.emergency_contact_relationship || '',
        });
        setExistingFiles({
          alcohol_certification: d.alcohol_certification_filename,
          resume: d.resume_filename,
          headshot: d.headshot_filename,
        });
      }
    }).catch(() => setLoadError("We couldn't load your saved profile. You can still fill out the form below."));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handle(e) {
    const { name, value, type, checked } = e.target;
    setForm(f => ({ ...f, [name]: type === 'checkbox' ? checked : value }));
  }

  function handleFile(name, file) {
    setFiles(f => ({ ...f, [name]: file }));
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!form.preferred_name || !form.phone || !form.city || !form.state) {
      return setError('Please fill in all required fields.');
    }

    setLoading(true);
    try {
      const data = new FormData();
      Object.entries(form).forEach(([k, v]) => data.append(k, v));
      if (files.alcohol_certification) data.append('alcohol_certification', files.alcohol_certification);
      if (files.resume) data.append('resume', files.resume);
      if (files.headshot) data.append('headshot', files.headshot);

      await api.post('/contractor', data);
      const r = await api.put('/progress/step', { step: 'contractor_profile_completed' });
      setProgress(r.data);
      navigate('/payday-protocols');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to save profile.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-container">
      <div className="text-center mb-3">
        <div className="section-label">Step 4 of 6</div>
        <h1>Contractor Profile</h1>
        <p className="text-muted italic">
          Review and confirm your info. {fromApplication ? 'We\'ve pre-filled this from your application — just make sure everything looks good.' : 'This form helps us set up your profile, get you paid, and match you with the right gigs.'}
        </p>
      </div>

      {fromApplication && (
        <div className="alert alert-info">
          This info was pre-filled from your application. Review it, make any changes, and continue.
        </div>
      )}

      {loadError && <div className="alert alert-info">{loadError}</div>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}

      <form onSubmit={submit}>
        <div className="card">
          <h3 style={{ marginBottom: '1.25rem' }}>Personal Info</h3>
          <div className="two-col">
            <div className="form-group">
              <label className="form-label">Preferred Name *</label>
              <input name="preferred_name" className="form-input" value={form.preferred_name} onChange={handle} required />
            </div>
            <div className="form-group">
              <label className="form-label">Phone *</label>
              <input name="phone" type="tel" className="form-input" value={formatPhoneInput(form.phone)} onChange={e => setForm(f => ({ ...f, phone: stripPhone(e.target.value) }))} required placeholder="(555) 000-0000" />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input name="email" type="email" className="form-input" value={form.email} onChange={handle} />
          </div>

          <h4 style={{ marginBottom: '0.75rem', marginTop: '0.5rem' }}>Birthday</h4>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.5fr', gap: '0.75rem' }}>
            <div className="form-group">
              <label className="form-label">Month</label>
              <select name="birth_month" className="form-select" value={form.birth_month} onChange={handle}>
                <option value="">Month</option>
                {MONTHS.map((m, i) => <option key={m} value={i+1}>{m}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Day</label>
              <input name="birth_day" type="number" className="form-input" value={form.birth_day} onChange={handle} placeholder="DD" min="1" max="31" />
            </div>
            <div className="form-group">
              <label className="form-label">Year</label>
              <input name="birth_year" type="number" className="form-input" value={form.birth_year} onChange={handle} placeholder="YYYY" min="1940" max="2006" />
            </div>
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: '1.25rem' }}>Address & Travel</h3>
          <div className="form-group">
            <label className="form-label">Street Address</label>
            <input name="street_address" className="form-input" value={form.street_address} onChange={handle} placeholder="123 Main St, Apt 4" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.5fr 1fr', gap: '0.75rem' }}>
            <div className="form-group">
              <label className="form-label">City *</label>
              <input name="city" className="form-input" value={form.city} onChange={handle} required />
            </div>
            <div className="form-group">
              <label className="form-label">State *</label>
              <select name="state" className="form-select" value={form.state} onChange={handle} required>
                <option value="">Select state</option>
                {[...new Set(STATES)].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Zip Code</label>
              <input name="zip_code" className="form-input" value={form.zip_code} onChange={handle} placeholder="60601" />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">How far are you willing to travel for events?</label>
            <div className="radio-group">
              {TRAVEL_OPTIONS.map(opt => (
                <label key={opt} className={`radio-option ${form.travel_distance === opt ? 'selected' : ''}`}>
                  <input type="radio" name="travel_distance" value={opt} checked={form.travel_distance === opt} onChange={handle} />
                  <span className="radio-label">{opt}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Do you have reliable transportation?</label>
            <div className="radio-group" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {['Yes', 'No', 'Maybe'].map(opt => (
                <label key={opt} className={`radio-option ${form.reliable_transportation === opt ? 'selected' : ''}`} style={{ flex: 1 }}>
                  <input type="radio" name="reliable_transportation" value={opt} checked={form.reliable_transportation === opt} onChange={handle} />
                  <span className="radio-label">{opt}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: '1.25rem' }}>Equipment</h3>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Do you have your own equipment?
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
            {[
              { name: 'equipment_portable_bar', label: 'Portable Bar' },
              { name: 'equipment_cooler', label: 'Cooler for storing ice & beer' },
              { name: 'equipment_table_with_spandex', label: '6 ft folding table w/spandex table cloth' },
              { name: 'equipment_none_but_open', label: "No, but I wouldn't mind having some of this stuff." },
              { name: 'equipment_no_space', label: "No, I don't have space for it." },
            ].map(item => (
              <label key={item.name} className="checkbox-group">
                <input type="checkbox" name={item.name} checked={form[item.name]} onChange={handle} />
                <span className="checkbox-label">{item.label}</span>
              </label>
            ))}
          </div>
          <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
            <label className="checkbox-group">
              <input type="checkbox" name="equipment_will_pickup" checked={form.equipment_will_pickup} onChange={handle} />
              <span className="checkbox-label">I'm willing to pick up equipment from the storage unit before events</span>
            </label>
          </div>
          <p className="text-small text-muted italic" style={{ marginTop: '0.75rem' }}>
            Staff with equipment or willing to pick up may be prioritized for certain events, but there will be plenty of gigs where equipment is provided or not needed.
          </p>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: '1.25rem' }}>Emergency Contact</h3>
          <div className="two-col">
            <div className="form-group">
              <label className="form-label">Contact Name</label>
              <input name="emergency_contact_name" className="form-input" value={form.emergency_contact_name} onChange={handle} />
            </div>
            <div className="form-group">
              <label className="form-label">Contact Phone</label>
              <input name="emergency_contact_phone" type="tel" className="form-input" value={formatPhoneInput(form.emergency_contact_phone)} onChange={e => setForm(f => ({ ...f, emergency_contact_phone: stripPhone(e.target.value) }))} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Relationship</label>
            <input name="emergency_contact_relationship" className="form-input" value={form.emergency_contact_relationship} onChange={handle} placeholder="e.g. Parent, Spouse, Friend" />
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: '1.25rem' }}>Documents</h3>
          <FileUpload
            label="BASSET / Alcohol Certification"
            name="alcohol_certification"
            helper="BASSET, TIPS, ServSafe, etc. Required for events serving alcohol."
            onChange={handleFile}
            currentFile={files.alcohol_certification || existingFiles.alcohol_certification}
          />
          <FileUpload
            label="Resume (Optional)"
            name="resume"
            helper="Totally optional, but if you upload it we'll take a look at it."
            onChange={handleFile}
            currentFile={files.resume || existingFiles.resume}
          />
          <FileUpload
            label="Headshot"
            name="headshot"
            accept=".jpg,.jpeg,.png"
            helper="A professional photo helps us recognize you at events."
            onChange={handleFile}
            currentFile={files.headshot || existingFiles.headshot}
            camera={true}
          />
        </div>

        <div className="flex gap-2" style={{ justifyContent: 'space-between' }}>
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/agreement')}>
            ← Back
          </button>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Saving...' : 'Next: Payday Protocols →'}
          </button>
        </div>
      </form>
    </div>
  );
}
