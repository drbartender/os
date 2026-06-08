const { EVENT_TYPES } = require('./eventTypes');
const { pool } = require('../db');
const { calculateProposal } = require('./pricingEngine');
const { insertProposalRecord } = require('./proposalInsert');

const CORE_REACTION_SLUG = 'the-core-reaction';

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

/**
 * True when the Thumbtack lead's "Bar availability" answer asks us to supply the
 * bar (e.g. "Bartender will need to bring the bar"). The customer then needs a
 * bar rented, so the draft sets num_bars=1 to add the first_bar_fee.
 */
function leadNeedsBar(lead) {
  const details = Array.isArray(lead.details) ? lead.details : [];
  const hay = [
    lead.description || '',
    ...details.map(d => `${d.question || ''} ${d.answer || ''}`),
  ].join(' ').toLowerCase();
  return hay.includes('bring the bar') || hay.includes('bring a bar');
}

/** UTC timestamp -> { eventDate: 'YYYY-MM-DD', eventStartTime: '6:00 PM' } in ET. */
function toEtDateAndTime(ts) {
  if (!ts) return { eventDate: null, eventStartTime: null };
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return { eventDate: null, eventStartTime: null };
  const eventDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d); // en-CA => YYYY-MM-DD
  // 24-hour HH:MM, the canonical event_start_time format (the manual TimePicker
  // stores e.g. '17:00'). Downstream formatters split on ':' and Number()-coerce
  // the parts, so a 12-hour 'H:MM AM/PM' string renders as '4:NaN AM'.
  const eventStartTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: ET_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
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

/**
 * Create an inert DRAFT proposal (The Core Reaction) from a parsed Thumbtack
 * lead. Owns its own transaction. NEVER creates an invoice, sends mail/SMS, or
 * sets 'sent'. Idempotent on the lead's existing proposal_id.
 */
async function createDraftProposalFromLead({ lead, clientId, negotiationId }) {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const guard = await dbClient.query(
      'SELECT proposal_id FROM thumbtack_leads WHERE negotiation_id = $1 FOR UPDATE',
      [negotiationId]
    );
    if (guard.rows[0] && guard.rows[0].proposal_id) {
      await dbClient.query('COMMIT');
      return { proposalId: guard.rows[0].proposal_id };
    }

    const pkgRes = await dbClient.query('SELECT * FROM service_packages WHERE slug = $1', [CORE_REACTION_SLUG]);
    const pkg = pkgRes.rows[0];
    if (!pkg) throw new Error(`Package ${CORE_REACTION_SLUG} not found`);

    // service_only packages rent no physical bar by default (num_bars 0). BUT
    // when the lead's "Bar availability" answer says the bartender must bring the
    // bar, the customer needs us to supply it, so set num_bars=1 to add the bar
    // rental (first_bar_fee, e.g. $50 => $400 for Core Reaction; matches
    // Thumbtack's own estimate). See pricingEngine.calculateBarRental.
    const numBars = pkg.bar_type === 'service_only' ? (leadNeedsBar(lead) ? 1 : 0) : 1;
    const guestCount = lead.guestCount || 50;
    const durationHours = 4;

    const snapshot = calculateProposal({
      pkg, guestCount, durationHours, numBars,
      numBartenders: undefined, addons: [], syrupSelections: [],
    });

    const { eventType, eventTypeCategory } = mapEventType(lead);
    const { eventDate, eventStartTime } = toEtDateAndTime(lead.eventDate);

    const proposal = await insertProposalRecord(dbClient, {
      clientId,
      eventDate, eventStartTime, durationHours,
      venue: {
        name: null,
        street: lead.locationAddress || null,
        city: lead.locationCity || null,
        state: lead.locationState || null,
        zip: lead.locationZip || null,
      },
      eventLocationFallback: null,
      guestCount,
      packageId: pkg.id,
      numBars,
      numBartenders: snapshot.staffing.actual ?? null,
      pricingSnapshot: snapshot,
      totalPrice: snapshot.total,
      createdBy: null,
      status: 'draft',
      sentAt: null,
      classOptions: null,
      clientProvidesGlassware: false,
      eventType, eventTypeCategory, eventTypeCustom: null,
      source: 'thumbtack',
      adminNotes: buildAdminNotes({ ...lead, negotiationId }),
    });

    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, 'created', 'system', $2)`,
      [proposal.id, JSON.stringify({ source: 'thumbtack', negotiation_id: negotiationId })]
    );
    await dbClient.query(
      'UPDATE thumbtack_leads SET proposal_id = $1 WHERE negotiation_id = $2',
      [proposal.id, negotiationId]
    );

    await dbClient.query('COMMIT');
    console.log(`[thumbtack-draft] created proposal ${proposal.id} for negotiation ${negotiationId}`);
    return { proposalId: proposal.id };
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (e) { console.error('[thumbtack-draft] ROLLBACK failed:', e.message); }
    throw err;
  } finally {
    dbClient.release();
  }
}

module.exports = { mapEventType, toEtDateAndTime, buildAdminNotes, leadNeedsBar, createDraftProposalFromLead };
