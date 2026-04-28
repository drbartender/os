import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import api from '../../utils/api';
import BugDialog from './BugDialog';
import './labrat.css';

const COMPLETED_KEY = 'labrat-completed-ids';
const NAME_KEY = 'labrat-tester-name';

export default function LabRatMission() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [mission, setMission] = useState(null);
  const [error, setError] = useState(null);
  const [seedResult, setSeedResult] = useState(null);
  const [seedError, setSeedError] = useState(null);
  const [checked, setChecked] = useState({});
  const [dialog, setDialog] = useState(null);
  const testerName = localStorage.getItem(NAME_KEY) || '';

  useEffect(() => {
    setChecked({}); setSeedResult(null); setSeedError(null);
    api.get(`/qa/missions/${id}`).then(r => {
      setMission(r.data.mission);
      if (r.data.mission.seedRecipe) {
        api.post('/qa/seed', { recipe: r.data.mission.seedRecipe })
          .then(s => setSeedResult(s.data))
          .catch(e => setSeedError(e?.response?.data?.error || 'Could not set up the test data — flag this as a bug.'));
      }
    }).catch(e => setError(e?.response?.data?.error || 'Mission not found'));
  }, [id]);

  const toggle = useCallback((i) => {
    setChecked(prev => ({ ...prev, [i]: !prev[i] }));
  }, []);

  function openBug(stepIndex, stepText) {
    setDialog({ kind: 'bug', stepIndex, where: `${mission.title} — Step ${stepIndex + 1}`, didWhat: stepText });
  }
  function openConfusion() {
    setDialog({ kind: 'confusion', stepIndex: null, where: mission.title, didWhat: '' });
  }
  function openStale() {
    setDialog({ kind: 'mission-stale', stepIndex: null, where: mission.title, didWhat: '' });
  }

  async function done() {
    await api.post('/qa/complete', { missionId: id, testerName });
    let list = [];
    try { list = JSON.parse(localStorage.getItem(COMPLETED_KEY) || '[]'); } catch { /* ignore */ }
    if (!list.includes(id)) {
      list.push(id);
      localStorage.setItem(COMPLETED_KEY, JSON.stringify(list));
    }
    navigate('/labrat/missions');
  }

  if (error) return <div data-app="labrat" className="labrat-error">{error}</div>;
  if (!mission) return <div data-app="labrat" className="labrat-loading">Loading…</div>;

  const allChecked = mission.steps.every((_, i) => checked[i]);

  return (
    <div data-app="labrat" className="labrat-mission">
      <main>
        <Link to="/labrat/missions" className="labrat-link">← All missions</Link>
        <h1>{mission.title}</h1>
        <div className="labrat-mission-meta">
          <span>⏱ ~{mission.estMinutes} min</span>
          <span className={`labrat-diff ${mission.difficulty}`}>● {mission.difficulty}</span>
        </div>
        <p className="labrat-mission-blurb">{mission.blurb}</p>

        {mission.seedRecipe && (
          <section className="labrat-setup">
            <h2>Setup (auto)</h2>
            {!seedResult && !seedError && <p>Setting up your test data…</p>}
            {seedError && <p className="labrat-dialog-error">{seedError}</p>}
            {seedResult && seedResult.proposalUrl && (
              <>
                <p>✓ We made you a fake proposal in Sent state.</p>
                <a className="labrat-primary labrat-button"
                   href={seedResult.proposalUrl} target="_blank" rel="noopener noreferrer">
                  Open the test proposal →
                </a>
              </>
            )}
          </section>
        )}

        <section>
          <h2>Steps</h2>
          <ol className="labrat-step-list">
            {mission.steps.map((s, i) => (
              <li key={i} className={checked[i] ? 'done' : ''}>
                <label>
                  <input type="checkbox" checked={!!checked[i]} onChange={() => toggle(i)} />
                  <span>
                    <strong>{s.text}</strong>
                    {s.expect && <em> — {s.expect}</em>}
                  </span>
                </label>
                <button className="labrat-bug-btn" onClick={() => openBug(i, s.text)}>report bug</button>
              </li>
            ))}
          </ol>
        </section>

        <div className="labrat-mission-actions">
          <button onClick={openConfusion}>I&apos;m stuck</button>
          <button className="labrat-primary" disabled={!allChecked} onClick={done}>
            Done — next mission →
          </button>
        </div>

        <p className="labrat-stale-link">
          <button className="labrat-link" onClick={openStale}>This mission seems wrong — flag it</button>
        </p>
      </main>

      <BugDialog
        open={!!dialog}
        onClose={() => setDialog(null)}
        kind={dialog?.kind}
        missionId={id}
        stepIndex={dialog?.stepIndex}
        where={dialog?.where}
        didWhat={dialog?.didWhat}
        testerName={testerName}
      />
    </div>
  );
}
