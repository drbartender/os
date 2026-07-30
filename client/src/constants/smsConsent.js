// Single source of truth for the SMS consent sentence shown to clients.
//
// This exact text is rendered in THREE places: the quote wizard checkbox
// (quoteWizard/steps/YourInfoStep.js), the standalone /sms opt-in form
// (website/SmsOptInPage.js), and the Text Messaging section of /privacy. A
// Twilio reviewer compares the public page against the forms, so the strings
// must be one literal, not three copies. Keep this inventory current: a stale
// list here is the likeliest way a future editor updates two surfaces and
// misses the third.
//
// KNOWN GAP: both checkbox surfaces render the closing clause as JSX so the
// links are clickable, hard-coding ' See our ' / ' and ' / '.' rather than
// composing SMS_CONSENT_TAIL. They agree byte-for-byte with TAIL today, but
// smsConsent.test.js compares constants and cannot see JSX, so editing TAIL
// updates /privacy and the server audit copy while both forms silently keep the
// old clause. If you change TAIL, hand-update both forms in the same commit.
//
// The sentence is split into LEAD + TAIL because the checkbox renders the tail
// as links while /privacy renders it as plain prose. Splitting it here, rather
// than slicing the full string at the call site, is what makes divergence
// impossible: a call site that slices has to guess whether the tail is still
// there, and its fallback silently renders the closing clause twice.
//
// The server keeps a matching copy in server/data/smsConsentCopy.js for the
// audit record. server/utils/smsConsent.test.js reconstructs LEAD + TAIL from
// this file's source and fails if it does not equal the server's string.
// Bump SMS_CONSENT_VERSION whenever the text changes, and ADD a new version to
// the server map rather than editing the old entry: existing sms_consent_log
// rows must keep resolving to the text those users agreed to.
//
// CLIENTS ONLY. Staff SMS consent lives on the contractor agreement
// (agreements.sms_consent, gating server/routes/messages.js) and is already
// approved with Twilio; it is deliberately not routed through this module.

export const SMS_CONSENT_VERSION = 'v1';

export const SMS_CONSENT_LEAD =
  'Text me about my event. I agree to receive text messages from Dr. Bartender ' +
  'about my quote, booking, payments, and event details at the mobile number ' +
  'provided. Message frequency varies. Msg & data rates may apply. Reply STOP ' +
  'to opt out, HELP for help. Consent is not a condition of purchase.';

export const SMS_CONSENT_TAIL = ' See our Privacy Policy and Terms.';

export const SMS_CONSENT_CLIENT = SMS_CONSENT_LEAD + SMS_CONSENT_TAIL;
