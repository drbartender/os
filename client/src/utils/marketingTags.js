/**
 * Marketing tag vocabulary, ESM mirror of server/utils/marketingTags.js.
 * Client and server bundles are separate, so these are kept in sync by hand,
 * the same arrangement as eventTypes.js and gratuityLabels.js. The CHECK
 * constraint `client_tags_tag_check` in schema.sql is the third copy.
 * Change all three together; a server test pins all three against each other.
 */
export const MARKETING_TAGS = [
  { id: 'corporate', label: 'Corporate' },
  { id: 'wedding', label: 'Wedding' },
  { id: 'birthday', label: 'Birthday' },
  { id: 'graduation', label: 'Graduation' },
  { id: 'thumbtack', label: 'Thumbtack' },
];

/**
 * Rendered as a tag but never editable as one: it carries a required reason
 * and removing it takes a confirmation, so it has its own control and its own
 * endpoint. Never put it in a tag picker.
 */
export const DO_NOT_CONTACT_ID = 'do-not-contact';

/** Computed by the server at read time. Never stored, never set by a human. */
export const DERIVED_STATES = {
  paid: 'Paid client',
  quoted: 'Quoted only',
  untagged: 'Untagged',
};

export function tagLabel(id) {
  const t = MARKETING_TAGS.find(x => x.id === id);
  return t ? t.label : id;
}
