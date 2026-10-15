#!/usr/bin/env node
// One-shot smoke of the Gmail feed key (spec 2026-10-14 section 10), the only
// Gmail call allowed from the dev box. Run it once, before the key goes into
// Render, with the key in THIS command's environment only. Reading the JSON
// file keeps the base64 out of shell history:
//
//   GMAIL_SERVICE_ACCOUNT_KEY="$(base64 -w0 ~/.secrets/gmail-feed-key.json)" node scripts/gmail-probe.js
//
// Keep the downloaded JSON in ~/.secrets/ (chmod 600), never in the repo or
// Downloads, and delete it once the value is in Render.
//
// It loads no .env. Prints the address the key authenticates as, the label
// count, whether the Primary category label exists (the unknown-sender rule
// hangs on it), and whether the key is ready for Render. Prints nothing else:
// no label names, no mail. Exit 0 only when the key reads the business
// mailbox and the Primary label exists; 1 otherwise.
//
// Reading a failure (the error's stage says which Google call refused):
//   token 401  the Workspace domain-wide delegation row is missing, or it does
//              not carry exactly the gmail.readonly scope.
//   token 400  the key was deleted or disabled in Google Cloud, the mailbox
//              is not a Workspace user, or the box clock is off.
//   api 403    the Gmail API is not enabled on the Cloud project that owns the
//              service account.
const gc = require('../server/utils/gmailClient');

const HINTS = {
  'token 401': 'check the domain-wide delegation row and its one scope',
  'token 400': 'check the key still exists in Google Cloud, the mailbox is a Workspace user, and the box clock',
  'api 403': 'enable the Gmail API on the service account\'s Cloud project',
};

function fail(step, error) {
  const where = `${error.stage} ${error.status}`;
  console.error(`${step}: ${error.class} (${where})`);
  if (HINTS[where]) console.error(`hint: ${HINTS[where]}`);
  process.exit(1);
}

(async () => {
  if (!gc.isConfigured()) {
    console.error(gc.configurationError() || 'GMAIL_SERVICE_ACCOUNT_KEY unset');
    process.exit(1);
  }
  const client = gc.createGmailClient();
  const p = await client.getProfile();
  if (p.error) fail('profile', p.error);
  const l = await client.listLabels();
  if (l.error) fail('labels', l.error);
  const labels = ((l.data && l.data.labels) || []).map((x) => x.id);
  console.log(`authenticated as: ${p.data.emailAddress}`);
  console.log(`labels: ${labels.length}`);
  const hasPrimary = labels.includes('CATEGORY_PERSONAL');
  console.log(`CATEGORY_PERSONAL present: ${hasPrimary ? 'yes' : 'NO'}`);
  const rightMailbox = String(p.data.emailAddress || '').toLowerCase() === gc.GMAIL_MAILBOX;
  if (!rightMailbox || !hasPrimary) {
    console.error(`NOT ready for Render: ${!rightMailbox ? 'the key reads a different mailbox' : 'the Primary category label is missing'}`);
    process.exit(1);
  }
  console.log('ready for Render: yes');
})().catch((err) => {
  // Never the message: it could carry a fragment of the key or a response.
  console.error(`probe failed: ${err && err.name ? err.name : 'Error'}`);
  process.exit(1);
});
