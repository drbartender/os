require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('./lifecycleEmailTemplates');

function assertShape(tpl) {
  assert.equal(typeof tpl.subject, 'string');
  assert.equal(typeof tpl.html, 'string');
  assert.equal(typeof tpl.text, 'string');
  assert.ok(!tpl.subject.includes('—') && !tpl.html.includes('—') && !tpl.text.includes('—'), 'no em dashes');
}

test('changeRequestAdminAlert renders and marks urgent for inside_t14', () => {
  const tpl = t.changeRequestAdminAlert({ clientName: 'Pat', eventLabel: 'wedding', editWindow: 'inside_t14', estimatedTotal: 5200, currentTotal: 4800, note: 'more guests', adminUrl: 'https://admin.x/proposals/1' });
  assertShape(tpl);
  assert.match(tpl.subject, /\[Soon\]/);
  assert.match(tpl.html, /Pat/);
  assert.match(tpl.html, /5200\.00/);
});

test('changeRequestApproved shows new total and conditional balance', () => {
  const withBal = t.changeRequestApproved({ clientName: 'Pat', eventLabel: 'wedding', newTotal: 5200, balanceDue: 400, portalUrl: 'https://x/my-proposals' });
  assertShape(withBal);
  assert.match(withBal.html, /5200\.00/);
  assert.match(withBal.html, /400\.00/);
  const noBal = t.changeRequestApproved({ clientName: 'Pat', eventLabel: 'wedding', newTotal: 5200, balanceDue: 0, portalUrl: 'https://x/my-proposals' });
  assert.ok(!noBal.html.includes('Balance remaining'));
});

test('changeRequestDeclined includes the reason', () => {
  const tpl = t.changeRequestDeclined({ clientName: 'Pat', eventLabel: 'wedding', reason: 'No availability that date.', portalUrl: 'https://x/my-proposals' });
  assertShape(tpl);
  assert.match(tpl.html, /No availability that date\./);
});
