module.exports = [
  {
    id: 'expired-or-bad-tokens',
    title: 'Try broken/expired URLs',
    blurb: 'Visit a few URLs that should fail gracefully. We want a friendly error, not a stack trace.',
    area: 'edge',
    estMinutes: 3,
    difficulty: 'easy',
    device: ['desktop', 'mobile'],
    needsAdminComfort: false,
    priority: 'p2',
    seedRecipe: null,
    steps: [
      { text: 'Visit drbartender.com/proposal/not-a-real-token.', expect: 'Friendly error page (no white screen, no stack trace).' },
      { text: 'Visit drbartender.com/labnotes/not-a-real-slug.', expect: '"Post Not Found" page.' },
      { text: 'Visit drbartender.com/invoice/not-a-real-token.', expect: 'Friendly error.' },
      { text: 'Visit drbartender.com/shopping-list/not-a-real-token.', expect: 'Friendly error.' },
      { text: 'Visit drbartender.com/plan/not-a-real-token.', expect: 'Friendly error.' },
    ],
    successMessage: 'Edge cases catch bugs nobody else looks for. Thanks for going hunting.',
  },
];
