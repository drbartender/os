// Shared proposal-row builder. ONE source of the proposals INSERT shape +
// venue composition + addon insert, so the manual create route and the
// Thumbtack auto-draft util can never drift. Pricing, status transitions,
// invoices, and emails are the CALLER's job — this only writes the row(s).
const { composeVenueLocation, normalizeVenueState } = require('./venueAddress');

/**
 * @param {object} dbClient  a connected pg client INSIDE an open transaction
 * @param {object} f         proposal fields (see below)
 * @returns {Promise<object>} the inserted proposals row (RETURNING *)
 */
async function insertProposalRecord(dbClient, f) {
  const v = f.venue || {};
  // composeVenueLocation reads venue_-prefixed keys (venue_name, venue_street,
  // venue_city, venue_state, venue_zip); our external `venue` contract uses the
  // unprefixed shape ({name, street, city, state, zip}), so adapt the keys here.
  // (The INSERT below stores the unprefixed values straight into the columns.)
  const composedLocation = composeVenueLocation({
    venue_name: v.name, venue_street: v.street, venue_city: v.city,
    venue_state: normalizeVenueState(v.state), venue_zip: v.zip,
  }) || f.eventLocationFallback || null;
  const snapshotJson = f.pricingSnapshot ? JSON.stringify(f.pricingSnapshot) : '{}';

  const result = await dbClient.query(`
    INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours,
      event_location, guest_count, package_id, num_bars, num_bartenders, pricing_snapshot, total_price, created_by,
      status, sent_at, class_options, client_provides_glassware,
      event_type, event_type_category, event_type_custom,
      venue_name, venue_street, venue_city, venue_state, venue_zip,
      source, admin_notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
    RETURNING *
  `, [
    f.clientId, f.eventDate || null, f.eventStartTime || null, f.durationHours,
    composedLocation, f.guestCount, f.packageId, f.numBars,
    f.numBartenders, snapshotJson, f.totalPrice, f.createdBy ?? null,
    f.status, f.sentAt || null, f.classOptions ? JSON.stringify(f.classOptions) : null,
    !!f.clientProvidesGlassware,
    f.eventType || null, f.eventTypeCategory || null, f.eventTypeCustom || null,
    // Canonicalize at the persist boundary (same rule as the composed
    // event_location above): the column must never hold 'IL' while the
    // composed string says 'Illinois'.
    v.name || null, v.street || null, v.city || null, normalizeVenueState(v.state) || null, v.zip || null,
    f.source || null, f.adminNotes || null,
  ]);
  const proposal = result.rows[0];

  const addons = (f.pricingSnapshot && f.pricingSnapshot.addons) || [];
  if (addons.length) {
    const placeholders = addons.map((_, i) => {
      const b = i * 8;
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`;
    }).join(',');
    const values = addons.flatMap(a =>
      [proposal.id, a.id, a.name, a.billing_type, a.rate, a.quantity, a.line_total, a.variant || null]
    );
    await dbClient.query(
      `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total, variant) VALUES ${placeholders}`,
      values
    );
  }
  return proposal;
}

module.exports = { insertProposalRecord };
