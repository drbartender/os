import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './labrat.css';

const NAME_KEY = 'labrat-tester-name';

export default function LabRatLanding() {
  const navigate = useNavigate();
  const [name, setName] = useState('');

  useEffect(() => { setName(localStorage.getItem(NAME_KEY) || ''); }, []);

  function persistName() {
    if (name.trim()) localStorage.setItem(NAME_KEY, name.trim());
  }

  return (
    <div data-app="labrat" className="labrat-landing">
      <main>
        <h1>Be a Lab Rat</h1>
        <p>
          Dr. Bartender is about to launch. Pick a mission, click around,
          tell us what&apos;s broken. Five to sixty minutes — your call.
          Nothing you do here reaches real customers.
        </p>
        <div className="labrat-name">
          <label>
            First name (optional)
            <input
              type="text" value={name} maxLength={60}
              placeholder="So we know who broke what"
              onChange={e => setName(e.target.value)}
            />
          </label>
        </div>
        <div className="labrat-cta">
          <button className="labrat-primary"
            onClick={() => { persistName(); navigate('/labrat/quiz'); }}>
            Take a quick quiz →
          </button>
          <button className="labrat-ghost"
            onClick={() => { persistName(); navigate('/labrat/missions'); }}>
            Show me the missions
          </button>
        </div>
      </main>
    </div>
  );
}
