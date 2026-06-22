require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { mapEventType, toEventDateAndTime, buildAdminNotes, leadNeedsBar, decideNumBars, resolveDurationHours } = require('./thumbtackProposalDraft');

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

test('toEventDateAndTime: late-evening UTC stays on the Central calendar day, 24h HH:MM', () => {
  // 2026-06-21T01:00:00Z is 2026-06-20 20:00 CDT (Central = proposals.event_timezone default)
  const r = toEventDateAndTime('2026-06-21T01:00:00Z');
  assert.equal(r.eventDate, '2026-06-20');
  // canonical 24-hour HH:MM in Central time (matches the manual TimePicker, e.g.
  // '17:00'). A 12-hour 'H:MM AM/PM' string makes downstream formatters
  // (ProposalDetail t.split(':').map(Number)) render '4:NaN AM'.
  assert.equal(r.eventStartTime, '20:00');
});

test('toEventDateAndTime: Central conversion (Ruta) + day boundary', () => {
  // Ruta: Thumbtack proposedTimes 23:00Z => 6:00 PM Central (matches the customer's stated time)
  assert.deepEqual(toEventDateAndTime('2026-07-31T23:00:00Z'), { eventDate: '2026-07-31', eventStartTime: '18:00' });
  // 04:00Z stays on the prior Central day at 11 PM (would be next-day midnight in ET)
  assert.deepEqual(toEventDateAndTime('2026-06-22T04:00:00Z'), { eventDate: '2026-06-21', eventStartTime: '23:00' });
});

test('toEventDateAndTime: null input yields nulls', () => {
  assert.deepEqual(toEventDateAndTime(null), { eventDate: null, eventStartTime: null });
});

test('toEventDateAndTime: winter UTC converts at CST (UTC-6), proving DST is honored not hardcoded', () => {
  // 2026-01-15T05:30:00Z is 2026-01-14 23:30 CST (UTC-6). A hardcoded -5 (CDT)
  // would wrongly yield 00:30 on the 15th; the IANA zone gives the correct CST.
  assert.deepEqual(toEventDateAndTime('2026-01-15T05:30:00Z'), { eventDate: '2026-01-14', eventStartTime: '23:30' });
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

test('leadNeedsBar: true when a detail says the bartender must bring the bar', () => {
  assert.equal(leadNeedsBar({ details: [{ question: 'Bar availability', answer: 'Bartender will need to bring the bar' }] }), true);
});

test('leadNeedsBar: false when the customer already has a bar', () => {
  assert.equal(leadNeedsBar({ details: [{ question: 'Bar availability', answer: 'I have a bar the bartender can use' }] }), false);
});

test('leadNeedsBar: false when no bar detail is present', () => {
  assert.equal(leadNeedsBar({ details: [{ question: 'Guests?', answer: '80' }] }), false);
  assert.equal(leadNeedsBar({}), false);
});

test('leadNeedsBar: false when the free-text description says the CUSTOMER will bring the bar', () => {
  // lead.description is free customer prose. "I'll bring the bar" means the
  // customer supplies it, not us, and must NOT add a $50 bar rental to the draft.
  assert.equal(leadNeedsBar({
    description: "I'll bring the bar myself, just need a great bartender",
    details: [{ question: 'Bar availability', answer: 'I have a bar the bartender can use' }],
  }), false);
});

test('leadNeedsBar: false when the bar answer is negated (will NOT need to bring the bar)', () => {
  assert.equal(leadNeedsBar({
    details: [{ question: 'Bar availability', answer: 'Bartender will not need to bring the bar' }],
  }), false);
});

test('leadNeedsBar: false when only the question (not the answer) mentions bringing the bar', () => {
  // The question text frames the topic regardless of the answer; a "No" answer
  // must win. Old code matched the concatenated question text and false-fired.
  assert.equal(leadNeedsBar({
    details: [{ question: 'Will the bartender need to bring the bar?', answer: 'No, I already have a bar' }],
  }), false);
});

test('decideNumBars: service_only with no bring-the-bar answer is 0', () => {
  assert.equal(decideNumBars({ bar_type: 'service_only' }, { details: [{ question: 'Guests?', answer: '80' }] }), 0);
});

test('decideNumBars: service_only with a bring-the-bar answer is 1', () => {
  assert.equal(decideNumBars({ bar_type: 'service_only' }, { details: [{ question: 'Bar availability', answer: 'Bartender will need to bring the bar' }] }), 1);
});

test('decideNumBars: a non-service_only package always rents the first bar', () => {
  assert.equal(decideNumBars({ bar_type: 'mobile_bar' }, { details: [] }), 1);
});

test('resolveDurationHours: trusts a sane positive lead duration', () => {
  assert.equal(resolveDurationHours(6), 6);
  assert.equal(resolveDurationHours(2.5), 2.5);
  assert.equal(resolveDurationHours('3'), 3);
});

test('resolveDurationHours: falls back to 4 for missing/invalid/out-of-range', () => {
  for (const bad of [null, undefined, 0, -1, 25, NaN, 'abc', {}]) {
    assert.equal(resolveDurationHours(bad), 4, `expected fallback 4 for ${String(bad)}`);
  }
});

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
  // Out-of-service-area state (FL) normalizes to null so it can't poison the admin
  // edit form's state dropdown; the city/street still compose event_location, and
  // the raw lead location (incl. FL) is preserved in admin_notes for the operator.
  assert.ok(row.event_location && row.event_location.includes('Tampa'), 'event_location composed from the venue city/street');
  assert.equal(row.venue_state, null, 'out-of-area state normalized to null');
  assert.ok((row.admin_notes || '').includes('FL'), 'raw lead location (FL) preserved in admin_notes');
  assert.match(row.admin_notes || '', /Auto-created from Thumbtack/);

  const lead2 = await pool.query('SELECT proposal_id FROM thumbtack_leads WHERE negotiation_id = $1', [negotiationId]);
  assert.equal(lead2.rows[0].proposal_id, proposalId);

  // idempotency: a second call returns the same id, no new proposal
  const again = await createDraftProposalFromLead({ lead, clientId, negotiationId });
  assert.equal(again.proposalId, proposalId);
});

