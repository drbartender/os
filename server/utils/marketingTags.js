/**
 * Marketing tag vocabulary. Fixed enum, mirrored by the CHECK constraint
 * `client_tags_tag_check` in schema.sql and by client/src/utils/marketingTags.js.
 * Change all three together; marketingTags.test.js pins this file against both.
 *
 * Corporate is HUMAN-SET ONLY. Nothing may infer it from an email domain:
 * measured across every client with a proposal, 14 of the 30 who booked
 * corporate work used a personal address, and 10 of the 26 on company domains
 * were booking their own weddings and birthdays. The domain survives only as a
 * suggestion for a human to accept (marketingSuggestions.js).
 */
const MARKETING_TAGS = [
  { id: 'corporate', label: 'Corporate' },
  { id: 'wedding', label: 'Wedding' },
  { id: 'birthday', label: 'Birthday' },
  { id: 'graduation', label: 'Graduation' },
  { id: 'thumbtack', label: 'Thumbtack' },
];

const TAG_IDS = new Set(MARKETING_TAGS.map(t => t.id));

/**
 * Do-not-contact is shown alongside the tags in the UI but is backed by
 * clients.marketing_excluded and friends, never by a client_tags row, because
 * it needs a required reason and an actor and removal must be a confirmed
 * action. isValidTag deliberately rejects it so a tag-write path can never
 * smuggle it into client_tags; the DB CHECK rejects it too, as a backstop.
 */
const DO_NOT_CONTACT_ID = 'do-not-contact';

function isValidTag(id) {
  return typeof id === 'string' && TAG_IDS.has(id);
}

module.exports = { MARKETING_TAGS, TAG_IDS, isValidTag, DO_NOT_CONTACT_ID };
