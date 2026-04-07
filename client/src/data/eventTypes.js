// Structured event types for the QuoteWizard and admin UI
// Categories are metadata for internal filtering — the client sees a flat list

const EVENT_TYPES = [
  // Wedding & Related
  { id: 'wedding-reception', label: 'Wedding Reception', category: 'wedding_related' },
  { id: 'rehearsal-dinner', label: 'Rehearsal Dinner', category: 'wedding_related' },
  { id: 'engagement-party', label: 'Engagement Party', category: 'wedding_related' },
  { id: 'bridal-shower', label: 'Bridal Shower', category: 'wedding_related' },
  { id: 'bachelor-bachelorette', label: 'Bachelor / Bachelorette Party', category: 'wedding_related' },

  // Celebrations
  { id: 'birthday-party', label: 'Birthday Party', category: 'celebrations' },
  { id: 'milestone-birthday', label: 'Milestone Birthday', category: 'celebrations' },
  { id: 'anniversary', label: 'Anniversary', category: 'celebrations' },
  { id: 'graduation-party', label: 'Graduation Party', category: 'celebrations' },
  { id: 'retirement-party', label: 'Retirement Party', category: 'celebrations' },
  { id: 'baby-shower', label: 'Baby Shower', category: 'celebrations' },

  // Corporate
  { id: 'corporate-event', label: 'Corporate Event', category: 'corporate' },
  { id: 'corporate-happy-hour', label: 'Corporate Happy Hour', category: 'corporate' },
  { id: 'holiday-party', label: 'Holiday Party', category: 'corporate' },
  { id: 'fundraiser-gala', label: 'Fundraiser / Gala', category: 'corporate' },

  // Social
  { id: 'cocktail-party', label: 'Cocktail Party', category: 'social' },
  { id: 'private-party', label: 'Private Party', category: 'social' },
  { id: 'housewarming', label: 'Housewarming', category: 'social' },
  { id: 'block-party', label: 'Block Party', category: 'social' },
  { id: 'dinner-party', label: 'Dinner Party', category: 'social' },

  // Memorial
  { id: 'celebration-of-life', label: 'Celebration of Life / Memorial', category: 'memorial' },

  // Other
  { id: 'festival-outdoor', label: 'Festival / Outdoor Event', category: 'other' },
  { id: 'other', label: 'Other', category: 'other' },
];

export default EVENT_TYPES;
