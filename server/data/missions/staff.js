module.exports = [
  {
    id: 'staff-portal-tour',
    title: 'Tour the staff portal',
    blurb: 'You\'re a fake staff member already onboarded. Log in to staff.drbartender.com and check that every section loads.',
    area: 'staff',
    estMinutes: 8,
    difficulty: 'medium',
    device: ['desktop', 'mobile'],
    needsAdminComfort: true,
    priority: 'p2',
    seedRecipe: null,
    steps: [
      { text: 'Open admin.drbartender.com in a private/incognito window. Log in as admin@drbartender.com / DrBartender2024!.', expect: 'Admin dashboard loads.' },
      { text: 'Find any approved staff user in the Staff list. Note their email.', expect: 'Staff list loads with rows.' },
      { text: 'Open staff.drbartender.com in a different browser. Log in with that staff email and any test password (or use Forgot Password to set one).', expect: 'Staff dashboard loads (not the welcome/onboarding page).' },
      { text: 'Click each sidebar section: Dashboard, Shifts, Schedule, Events, Resources, Profile.', expect: 'Every section loads without error.' },
      { text: 'Pick any open shift, select a position, click "Request This Shift".', expect: 'Pending status chip appears on that shift.' },
      { text: 'Click "Cancel Request" on the same shift.', expect: 'Goes back to unrequested.' },
    ],
    successMessage: 'Staff portal exercised — thanks.',
  },
];
