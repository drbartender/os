// Single source of truth for valid lead source values.
// Mirrors:
//   - server/routes/emailMarketing.js VALID_LEAD_SOURCES
//   - schema.sql CHECK constraint on email_leads.lead_source
//
// When adding a value here, update both of those — the schema, the validator,
// and every consumer (filter dropdowns, edit forms, audience selector) picks
// the new value up automatically.

const LEAD_SOURCES = [
  'manual',
  'csv_import',
  'website',
  'quote_wizard',
  'potion_lab',
  'thumbtack',
  'referral',
  'instagram',
  'facebook',
  'google',
  'other',
];

export { LEAD_SOURCES };
export default LEAD_SOURCES;
