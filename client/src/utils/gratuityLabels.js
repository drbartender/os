// Mirror of server/utils/gratuityLabels.js — keep VALUES + resolver branches
// byte-identical (synced manually, like eventTypes.js). server/utils/
// gratuityLabels.test.js asserts parity. Canonical labels are payroll/back-compat
// load-bearing.
export const SHARED_GRATUITY_LABEL = 'Shared Gratuity';
export const GRATUITY_LABEL = 'Gratuity';
export const SHARED_GRATUITY_DISPLAY = 'Staffing Gratuity';
export const GRATUITY_DISPLAY = 'Gratuity';

export function resolveGratuityDisplayLabel(label, snapshot) {
  const frozen = snapshot && snapshot.display_labels;
  if (frozen && frozen[label]) return frozen[label];
  if (label === SHARED_GRATUITY_LABEL) return SHARED_GRATUITY_DISPLAY;
  if (label === GRATUITY_LABEL) return GRATUITY_DISPLAY;
  return label;
}
