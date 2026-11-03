import { nextOnboardingPath, ONBOARDING_STEP_COUNT, PATH_TO_STEP } from './onboardingSteps';

const NONE_DONE = {
  account_created: true,
  welcome_viewed: false,
  field_guide_completed: false,
  agreement_completed: false,
  contractor_profile_completed: false,
  payday_protocols_completed: false,
  onboarding_completed: false,
};

test('each step is next when it is the first one not done', () => {
  const order = [
    ['welcome_viewed', '/welcome'],
    ['field_guide_completed', '/field-guide'],
    ['agreement_completed', '/agreement'],
    ['contractor_profile_completed', '/contractor-profile'],
    ['payday_protocols_completed', '/payday-protocols'],
  ];
  const row = { ...NONE_DONE };
  for (const [key, path] of order) {
    expect(nextOnboardingPath(row, '/fallback')).toBe(path);
    row[key] = true;
  }
  // All five done still ends at Payday: only its submit can finish onboarding.
  expect(nextOnboardingPath(row, '/fallback')).toBe('/payday-protocols');
});

test('a finished row goes to Payday, never to an earlier step or to /complete', () => {
  // An admin re-hire keeps the all-done row; /complete would bounce a hired
  // staffer to /welcome. A finished row missing an early step cannot have that
  // step written any more, so routing to it would loop.
  const allDone = {
    account_created: true,
    welcome_viewed: true,
    field_guide_completed: true,
    agreement_completed: true,
    contractor_profile_completed: true,
    payday_protocols_completed: true,
    onboarding_completed: true,
  };
  expect(nextOnboardingPath(allDone, '/fallback')).toBe('/payday-protocols');
  expect(nextOnboardingPath({ ...allDone, welcome_viewed: false, field_guide_completed: false }, '/fallback'))
    .toBe('/payday-protocols');
});

test('a finished row goes to /complete for an active staffer and to Payday otherwise', () => {
  // An approved staffer who uploads a document from the completion page's notice
  // is done; a staffer an admin moved back to hired must pass Payday to be promoted.
  const finished = {
    account_created: true,
    welcome_viewed: true,
    field_guide_completed: true,
    agreement_completed: true,
    contractor_profile_completed: true,
    payday_protocols_completed: true,
    onboarding_completed: true,
  };
  for (const status of ['approved', 'submitted', 'reviewed']) {
    expect(nextOnboardingPath(finished, '/fallback', status)).toBe('/complete');
  }
  expect(nextOnboardingPath(finished, '/fallback', 'hired')).toBe('/payday-protocols');
  expect(nextOnboardingPath(finished, '/fallback', 'in_progress')).toBe('/payday-protocols');
  expect(nextOnboardingPath(finished, '/fallback', undefined)).toBe('/payday-protocols');
  // A finished row with a gap never goes back to the gap, whatever the status.
  const gap = { ...finished, welcome_viewed: false };
  expect(nextOnboardingPath(gap, '/fallback', 'approved')).toBe('/complete');
  expect(nextOnboardingPath(gap, '/fallback', 'hired')).toBe('/payday-protocols');
});

test('an unfinished row follows the steps whatever the status', () => {
  const row = { ...NONE_DONE, welcome_viewed: true, field_guide_completed: true };
  expect(nextOnboardingPath(row, '/fallback', 'approved')).toBe('/agreement');
});

test('a profile finished before the agreement goes back to the agreement, not to Payday', () => {
  // The documents banner links to the profile from every page, so a recruit can
  // finish it with the agreement still unsigned.
  const row = {
    ...NONE_DONE,
    welcome_viewed: true,
    field_guide_completed: true,
    contractor_profile_completed: true,
  };
  expect(nextOnboardingPath(row, '/payday-protocols')).toBe('/agreement');
});

test('an agreement signed after the profile skips straight to Payday', () => {
  const row = {
    ...NONE_DONE,
    welcome_viewed: true,
    field_guide_completed: true,
    agreement_completed: true,
    contractor_profile_completed: true,
  };
  expect(nextOnboardingPath(row, '/contractor-profile')).toBe('/payday-protocols');
});

test('a row that has not loaded returns the fallback, never the Welcome page', () => {
  expect(nextOnboardingPath({}, '/contractor-profile')).toBe('/contractor-profile');
  expect(nextOnboardingPath(undefined, '/contractor-profile')).toBe('/contractor-profile');
  expect(nextOnboardingPath(null, '/payday-protocols')).toBe('/payday-protocols');
  // Layout's state after a fetch that returned only the documents list.
  expect(nextOnboardingPath({ documents_outstanding: [] }, '/payday-protocols')).toBe('/payday-protocols');
});

test('the step numbers match the page headers, Welcome 1 to Complete 6', () => {
  expect(ONBOARDING_STEP_COUNT).toBe(6);
  expect(PATH_TO_STEP['/welcome']).toBe(1);
  expect(PATH_TO_STEP['/agreement']).toBe(3);
  expect(PATH_TO_STEP['/contractor-profile']).toBe(4);
  expect(PATH_TO_STEP['/payday-protocols']).toBe(5);
  expect(PATH_TO_STEP['/complete']).toBe(6);
});
