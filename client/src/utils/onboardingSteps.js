// The onboarding steps in order, and the path of the first one a recruit has not finished.
//
// One list for the progress bar (Layout.js) and for where a finished step goes next
// (Agreement.js, ContractorProfile.js), so the two cannot drift. A step's number is its
// index here: Account is the pre-step every recruit already has, Welcome is step 1 and
// Complete is step 6, which is what each page's "Step n of 6" header says.

export const ONBOARDING_STEPS = [
  { key: 'account_created', label: 'Account', path: null },
  { key: 'welcome_viewed', label: 'Welcome', path: '/welcome' },
  { key: 'field_guide_completed', label: 'Field Guide', path: '/field-guide' },
  { key: 'agreement_completed', label: 'Agreement', path: '/agreement' },
  { key: 'contractor_profile_completed', label: 'Profile', path: '/contractor-profile' },
  { key: 'payday_protocols_completed', label: 'Payday', path: '/payday-protocols' },
  { key: 'onboarding_completed', label: 'Complete', path: '/complete' },
];

// Steps 1 to 6; Account is not counted.
export const ONBOARDING_STEP_COUNT = ONBOARDING_STEPS.length - 1;

export const PATH_TO_STEP = ONBOARDING_STEPS.reduce((map, step, i) => {
  if (step.path) map[step.path] = i;
  return map;
}, {});

// The five steps a recruit does by hand, in order. Complete is where they land after.
const ACTION_STEPS = ONBOARDING_STEPS.filter(s => s.path && s.key !== 'onboarding_completed');

const PAYDAY_PATH = '/payday-protocols';

// The statuses RequirePortal admits (App.js): onboarding is done for them.
const ACTIVE_STATUSES = ['submitted', 'reviewed', 'approved'];

/**
 * Where a recruit goes after finishing the agreement or the profile: the first step,
 * in order, that the onboarding_progress row (as GET /progress and PUT /progress/step
 * return it) does not mark done.
 *
 * A finished row (all five steps done, or onboarding_completed set whatever earlier
 * step it lacks) never goes back to an earlier step: PUT /progress/step ignores
 * writes once onboarding is complete, so that would loop through Welcome, the Field
 * Guide and the agreement forever. Where it goes depends on the account's status:
 * an active staffer (one the portal admits) is done and goes to /complete, for
 * example after uploading a document from the completion page's notice; anyone
 * else goes to Payday, whose POST /api/payment is the only promotion, which is the
 * case for a staffer an admin moved back to hired (/complete would bounce them to
 * /welcome, since the portal refuses 'hired'). An unknown status goes to Payday.
 *
 * A row that has not loaded (Layout starts with an empty object, and a failed fetch
 * leaves it empty) returns `fallback` instead, so a missing row can never send
 * someone back to the Welcome page.
 *
 * @param {object} progress          the onboarding_progress row
 * @param {string} fallback          the path to use when the row has not loaded
 * @param {string} onboardingStatus  the signed-in user's users.onboarding_status
 * @returns {string}
 */
export function nextOnboardingPath(progress, fallback, onboardingStatus) {
  if (!progress || typeof progress.welcome_viewed !== 'boolean') return fallback;
  const next = progress.onboarding_completed ? null : ACTION_STEPS.find(s => !progress[s.key]);
  if (next) return next.path;
  return ACTIVE_STATUSES.includes(onboardingStatus) ? '/complete' : PAYDAY_PATH;
}
