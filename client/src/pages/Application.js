import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import FileUpload from '../components/FileUpload';
import BrandLogo from '../components/BrandLogo';
import api from '../utils/api';
import { formatPhoneInput, stripPhone } from '../utils/formatPhone';

const FUN_COLORS = [
  { hex: '#ff0000', name: 'Cherry Red' },
  { hex: '#dc143c', name: 'Crimson Crush' },
  { hex: '#ff4500', name: 'Blaze Orange' },
  { hex: '#ff6347', name: 'Tomato Tango' },
  { hex: '#ff8c00', name: 'Sunset Orange' },
  { hex: '#ffa500', name: 'Tangerine Dream' },
  { hex: '#ffd700', name: 'Golden Hour' },
  { hex: '#ffff00', name: 'Electric Lemon' },
  { hex: '#adff2f', name: 'Lime Zest' },
  { hex: '#32cd32', name: 'Lucky Clover' },
  { hex: '#00ff00', name: 'Neon Green' },
  { hex: '#2e8b57', name: 'Emerald Isle' },
  { hex: '#008080', name: 'Teal Vibe' },
  { hex: '#00ced1', name: 'Turquoise Splash' },
  { hex: '#00bfff', name: 'Electric Blue' },
  { hex: '#1e90ff', name: 'Dodger Blue' },
  { hex: '#0000ff', name: 'Bold Blue' },
  { hex: '#4b0082', name: 'Midnight Indigo' },
  { hex: '#7c3aed', name: 'Royal Purple' },
  { hex: '#9370db', name: 'Lavender Haze' },
  { hex: '#ff69b4', name: 'Hot Pink' },
  { hex: '#ff1493', name: 'Flamingo Pink' },
  { hex: '#c71585', name: 'Berry Blast' },
  { hex: '#8b4513', name: 'Saddle Brown' },
  { hex: '#d2691e', name: 'Cinnamon Spice' },
  { hex: '#000000', name: 'Midnight Black' },
  { hex: '#708090', name: 'Stormy Gray' },
  { hex: '#ffffff', name: 'Snowflake White' },
  { hex: '#ffc0cb', name: 'Bubblegum Pink' },
  { hex: '#f0e68c', name: 'Buttery Yellow' },
];

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

