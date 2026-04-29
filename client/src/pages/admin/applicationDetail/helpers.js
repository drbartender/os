// Pipeline stages used across the detail page. Mirrors the server-side flow:
// applied → interviewing → in_progress → active. Server's legacy 'hired' status
// collapses into 'in_progress' for stage-display purposes.
export const AD_FLOW = [
  { key: 'applied',      label: 'Applied',      verb: 'Application received' },
  { key: 'interviewing', label: 'Interview',    verb: 'Interviewing' },
  { key: 'in_progress',  label: 'Onboarding',   verb: 'Paperwork in flight' },
  { key: 'active',       label: 'Active staff', verb: 'On the roster' },
];

export const stageOf = (status) => status === 'hired' ? 'in_progress' : status;

export const initialsOf = (name) =>
  (name || '?').split(' ').filter(Boolean).map(n => n[0]).join('').toUpperCase().slice(0, 2);

export const relDay = (dateStr) => {
  if (!dateStr) return '—';
  const d = Math.round((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.round(d / 7)}w ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
};

export const dayDiff = (dateStr) => {
  if (!dateStr) return null;
  return Math.round((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
};

// 5-dim scorecard rubric. Order matches the server's interview_scores columns.
export const SCORECARD_DIMS = [
  { key: 'personality',      label: 'Personality / charisma' },
  { key: 'customer_service', label: 'Customer service instinct' },
  { key: 'problem_solving',  label: 'Problem-solving' },
  { key: 'speed_mindset',    label: 'Speed mindset' },
  { key: 'hire_instinct',    label: 'Hire instinct' },
];

// Onboarding paperwork checkpoints surfaced on the OnboardingCard. Maps
// directly to onboarding_progress booleans returned by the detail endpoint.
// The smaller welcome_viewed/field_guide_completed steps are intentionally
// omitted (per spec: major checkpoints only).
export const ONBOARDING_ITEMS = [
  { key: 'agreement_completed',          label: 'Contractor agreement' },
  { key: 'contractor_profile_completed', label: 'Profile + W-9' },
  { key: 'payday_protocols_completed',   label: 'Payday protocols' },
  { key: 'onboarding_completed',         label: 'Final paperwork done' },
];

// Status-chip kind helper for the identity bar.
export const chipKindFor = (status, onboardingProgress) => {
  if (status === 'rejected') return 'danger';
  if (status === 'in_progress' && onboardingProgress >= 1) return 'ok';
  if (status === 'applied') return 'info';
  if (status === 'interviewing') return 'info';
  if (status === 'in_progress' || status === 'hired') return 'warn';
  return 'neutral';
};

// Safe JSON-array parse for positions_interested / experience_types.
export const tryParseArray = (maybeJson) => {
  try {
    const v = JSON.parse(maybeJson || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
