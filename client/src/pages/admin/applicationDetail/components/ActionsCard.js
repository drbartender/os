import React from 'react';
import Icon from '../../../../components/adminos/Icon';
import { stageOf } from '../helpers';

// Right-rail action card. Primary CTA is stage-aware:
//   applied                     → Invite to interview
//   interview (unscheduled)     → Schedule interview
//   interview (scheduled)       → Hire (moves to onboarding)
//   in_progress                 → no primary; just secondary actions
//   rejected                    → Restore to Applied
export default function ActionsCard({ a, acting, onMove, onSchedule, onReject, onRestore, onReminder }) {
  const status = stageOf(a.onboarding_status);
  const isRejected = a.onboarding_status === 'rejected';
  const hasInterview = !!a.interview_at;

  let primary = null;
  if (isRejected) {
    primary = { label: 'Restore to Applied', icon: 'check', onClick: onRestore };
  } else if (status === 'applied') {
    primary = { label: 'Invite to interview', icon: 'arrow_right', onClick: () => onMove('interviewing') };
  } else if (status === 'interviewing' && !hasInterview) {
    primary = { label: 'Schedule interview', icon: 'calendar', onClick: onSchedule };
  } else if (status === 'interviewing' && hasInterview) {
    primary = { label: 'Hire', icon: 'check', onClick: () => onMove('in_progress') };
  }

  return (
    <div className="card">
      <div className="card-head"><h3>Actions</h3></div>
      <div className="card-body vstack" style={{ gap: 8 }}>
        {primary && (
          <button
            className="btn btn-primary"
            disabled={acting}
            onClick={primary.onClick}
            style={{ justifyContent: 'center' }}
          >
            <Icon name={primary.icon} size={12} />{primary.label}
          </button>
        )}
        {!isRejected && status === 'interviewing' && hasInterview && (
          <button className="btn btn-secondary" disabled={acting} onClick={onSchedule} style={{ justifyContent: 'flex-start' }}>
            <Icon name="calendar" size={12} />Reschedule
          </button>
        )}
        {status === 'in_progress' && (
          <button className="btn btn-secondary" disabled={acting} onClick={onReminder} style={{ justifyContent: 'flex-start' }}>
            <Icon name="mail" size={12} />Send paperwork reminder
          </button>
        )}
        <button
          className="btn btn-secondary"
          onClick={() => { window.location.href = `mailto:${a.email}`; }}
          style={{ justifyContent: 'flex-start' }}
        >
          <Icon name="mail" size={12} />Email applicant
        </button>
        {!isRejected && status !== 'in_progress' && (
          <button
            className="btn btn-ghost"
            disabled={acting}
            onClick={onReject}
            style={{ justifyContent: 'flex-start', color: 'hsl(var(--danger-h) var(--danger-s) 60%)' }}
          >
            <Icon name="x" size={12} />Reject &amp; archive
          </button>
        )}
      </div>
    </div>
  );
}
