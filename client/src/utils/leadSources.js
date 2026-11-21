// Email-lead attribution vocabulary (email_leads.lead_source).
// The canonical set is the CHECK below. When adding a value, update all of:
//   - server/routes/emailMarketing/leads.js VALID_LEAD_SOURCES validator
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
