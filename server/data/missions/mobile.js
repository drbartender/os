module.exports = [
  {
    id: 'mobile-quote-and-signature',
    title: 'On your phone: get a quote and sign a proposal',
    blurb: 'Submit a quote from your phone, then sign the resulting proposal with your finger. Look for cramped layouts, missing buttons, anything ugly.',
    area: 'mobile',
    estMinutes: 10,
    difficulty: 'easy',
    device: ['mobile'],
    needsAdminComfort: false,
    priority: 'p1',
    seedRecipe: null,
    steps: [
      { text: 'Open Chrome or Safari on your phone. Go to drbartender.com.', expect: 'Homepage loads, no horizontal scroll, text readable.' },
      { text: 'Tap Get a Quote.', expect: 'Quote wizard loads.' },
      { text: 'Walk through every step. Pay attention to inputs being usable on a touch screen.', expect: 'Everything works; no field is hidden under the keyboard.' },
      { text: 'Submit. Open the proposal email on your phone.', expect: 'Email arrives, link opens proposal.' },
      { text: 'On the signature pad, sign with your finger.', expect: 'Signature captures cleanly.' },
      { text: 'Save the signature.', expect: 'Confirmation appears.' },
    ],
    successMessage: 'Mobile is where most real visitors land. Thanks for the touch test.',
  },
];
