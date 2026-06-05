'use strict';
/**
 * Single source for gratuity line labels (spec §10). The CLIENT mirror at
 * client/src/utils/gratuityLabels.js MUST keep identical VALUES and the same
 * resolver branches — kept in sync manually, exactly like eventTypes.js.
 * gratuityLabels.test.js asserts parity.
 *
 * CANONICAL labels are stored in pricing_snapshot.breakdown and read by payroll
 * (payrollMath.extractGratuityCents). NEVER change them — back-compat + the
 * forced surcharge's stored label is load-bearing for the payroll pool.
 */
const SHARED_GRATUITY_LABEL = 'Shared Gratuity'; // forced over-ratio surcharge
const GRATUITY_LABEL = 'Gratuity';               // client-elected pre-paid gratuity (§8.3)

/**
 * DISPLAY strings (what humans see). The forced line gets a disambiguated
 * display so it can't be read as the §8.3 client gratuity. Frozen into
 * snapshot.display_labels at compute time (W9) so signed proposals never shift.
 */
const SHARED_GRATUITY_DISPLAY = 'Staffing Gratuity';
const GRATUITY_DISPLAY = 'Gratuity';

/** Payroll pools BOTH canonical labels into one gratuity figure (spec §8). */
const GRATUITY_PAYROLL_LABELS = [SHARED_GRATUITY_LABEL, GRATUITY_LABEL];

/**
 * Resolve a stored breakdown label to its display string. Prefers the
 * snapshot's frozen map (W9), then the current display map, then the raw label.
 */
function resolveGratuityDisplayLabel(label, snapshot) {
  const frozen = snapshot && snapshot.display_labels;
  if (frozen) {
    // `label` is a fixed breakdown label and `frozen` is our own snapshot map —
    // not user-controlled property access.
    // eslint-disable-next-line security/detect-object-injection
    const frozenVal = frozen[label];
    if (frozenVal) return frozenVal;
  }
  if (label === SHARED_GRATUITY_LABEL) return SHARED_GRATUITY_DISPLAY;
  if (label === GRATUITY_LABEL) return GRATUITY_DISPLAY;
  return label;
}

/** The display_labels map calculateProposal/recompute freeze into the snapshot. */
function currentDisplayLabels() {
  return {
    [SHARED_GRATUITY_LABEL]: SHARED_GRATUITY_DISPLAY,
    [GRATUITY_LABEL]: GRATUITY_DISPLAY,
  };
}

module.exports = {
  SHARED_GRATUITY_LABEL, GRATUITY_LABEL,
  SHARED_GRATUITY_DISPLAY, GRATUITY_DISPLAY,
  GRATUITY_PAYROLL_LABELS,
  resolveGratuityDisplayLabel, currentDisplayLabels,
};
