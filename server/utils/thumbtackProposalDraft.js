const { EVENT_TYPES } = require('./eventTypes');

const ET_TZ = 'America/New_York';

// Ordered, specific-before-generic; first substring hit wins. Every id MUST
// exist in EVENT_TYPES (validated by mapEventType's lookup).
const EVENT_TYPE_KEYWORDS = [
  ['rehearsal', 'rehearsal-dinner'],
  ['engagement', 'engagement-party'],
  ['bridal shower', 'bridal-shower'],
  ['bachelorette', 'bachelor-bachelorette'],
  ['bachelor', 'bachelor-bachelorette'],
  ['wedding', 'wedding-reception'],
  ['milestone', 'milestone-birthday'],
  ['birthday', 'birthday-party'],
  ['anniversary', 'anniversary'],
  ['graduation', 'graduation-party'],
  ['retirement', 'retirement-party'],
  ['baby shower', 'baby-shower'],
  ['happy hour', 'corporate-happy-hour'],
  ['corporate', 'corporate-event'],
  ['company', 'corporate-event'],
  ['office', 'corporate-event'],
  ['holiday', 'holiday-party'],
  ['fundraiser', 'fundraiser-gala'],
  ['gala', 'fundraiser-gala'],
  ['cocktail party', 'cocktail-party'],
  ['housewarming', 'housewarming'],
  ['block party', 'block-party'],
  ['dinner party', 'dinner-party'],
  ['celebration of life', 'celebration-of-life'],
  ['memorial', 'celebration-of-life'],
  ['funeral', 'celebration-of-life'],
  ['mixology', 'cocktail-class'],
  ['class', 'cocktail-class'],
  ['festival', 'festival-outdoor'],
  ['outdoor', 'festival-outdoor'],
];

/** Best-effort event type from the Thumbtack category + Q&A answers. */
function mapEventType(lead) {
  const haystack = [
    lead.category || '',
    ...(Array.isArray(lead.details) ? lead.details.map(d => d.answer || '') : []),
  ].join(' ').toLowerCase();
  for (const [needle, id] of EVENT_TYPE_KEYWORDS) {
    if (haystack.includes(needle)) {
      const entry = EVENT_TYPES.find(t => t.id === id);
      return { eventType: id, eventTypeCategory: entry ? entry.category : null };
    }
  }
  return { eventType: null, eventTypeCategory: null };
}

/** UTC timestamp -> { eventDate: 'YYYY-MM-DD', eventStartTime: '6:00 PM' } in ET. */
function toEtDateAndTime(ts) {
  if (!ts) return { eventDate: null, eventStartTime: null };
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return { eventDate: null, eventStartTime: null };
  const eventDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d); // en-CA => YYYY-MM-DD
  const eventStartTime = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
  return { eventDate, eventStartTime };
}

/** Admin-facing context block (no em dashes). */
function buildAdminNotes(lead) {
  const lines = [];
  lines.push(`Auto-created from Thumbtack lead (negotiation ${lead.negotiationId || 'unknown'}).`);
  lines.push(`Category: ${lead.category || 'N/A'}`);
  lines.push(`Lead price / charge state: ${lead.leadPrice || 'N/A'} / ${lead.chargeState || 'N/A'}`);
  lines.push(`Event date as received: ${lead.eventDate || 'not specified'}`);
  lines.push('');
  lines.push('Customer description:');
  lines.push(lead.description ? String(lead.description).slice(0, 2000) : '(none)');
  if (Array.isArray(lead.details) && lead.details.length) {
    lines.push('');
    lines.push('Q&A:');
    for (const d of lead.details) {
      lines.push(`- ${String(d.question || '').slice(0, 200)}: ${String(d.answer || '').slice(0, 500)}`);
    }
  }
  lines.push('');
  lines.push('Reminder: add the client email before sending if you want them emailed, verify package and details, then Send and paste the link into the Thumbtack message.');
  return lines.join('\n');
}

module.exports = { mapEventType, toEtDateAndTime, buildAdminNotes };
