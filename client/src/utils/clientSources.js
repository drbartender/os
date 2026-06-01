// Canonical client source list. Must match `VALID_SOURCES` in
// server/routes/clients.js, the `clients_source_check` constraint in
// server/db/schema.sql, and the duplicated local `SOURCE` badge maps in
// client/src/pages/admin/ClientsDashboard.js and
// client/src/components/adminos/drawers/ClientDrawer.js.
export const CLIENT_SOURCES = [
  { value: 'direct',    label: 'Direct' },
  { value: 'referral',  label: 'Referral' },
  { value: 'thumbtack', label: 'Thumbtack' },
  { value: 'zola',      label: 'Zola' },
  { value: 'website',   label: 'Website' },
  { value: 'calcom',    label: 'Cal.com' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'other',     label: 'Other' },
];
