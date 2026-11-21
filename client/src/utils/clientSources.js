// Client acquisition source vocabulary (clients.source dropdown + badges).
// The canonical set is the CHECK below. When adding a source, update all of:
//   - server/routes/clients.js VALID_SOURCES validator
//   - the clients_source_check CHECK in server/db/schema.sql (base def + migration)
//   - the local `SOURCE` badge maps in client/src/pages/admin/ClientsDashboard.js
//     and client/src/pages/admin/ClientDetail.js
export const CLIENT_SOURCES = [
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
