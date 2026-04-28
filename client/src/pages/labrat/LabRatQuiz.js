import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './labrat.css';

const AREA_OPTIONS = [
  { id: 'customer',  label: 'Booking an event as a customer' },
  { id: 'applicant', label: 'Applying to be a bartender' },
  { id: 'admin',     label: 'Poking around the admin tools' },
  { id: 'mobile',    label: 'Mobile testing on my phone' },
  { id: 'surprise',  label: 'Surprise me / whatever needs help most' },
];
const TIME_OPTIONS = [
  { value: 5,   label: 'Just a few minutes' },
  { value: 20,  label: '15–20 minutes' },
  { value: 60,  label: '30–60 minutes' },
  { value: 240, label: 'I am in for the long haul' },
];
const COMFORT_OPTIONS = [
  { value: 'yes',  label: 'Yes, throw me in' },
  { value: 'walk', label: 'Walk me through it' },
  { value: 'skip', label: 'Skip admin stuff' },
];

export default function LabRatQuiz() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [areas, setAreas] = useState([]);
  const [timeBudget, setTimeBudget] = useState(null);
  const [adminComfort, setAdminComfort] = useState(null);

  const surfacesAdmin = areas.includes('admin') || areas.includes('surprise');

  function toggleArea(id) {
    setAreas(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  function submit() {
    const params = new URLSearchParams();
    const expandSurprise = areas.includes('surprise')
      ? ['customer', 'applicant', 'staff', 'admin', 'mobile', 'edge']
      : areas;
    params.set('areas', expandSurprise.filter(a => a !== 'surprise').join(','));
    params.set('timeBudget', String(timeBudget));
    if (surfacesAdmin) params.set('adminComfort', adminComfort || 'skip');
    navigate(`/labrat/missions?${params.toString()}`);
  }

  return (
    <div data-app="labrat" className="labrat-quiz">
      <main>
        {step === 1 && (
          <>
            <h2>What sounds fun, lab rat?</h2>
            <p className="labrat-quiz-hint">Pick any (or all)</p>
            <div className="labrat-chip-grid">
              {AREA_OPTIONS.map(o => (
                <button key={o.id} type="button"
                  className={`labrat-chip ${areas.includes(o.id) ? 'on' : ''}`}
                  onClick={() => toggleArea(o.id)}>{o.label}</button>
              ))}
            </div>
            <div className="labrat-quiz-nav">
              <button onClick={() => navigate('/labrat')}>← Back</button>
              <button className="labrat-primary" disabled={!areas.length}
                onClick={() => setStep(2)}>Next →</button>
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <h2>How much time do you have?</h2>
            <div className="labrat-radio-list">
              {TIME_OPTIONS.map(o => (
                <label key={o.value}>
                  <input type="radio" name="time" checked={timeBudget === o.value}
                    onChange={() => setTimeBudget(o.value)} />
                  {o.label}
                </label>
              ))}
            </div>
            <div className="labrat-quiz-nav">
              <button onClick={() => setStep(1)}>← Back</button>
              <button className="labrat-primary" disabled={timeBudget == null}
                onClick={() => surfacesAdmin ? setStep(3) : submit()}>
                {surfacesAdmin ? 'Next →' : 'Show missions →'}
              </button>
            </div>
          </>
        )}
        {step === 3 && surfacesAdmin && (
          <>
            <h2>Comfortable with admin / back-office tools?</h2>
            <div className="labrat-radio-list">
              {COMFORT_OPTIONS.map(o => (
                <label key={o.value}>
                  <input type="radio" name="comfort" checked={adminComfort === o.value}
                    onChange={() => setAdminComfort(o.value)} />
                  {o.label}
                </label>
              ))}
            </div>
            <div className="labrat-quiz-nav">
              <button onClick={() => setStep(2)}>← Back</button>
              <button className="labrat-primary" disabled={!adminComfort}
                onClick={submit}>Show missions →</button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
