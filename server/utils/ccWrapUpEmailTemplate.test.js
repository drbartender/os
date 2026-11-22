// The wrap-up email's feedback link uses the shared site base, so an unset PUBLIC_SITE_URL never mails "undefined/feedback/...".
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('the feedback link falls back to the live site when PUBLIC_SITE_URL is unset', () => {
  const saved = process.env.PUBLIC_SITE_URL;
  delete process.env.PUBLIC_SITE_URL;
  delete require.cache[require.resolve('./urls')];
  delete require.cache[require.resolve('./ccWrapUpEmailTemplate')];
  try {
    const { renderCcWrapUpEmail } = require('./ccWrapUpEmailTemplate');
    const out = JSON.stringify(renderCcWrapUpEmail({
      client: { name: 'Pat Example' }, proposal: { token: 'tok123', event_date: '2026-01-01' },
    }));
    assert.ok(!out.includes('undefined/feedback'), 'no link starts with undefined');
    assert.ok(out.includes('https://drbartender.com/feedback/tok123'));
  } finally {
    if (saved !== undefined) process.env.PUBLIC_SITE_URL = saved;
    delete require.cache[require.resolve('./urls')];
    delete require.cache[require.resolve('./ccWrapUpEmailTemplate')];
  }
});
