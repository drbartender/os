// Canonical client source list. Must match `VALID_SOURCES` in
// server/routes/clients.js and the `clients_source_check` constraint in
// server/db/schema.sql.
export const CLIENT_SOURCES = [
  { value: 'direct',    label: 'Direct' },
  { value: 'referral',  label: 'Referral' },
  { value: 'thumbtack', label: 'Thumbtack' },
  { value: 'website',   label: 'Website' },
  { value: 'calcom',    label: 'Cal.com' },
];