test('createDraftProposalFromLead: a "bring the bar" lead prices the $400 bar-rental draft', async () => {
  const negotiationId = `test-bar-${Date.now()}`;
  _cleanup.negotiationIds.push(negotiationId);

  const c = await pool.query(
    "INSERT INTO clients (name, phone, source) VALUES ('TT Bar Test', '+15550002222', 'thumbtack') RETURNING id"
  );
  const clientId = c.rows[0].id;
  _cleanup.clientIds.push(clientId);

  await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, customer_name, category, guest_count, raw_payload)
     VALUES ($1, $2, 'TT Bar Test', 'Bartending', 51, '{}'::jsonb)`,
    [negotiationId, clientId]
  );

  const lead = {
    negotiationId, category: 'Bartending', guestCount: 51, eventDate: null,
    description: 'need a bartender',
    details: [{ question: 'Bar availability', answer: 'Bartender will need to bring the bar' }],
  };

  const { proposalId } = await createDraftProposalFromLead({ lead, clientId, negotiationId });
  _cleanup.proposalIds.push(proposalId);

  const p = await pool.query('SELECT num_bars, total_price FROM proposals WHERE id = $1', [proposalId]);
  assert.equal(p.rows[0].num_bars, 1, 'a bring-the-bar lead must set num_bars=1');
  assert.equal(Number(p.rows[0].total_price), 400, 'Core Reaction + bar rental = $400');
});

test('createDraftProposalFromLead: a 6-hour lead prices the real duration (350 + 2x100) and stores 6h', async () => {
  const negotiationId = `test-dur-${Date.now()}`;
  _cleanup.negotiationIds.push(negotiationId);

  const c = await pool.query(
    "INSERT INTO clients (name, phone, source) VALUES ('TT Dur Test', '+15550003333', 'thumbtack') RETURNING id"
  );
  const clientId = c.rows[0].id;
  _cleanup.clientIds.push(clientId);

  await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, customer_name, category, guest_count, raw_payload)
     VALUES ($1, $2, 'TT Dur Test', 'Bartending', 60, '{}'::jsonb)`,
    [negotiationId, clientId]
  );

  // eventDuration captured upstream from the Thumbtack event window (end - start).
  const lead = {
    negotiationId, category: 'Bartending', guestCount: 60, eventDate: null, eventDuration: 6,
    description: 'six hour event', details: [],
  };

  const { proposalId } = await createDraftProposalFromLead({ lead, clientId, negotiationId });
  _cleanup.proposalIds.push(proposalId);

  const p = await pool.query('SELECT event_duration_hours, total_price FROM proposals WHERE id = $1', [proposalId]);
  assert.equal(Number(p.rows[0].event_duration_hours), 6, 'draft must carry the lead duration, not the default 4');
  assert.equal(Number(p.rows[0].total_price), 550, 'Core Reaction 6hr = 350 + (6-4)*100');
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