function nearestColorName(hex) {
  const [r, g, b] = hexToRgb(hex);
  let best = FUN_COLORS[0];
  let bestDist = Infinity;
  for (const c of FUN_COLORS) {
    const [cr, cg, cb] = hexToRgb(c.hex);
    const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  return best;
}

const STATES = ['Illinois', 'Indiana', 'Michigan', 'Minnesota', 'Wisconsin'];
const TRAVEL_OPTIONS = ['Up to 25 miles', 'Up to 50 miles', 'Up to 100 miles', 'More than 100 miles'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const EXPERIENCE_TYPES = ['Weddings', 'Corporate Events', 'Private Parties', 'Festivals', 'Clubs', 'Dive Bars', 'High-End Bars/Restaurants', 'Casual Bars/Restaurants'];
const POSITIONS = ['Bartender', 'Barback', 'Banquet Server'];
const BAR_TOOLS = [
  { name: 'tools_none_will_start', label: "No, I don't have any tools, but I will start a kit if I get hired on" },
  { name: 'tools_mixing_tins', label: 'Mixing tins / Boston shaker' },
  { name: 'tools_strainer', label: 'Strainer' },
  { name: 'tools_ice_scoop', label: 'Ice Scoop' },
  { name: 'tools_bar_spoon', label: 'Bar Spoon' },
  { name: 'tools_tongs', label: 'Tongs' },
  { name: 'tools_ice_bin', label: 'Clean ice bin' },
  { name: 'tools_bar_mats', label: 'Bar mats' },
  { name: 'tools_bar_towels', label: 'Bar towels' },
];
const EQUIPMENT = [
  { name: 'equipment_none_but_open', label: "No, but I wouldn't mind having some of this stuff." },
  { name: 'equipment_no_space', label: "No. I don't have space for it." },
  { name: 'equipment_portable_bar', label: 'Portable Bar' },
  { name: 'equipment_cooler', label: 'Cooler for storing ice & beer' },
  { name: 'equipment_table_with_spandex', label: '6ft folding table w/ spandex table cloth' },
];

export default function Application() {
  const navigate = useNavigate();
  const { user, login, logout } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [files, setFiles] = useState({ resume: null, headshot: null, basset: null });
  const [colorHex, setColorHex] = useState('#7c3aed');

  const [form, setForm] = useState({
    full_name: '', phone: '', favorite_color: 'Royal Purple',
    street_address: '', city: '', state: '', zip_code: '',
    birth_month: '', birth_day: '', birth_year: '',
    travel_distance: '', reliable_transportation: '',
    has_bartending_experience: '', bartending_experience_description: '',
    last_bartending_time: '', bartending_years: '', experience_types_other: '',
    available_saturdays: '', other_commitments: '',
    setup_confidence: '', comfortable_working_alone: '',
    customer_service_approach: '', why_dr_bartender: '', additional_info: '',
    emergency_contact_name: '', emergency_contact_phone: '', emergency_contact_relationship: '',
  });

  const [positions, setPositions] = useState({ Bartender: false, Barback: false, 'Banquet Server': false });
  const [experienceTypes, setExperienceTypes] = useState({});
  const [tools, setTools] = useState({});
  const [equipment, setEquipment] = useState({});

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

    // Validation
    if (!form.full_name || !form.phone || !form.city || !form.state) {
      return setError('Please fill in all required fields in Basic Information.');
    }
    if (!form.birth_month || !form.birth_day || !form.birth_year) {
      return setError('Date of birth is required.');
    }

    // Age check (21+)
    const today = new Date();
    const birthDate = new Date(form.birth_year, form.birth_month - 1, form.birth_day);
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) age--;
    if (age < 21) return setError('You must be at least 21 years old to apply.');

    if (!form.travel_distance) return setError('Please select your travel distance.');
    if (!form.reliable_transportation) return setError('Please select a transportation option.');

    const selectedPositions = Object.keys(positions).filter(k => positions[k]);
    if (selectedPositions.length === 0) return setError('Please select at least one position you\'re interested in.');

    if (!form.why_dr_bartender) return setError('Please tell us why you want to work with Dr. Bartender.');
    if (!files.resume) return setError('Please upload your resume.');
    if (!files.basset) return setError('Please upload your BASSET / alcohol certification.');

    setLoading(true);
    try {
      const data = new FormData();

      // Simple fields
      Object.entries(form).forEach(([k, v]) => {
        if (k !== 'experience_types_other') data.append(k, v);
      });

      // Positions as JSON
      data.append('positions_interested', JSON.stringify(selectedPositions));

      // Experience types as JSON
      const expTypes = Object.keys(experienceTypes).filter(k => experienceTypes[k]);
      if (form.experience_types_other) expTypes.push(form.experience_types_other);
      data.append('experience_types', JSON.stringify(expTypes));

      // Tools
      BAR_TOOLS.forEach(t => data.append(t.name, tools[t.name] || false));

      // Equipment
      EQUIPMENT.forEach(eq => data.append(eq.name, equipment[eq.name] || false));

      // Files
      if (files.resume) data.append('resume', files.resume);
      if (files.headshot) data.append('headshot', files.headshot);
      if (files.basset) data.append('basset', files.basset);

      await api.post('/application', data);

      // Update local user state to reflect new status
      const meRes = await api.get('/auth/me');
      login(localStorage.getItem('token'), meRes.data.user);

      navigate('/application-status');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to submit application.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page" style={{ minHeight: '100vh' }}>
      <header className="site-header">
        <BrandLogo />
        <div className="header-actions">
          <span className="header-user">{user?.email}</span>
          <button className="btn btn-secondary btn-sm" onClick={() => { logout(); navigate('/login'); }}>Sign Out</button>
        </div>
      </header>

      <div className="page-container" style={{ maxWidth: 720 }}>
        <div className="text-center mb-3">
          <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>⚗️</div>
          <h1 style={{ marginBottom: '0.25rem' }}>Dr. Bartender Job Application</h1>
          <p className="text-muted italic">
            Thanks for applying! The next few sections will help us get to know you.
            No wrong answers — just be honest and yourself.
          </p>
        </div>

        {error && <div className="alert alert-error" role="alert">{error}</div>}

        <form onSubmit={submit}>
          {/* ── Section 1: Basic Information ── */}
          <div className="card">
            <h3 style={{ marginBottom: '0.5rem' }}>Basic Information</h3>
            <p className="text-muted text-small" style={{ marginBottom: '1.25rem' }}>
              Let's start with the basics — contact info and location.
            </p>

            <div className="two-col">
              <div className="form-group">
                <label className="form-label">Full Name *</label>
                <input name="full_name" className="form-input" value={form.full_name} onChange={handle} placeholder="First and last name" required />
              </div>
              <div className="form-group">
                <label className="form-label">Phone Number *</label>
                <input name="phone" type="tel" className="form-input" value={formatPhoneInput(form.phone)} onChange={e => setForm(f => ({ ...f, phone: stripPhone(e.target.value) }))} placeholder="(555) 000-0000" required />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Favorite Color *</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <input
                  type="color"
                  value={colorHex}
                  onChange={e => {
                    const hex = e.target.value;
                    setColorHex(hex);
                    const match = nearestColorName(hex);
                    setForm(f => ({ ...f, favorite_color: match.name }));
                  }}
                  style={{ width: 48, height: 40, border: '2px solid var(--border-dark)', borderRadius: 'var(--radius)', cursor: 'pointer', padding: 2 }}
                />
                <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>{form.favorite_color}</span>
              </div>
            </div>

            <h4 style={{ marginBottom: '0.75rem', marginTop: '0.5rem' }}>Date of Birth *</h4>
            <p className="text-muted text-small" style={{ marginBottom: '0.75rem' }}>You must be 21 or older to work with Dr. Bartender.</p>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.5fr', gap: '0.75rem' }}>
              <div className="form-group">
                <label className="form-label">Month</label>
                <select name="birth_month" className="form-select" value={form.birth_month} onChange={handle} required>
                  <option value="">Month</option>
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Day</label>
                <input name="birth_day" type="number" className="form-input" value={form.birth_day} onChange={handle} placeholder="DD" min="1" max="31" required />
              </div>
              <div className="form-group">
                <label className="form-label">Year</label>
                <input name="birth_year" type="number" className="form-input" value={form.birth_year} onChange={handle} placeholder="YYYY" min="1940" max="2010" required />
              </div>
            </div>
          </div>

          {/* ── Section 2: Location & Travel ── */}
          <div className="card">
            <h3 style={{ marginBottom: '0.5rem' }}>Location & Travel</h3>
            <p className="text-muted text-small" style={{ marginBottom: '1.25rem' }}>
              Where you're based and how far you're willing to go.
            </p>

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
                  {STATES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Zip Code</label>
                <input name="zip_code" className="form-input" value={form.zip_code} onChange={handle} placeholder="60601" />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">How far are you willing to travel for events? *</label>
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
              <label className="form-label">Do you have reliable transportation? *</label>
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

          {/* ── Section 3: Experience ── */}
          <div className="card">
            <h3 style={{ marginBottom: '0.5rem' }}>Experience</h3>
            <p className="text-muted text-small" style={{ marginBottom: '1.25rem' }}>
              Whether you've worked as a Bartender, Barback, or Banquet Server, we'd love to hear about your experience.
              We're open to bringing on the right people, even if they're still learning the ropes.
            </p>

            <div className="form-group">
              <label className="form-label">Which position(s) are you interested in? *</label>
              <p className="form-helper">Please only select jobs that you are qualified for and are willing to work.</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {POSITIONS.map(pos => (
                  <label key={pos} className="checkbox-group">
                    <input type="checkbox" checked={positions[pos] || false}
                      onChange={e => setPositions(p => ({ ...p, [pos]: e.target.checked }))} />
                    <span className="checkbox-label">{pos}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="form-group" style={{ marginTop: '0.75rem' }}>
              <label className="form-label">Do you have previous bartending experience? *</label>
              <div className="radio-group" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {['Yes', 'No'].map(opt => (
                  <label key={opt} className={`radio-option ${form.has_bartending_experience === opt ? 'selected' : ''}`} style={{ flex: 1 }}>
                    <input type="radio" name="has_bartending_experience" value={opt} checked={form.has_bartending_experience === opt} onChange={handle} />
                    <span className="radio-label">{opt}</span>
                  </label>
                ))}
              </div>
            </div>

            {form.has_bartending_experience === 'Yes' && (
              <>
                <div className="form-group">
                  <label className="form-label">How many years of bartending experience do you have?</label>
                  <div className="radio-group">
                    {['Less than 1 year', '1–2 years', '3–5 years', '6–10 years', '10+ years'].map(opt => (
                      <label key={opt} className={`radio-option ${form.bartending_years === opt ? 'selected' : ''}`}>
                        <input type="radio" name="bartending_years" value={opt} checked={form.bartending_years === opt} onChange={handle} />
                        <span className="radio-label">{opt}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Please briefly describe your bartending experience.</label>
                  <textarea name="bartending_experience_description" className="form-input" rows={3}
                    value={form.bartending_experience_description} onChange={handle}
                    placeholder="Types of events, venues, years of experience..." />
                </div>

                <div className="form-group">
                  <label className="form-label">When was the last time you worked as a bartender?</label>
                  <div className="radio-group">
                    {['Within the last year', '1-3 years ago', 'More than 3 years ago'].map(opt => (
                      <label key={opt} className={`radio-option ${form.last_bartending_time === opt ? 'selected' : ''}`}>
                        <input type="radio" name="last_bartending_time" value={opt} checked={form.last_bartending_time === opt} onChange={handle} />
                        <span className="radio-label">{opt}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">What types of bartending experience do you have?</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {EXPERIENCE_TYPES.map(type => (
                      <label key={type} className="checkbox-group">
                        <input type="checkbox" checked={experienceTypes[type] || false}
                          onChange={e => setExperienceTypes(t => ({ ...t, [type]: e.target.checked }))} />
                        <span className="checkbox-label">{type}</span>
                      </label>
                    ))}
                    <div className="form-group" style={{ marginTop: '0.25rem', marginBottom: 0 }}>
                      <input className="form-input" placeholder="Other (specify)" value={form.experience_types_other} name="experience_types_other" onChange={handle} />
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* ── Section 4: Availability ── */}
          <div className="card">
            <h3 style={{ marginBottom: '0.5rem' }}>Availability</h3>
            <p className="text-muted text-small" style={{ marginBottom: '1.25rem' }}>
              This is generally a part-time, on-call position with most events happening on weekends.
              Let us know your typical availability and any regular commitments.
            </p>

            <div className="form-group">
              <label className="form-label">Are you available to work most Saturdays? *</label>
              <div className="radio-group" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {['Yes', 'No', 'Maybe'].map(opt => (
                  <label key={opt} className={`radio-option ${form.available_saturdays === opt ? 'selected' : ''}`} style={{ flex: 1 }}>
                    <input type="radio" name="available_saturdays" value={opt} checked={form.available_saturdays === opt} onChange={handle} />
                    <span className="radio-label">{opt}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Do you have any other commitments that may affect your availability?</label>
              <input name="other_commitments" className="form-input" value={form.other_commitments} onChange={handle}
                placeholder="e.g. another part-time job, school, etc." />
            </div>
          </div>

          {/* ── Section 5: Tools & Equipment ── */}
          <div className="card">
            <h3 style={{ marginBottom: '0.5rem' }}>Tools and Equipment</h3>
            <p className="text-muted text-small" style={{ marginBottom: '1.25rem' }}>
              Quick check on what tools and gear you've got.
            </p>

            <div className="form-group">
              <label className="form-label">Do you have your own bar tools? *</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {BAR_TOOLS.map(item => (
                  <label key={item.name} className="checkbox-group">
                    <input type="checkbox" checked={tools[item.name] || false}
                      onChange={e => setTools(t => ({ ...t, [item.name]: e.target.checked }))} />
                    <span className="checkbox-label">{item.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="form-group" style={{ marginTop: '1.25rem' }}>
              <label className="form-label">Do you have your own equipment?</label>
              <p className="form-helper">
                Staff with equipment may be prioritized for certain events, but don't worry — there will be plenty of gigs where equipment is provided or not needed at all.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {EQUIPMENT.map(item => (
                  <label key={item.name} className="checkbox-group">
                    <input type="checkbox" checked={equipment[item.name] || false}
                      onChange={e => setEquipment(eq => ({ ...eq, [item.name]: e.target.checked }))} />
                    <span className="checkbox-label">{item.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* ── Section 6: Skills & Attributes ── */}
          <div className="card">
            <h3 style={{ marginBottom: '0.5rem' }}>Skills and Attributes</h3>
            <p className="text-muted text-small" style={{ marginBottom: '1.25rem' }}>
              A few questions to get a feel for your confidence, independence, and how you handle different event scenarios.
            </p>

            <div className="form-group">
              <label className="form-label">How confident are you in handling a bar setup on your own? *</label>
              <p className="form-helper">This often includes assembling a portable bar.</p>
              <div style={{ padding: '0.5rem 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>😬 Meh / Not Sure</span>
                  <span style={{ fontWeight: 700, color: 'var(--amber)', fontSize: '1rem' }}>
                    {form.setup_confidence ? `${form.setup_confidence} / 5` : '—'}
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>💪 No Sweat</span>
                </div>
                <input
                  type="range"
                  name="setup_confidence"
                  min="1" max="5" step="1"
                  value={form.setup_confidence || 3}
                  onChange={handle}
                  className="confidence-slider"
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                  {[1, 2, 3, 4, 5].map(n => <span key={n}>{n}</span>)}
                </div>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Are you comfortable working alone or as the sole representative of Dr. Bartender at events?</label>
              <div className="radio-group" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {['Yes', 'No', 'Maybe'].map(opt => (
                  <label key={opt} className={`radio-option ${form.comfortable_working_alone === opt ? 'selected' : ''}`} style={{ flex: 1 }}>
                    <input type="radio" name="comfortable_working_alone" value={opt} checked={form.comfortable_working_alone === opt} onChange={handle} />
                    <span className="radio-label">{opt}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">How would you describe your approach to customer service?</label>
              <textarea name="customer_service_approach" className="form-input" rows={3}
                value={form.customer_service_approach} onChange={handle}
                placeholder="What makes you great with guests?" />
            </div>
          </div>

          {/* ── Section 7: Additional Info + Files ── */}
          <div className="card">
            <h3 style={{ marginBottom: '0.5rem' }}>Additional Information</h3>
            <p className="text-muted text-small" style={{ marginBottom: '1.25rem' }}>
              Last few questions, plus your resume, headshot, and BASSET certification.
            </p>

            <div className="form-group">
              <label className="form-label">Why do you want to work with Dr. Bartender? *</label>
              <textarea name="why_dr_bartender" className="form-input" rows={3}
                value={form.why_dr_bartender} onChange={handle} required
                placeholder="Tell us what drew you to apply..." />
            </div>

            <div className="form-group">
              <label className="form-label">Is there anything else you'd like us to know about you?</label>
              <textarea name="additional_info" className="form-input" rows={3}
                value={form.additional_info} onChange={handle}
                placeholder="Anything else we should know..." />
            </div>

            <FileUpload
              label="Upload Your Resume *"
              name="resume"
              helper="PDF, JPEG, or PNG accepted."
              onChange={handleFile}
              currentFile={files.resume}
            />

            <FileUpload
              label="Upload a Headshot"
              name="headshot"
              accept=".jpg,.jpeg,.png"
              helper="A professional-looking photo helps us recognize you at events."
              onChange={handleFile}
              currentFile={files.headshot}
              camera={true}
            />

            <FileUpload
              label="Upload Your BASSET / Alcohol Certification *"
              name="basset"
              helper="BASSET, TIPS, ServSafe, or equivalent. Required for all positions."
              onChange={handleFile}
              currentFile={files.basset}
            />
          </div>

          {/* ── Section 8: Emergency Contact ── */}
          <div className="card">
            <h3 style={{ marginBottom: '0.5rem' }}>Emergency Contact</h3>
            <p className="text-muted text-small" style={{ marginBottom: '1.25rem' }}>
              Someone we can reach in case of an emergency during an event.
            </p>

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

          {/* ── Submit ── */}
          <div className="card" style={{ textAlign: 'center' }}>
            <p className="text-muted italic" style={{ marginBottom: '1rem' }}>
              By submitting this application, you confirm that all information provided is accurate.
            </p>
            <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
              {loading ? 'Submitting Application...' : 'Submit Application'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
