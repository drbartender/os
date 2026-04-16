// Resolves an event type id to a human label.
// Mirrors client/src/data/eventTypes.js — keep both files in sync when adding types.

const EVENT_TYPES = [
  { id: 'wedding-reception', label: 'Wedding Reception', category: 'wedding_related' },
  { id: 'rehearsal-dinner', label: 'Rehearsal Dinner', category: 'wedding_related' },
  { id: 'engagement-party', label: 'Engagement Party', category: 'wedding_related' },
  { id: 'bridal-shower', label: 'Bridal Shower', category: 'wedding_related' },
  { id: 'bachelor-bachelorette', label: 'Bachelor / Bachelorette Party', category: 'wedding_related' },
  { id: 'birthday-party', label: 'Birthday Party', category: 'celebrations' },
  { id: 'milestone-birthday', label: 'Milestone Birthday', category: 'celebrations' },
  { id: 'anniversary', label: 'Anniversary', category: 'celebrations' },
  { id: 'graduation-party', label: 'Graduation Party', category: 'celebrations' },
  { id: 'retirement-party', label: 'Retirement Party', category: 'celebrations' },
  { id: 'baby-shower', label: 'Baby Shower', category: 'celebrations' },
  { id: 'corporate-event', label: 'Corporate Event', category: 'corporate' },
  { id: 'corporate-happy-hour', label: 'Corporate Happy Hour', category: 'corporate' },
  { id: 'holiday-party', label: 'Holiday Party', category: 'corporate' },
  { id: 'fundraiser-gala', label: 'Fundraiser / Gala', category: 'corporate' },
  { id: 'cocktail-party', label: 'Cocktail Party', category: 'social' },
  { id: 'private-party', label: 'Private Party', category: 'social' },
  { id: 'housewarming', label: 'Housewarming', category: 'social' },
  { id: 'block-party', label: 'Block Party', category: 'social' },
  { id: 'dinner-party', label: 'Dinner Party', category: 'social' },
  { id: 'celebration-of-life', label: 'Celebration of Life / Memorial', category: 'memorial' },
  { id: 'cocktail-class', label: 'Cocktail Class', category: 'class' },
  { id: 'festival-outdoor', label: 'Festival / Outdoor Event', category: 'other' },
  { id: 'other', label: 'Other', category: 'other' },
];

function getEventTypeLabel(arg) {
  const { event_type, event_type_custom } = arg || {};
  if (event_type_custom) return event_type_custom;
  if (event_type === 'other' || event_type === 'Other') return 'event';
  const found = EVENT_TYPES.find(t => t.id === event_type || t.label === event_type);
  return found ? found.label : 'event';
}

module.exports = { EVENT_TYPES, getEventTypeLabel };
