// Email-lead attribution vocabulary (email_leads.lead_source).
// Mirrors server/utils/clientSources.js (LEAD_SOURCES) — the canonical list.
// Keep both files in sync when adding a value, and also update:
//   - server/routes/emailMarketing.js VALID_LEAD_SOURCES validator
//   - the email_leads_lead_source_check CHECK in server/db/schema.sql
//     (base def + migration)
// Consumers (filter dropdowns, edit forms, audience selector) pick up new
// values automatically.

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
