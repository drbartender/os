// Canonical source vocabularies. Two DISTINCT lists that overlap but are not
// the same concept, so they are kept separate (mirrors reality — do not merge):
//   - CLIENT_SOURCES : how a client was acquired (backs clients.source)
//   - LEAD_SOURCES   : email-lead attribution (backs email_leads.lead_source)
//
// Mirrored by (keep every site in sync when adding a value):
//   - client/src/utils/clientSources.js       (CLIENT_SOURCES dropdown mirror)
//   - client/src/utils/leadSources.js         (LEAD_SOURCES mirror)
//   - server/routes/clients.js                VALID_SOURCES validator
//   - server/routes/emailMarketing.js         VALID_LEAD_SOURCES validator
//   - server/db/schema.sql clients_source_check         (base def + migration)
//   - server/db/schema.sql email_leads_lead_source_check (base def + migration)

const CLIENT_SOURCES = [
  { value: 'direct',    label: 'Direct' },
  { value: 'referral',  label: 'Referral' },
  { value: 'thumbtack', label: 'Thumbtack' },
  { value: 'zola',      label: 'Zola' },
  { value: 'website',   label: 'Website' },
  { value: 'calcom',    label: 'Cal.com' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'checkcherry', label: 'CheckCherry' },
  { value: 'other',     label: 'Other' },
];

const CLIENT_SOURCE_VALUES = CLIENT_SOURCES.map(s => s.value);

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

module.exports = { CLIENT_SOURCES, CLIENT_SOURCE_VALUES, LEAD_SOURCES };
