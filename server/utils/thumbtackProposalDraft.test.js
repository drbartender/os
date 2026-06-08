require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapEventType, toEtDateAndTime, buildAdminNotes } = require('./thumbtackProposalDraft');

test('mapEventType: maps wedding category to wedding-reception + category', () => {
  const r = mapEventType({ category: 'Wedding Bartending', details: [] });
  assert.equal(r.eventType, 'wedding-reception');
  assert.equal(r.eventTypeCategory, 'wedding_related');
});

test('mapEventType: specific beats generic (milestone before birthday)', () => {
  const r = mapEventType({ category: 'Bartending', details: [{ question: 'Occasion?', answer: 'Milestone birthday' }] });
  assert.equal(r.eventType, 'milestone-birthday');
});

test('mapEventType: happy hour beats corporate', () => {
  const r = mapEventType({ category: 'Corporate happy hour', details: [] });
  assert.equal(r.eventType, 'corporate-happy-hour');
});

test('mapEventType: no match returns nulls', () => {
  const r = mapEventType({ category: 'Bartending', details: [{ question: 'x', answer: 'just drinks' }] });
  assert.equal(r.eventType, null);
  assert.equal(r.eventTypeCategory, null);
});

test('toEtDateAndTime: late-evening UTC stays on the ET calendar day, 24h HH:MM', () => {
  // 2026-06-21T01:00:00Z is 2026-06-20 21:00 EDT
  const r = toEtDateAndTime('2026-06-21T01:00:00Z');
  assert.equal(r.eventDate, '2026-06-20');
  // event_start_time is the canonical 24-hour HH:MM (matches the manual
  // TimePicker, e.g. '17:00'). A 12-hour 'H:MM AM/PM' string makes downstream
  // formatters (ProposalDetail t.split(':').map(Number)) render '4:NaN AM'.
  assert.equal(r.eventStartTime, '21:00');
});

test('toEtDateAndTime: afternoon + midnight produce 24h HH:MM', () => {
  assert.equal(toEtDateAndTime('2026-06-21T20:00:00Z').eventStartTime, '16:00'); // 4 PM EDT
  assert.equal(toEtDateAndTime('2026-06-21T04:00:00Z').eventStartTime, '00:00'); // midnight ET
});

test('toEtDateAndTime: null input yields nulls', () => {
  assert.deepEqual(toEtDateAndTime(null), { eventDate: null, eventStartTime: null });
});

test('buildAdminNotes: includes negotiation, category, description, Q&A', () => {
  const notes = buildAdminNotes({
    negotiationId: 'neg123', category: 'Wedding', leadPrice: '$15', chargeState: 'charged',
    eventDate: '2026-06-21T01:00:00Z', description: 'Need a bartender',
    details: [{ question: 'Guests?', answer: '80' }],
  });
  assert.match(notes, /neg123/);
  assert.match(notes, /Wedding/);
  assert.match(notes, /Need a bartender/);
  assert.match(notes, /Guests\?: 80/);
});

const { after } = require('node:test');
const { pool } = require('../db');
const { createDraftProposalFromLead } = require('./thumbtackProposalDraft');

const _cleanup = { proposalIds: [], clientIds: [], negotiationIds: [] };

test('createDraftProposalFromLead: creates a $350 Core Reaction draft and links the lead', async () => {
  const negotiationId = `test-neg-${Date.now()}`;
  _cleanup.negotiationIds.push(negotiationId);

  // a client to attach to
  const c = await pool.query(
    "INSERT INTO clients (name, phone, source) VALUES ('TT Draft Test', '+15550001111', 'thumbtack') RETURNING id"
  );
  const clientId = c.rows[0].id;
  _cleanup.clientIds.push(clientId);

  // a lead row (the webhook path inserts this before calling us)
  await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, customer_name, category, guest_count, raw_payload)
     VALUES ($1, $2, 'TT Draft Test', 'Wedding Bartending', 80, '{}'::jsonb)`,
    [negotiationId, clientId]
  );

  const lead = {
    negotiationId, category: 'Wedding Bartending', guestCount: 80,
    eventDate: null, description: 'Need a bartender for a wedding',
    locationCity: 'Tampa', locationState: 'FL', locationZip: '33602', locationAddress: '1 Bay St',
    details: [{ question: 'Guests?', answer: '80' }],
  };

  const { proposalId } = await createDraftProposalFromLead({ lead, clientId, negotiationId });
  _cleanup.proposalIds.push(proposalId);

  const p = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
  const row = p.rows[0];
  assert.equal(row.status, 'draft');
  assert.equal(row.source, 'thumbtack');
  assert.equal(Number(row.total_price), 350);   // service_only, num_bars 0 => no bar fee
  assert.equal(row.event_type, 'wedding-reception');
  assert.equal(row.event_type_category, 'wedding_related');
  assert.ok(row.event_location && row.event_location.includes('Tampa') && row.event_location.includes('FL'), 'event_location should be composed from the venue fields');
  assert.match(row.admin_notes || '', /Auto-created from Thumbtack/);

  const lead2 = await pool.query('SELECT proposal_id FROM thumbtack_leads WHERE negotiation_id = $1', [negotiationId]);
  assert.equal(lead2.rows[0].proposal_id, proposalId);

  // idempotency: a second call returns the same id, no new proposal
  const again = await createDraftProposalFromLead({ lead, clientId, negotiationId });
  assert.equal(again.proposalId, proposalId);
});

after(async () => {
  for (const id of _cleanup.proposalIds) {
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [id]);
  }
  for (const neg of _cleanup.negotiationIds) await pool.query('DELETE FROM thumbtack_leads WHERE negotiation_id = $1', [neg]);
  for (const id of _cleanup.proposalIds) await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  for (const id of _cleanup.clientIds) await pool.query('DELETE FROM clients WHERE id = $1', [id]);
  await pool.end();
});
