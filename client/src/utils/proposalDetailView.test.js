import {
  BOOKED_STATUSES, bookedTarget, proposalHeaderOf, proposalContactsOf, statusLineOf, chipOf, packageOf, clientLinkOf, gatesOf, archiveReasonLabel,
} from './proposalDetailView';
import { PUBLIC_SITE_URL } from './constants';

const NOW = new Date('2026-10-14T18:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();
const TOKEN = '8k2f4a77-1c3d-4e5f-9a0b-123456789abc';

const prop = (over = {}) => ({
  id: 41, status: 'sent', client_name: 'Test Client', event_type: 'wedding-reception', event_type_custom: null,
  event_date: '2026-11-21T00:00:00.000Z', event_start_time: '18:00', event_duration_hours: '5', guest_count: 120,
  total_price: '4900.00', amount_paid: '0', token: TOKEN, legal_hold: false, group_id: null,
  sent_at: hoursAgo(48), last_viewed_at: null, view_count: 0, accepted_at: null, client_signed_at: null,
  created_at: hoursAgo(60), updated_at: hoursAgo(1), archive_reason: null,
  pricing_snapshot: { total: 4900, breakdown: [{ label: 'Signature bar', amount: 4270 }, { label: 'Mobile bar rental', amount: 450 }, { label: 'Glassware', amount: 180 }] },
  ...over,
});

describe('statusLineOf', () => {
  test('draft: never sent', () => {
    expect(statusLineOf(prop({ status: 'draft', sent_at: null }), NOW)).toBe('draft · never sent');
  });
  test('sent and not opened yet', () => {
    expect(statusLineOf(prop(), NOW)).toBe('sent 2d ago · not opened yet');
    expect(statusLineOf(prop({ sent_at: null }), NOW)).toBe('sent · not opened yet');
  });
  test('sent again after a view keeps the view: the views, never "not opened yet"', () => {
    const line = statusLineOf(prop({ status: 'sent', sent_at: hoursAgo(5), last_viewed_at: hoursAgo(30), view_count: 2 }), NOW);
    expect(line).toBe('sent 5h ago · viewed 1d ago · 2 views');
  });
  test('viewed: the sent time, the last view and the count, singular at one', () => {
    expect(statusLineOf(prop({ status: 'viewed', sent_at: '2026-08-10T15:00:00Z', last_viewed_at: hoursAgo(5), view_count: 3 }), NOW))
      .toBe('sent AUG 10 · viewed 5h ago · 3 views');
    expect(statusLineOf(prop({ status: 'viewed', last_viewed_at: hoursAgo(1), view_count: 1 }), NOW)).toBe('sent 2d ago · viewed 1h ago · 1 view');
  });
  test('modified: the sent time and "modified", with no time and no "by client"', () => {
    const line = statusLineOf(prop({ status: 'modified', updated_at: hoursAgo(1) }), NOW);
    expect(line).toBe('sent 2d ago · modified');
    expect(line).not.toMatch(/client|1h/);
  });
  test('accepted: awaiting deposit, or the money on the row; the time is accepted_at, else client_signed_at', () => {
    expect(statusLineOf(prop({ status: 'accepted', accepted_at: hoursAgo(6) }), NOW)).toBe('accepted 6h ago · awaiting deposit');
    expect(statusLineOf(prop({ status: 'accepted', accepted_at: hoursAgo(6), amount_paid: '500.00' }), NOW)).toBe('accepted 6h ago · $500.00 paid');
    expect(statusLineOf(prop({ status: 'accepted', accepted_at: null, client_signed_at: hoursAgo(26) }), NOW)).toBe('accepted 1d ago · awaiting deposit');
    expect(statusLineOf(prop({ status: 'accepted' }), NOW)).toBe('accepted · awaiting deposit');
  });
  test('an age under 7 days, the date beyond', () => {
    expect(statusLineOf(prop({ sent_at: hoursAgo(6 * 24) }), NOW)).toBe('sent 6d ago · not opened yet');
    expect(statusLineOf(prop({ sent_at: hoursAgo(9 * 24) }), NOW)).toBe('sent OCT 5 · not opened yet');
  });
  test('archived: the reason in the desktop words', () => {
    expect(statusLineOf(prop({ status: 'archived', archive_reason: 'client_cancelled' }), NOW)).toBe('archived · Client cancelled');
    expect(statusLineOf(prop({ status: 'archived', archive_reason: null }), NOW)).toBe('archived');
  });
});

describe('archiveReasonLabel', () => {
  test('every stored reason reads as the desktop writes it', () => {
    expect(['no_hire', 'client_cancelled', 'we_cancelled', 'event_completed', 'option_not_chosen', 'event_passed', 'other'].map(archiveReasonLabel))
      .toEqual(['No hire', 'Client cancelled', 'We cancelled', 'Event completed', 'Option not chosen', 'Event passed', 'Other']);
    expect(archiveReasonLabel('nonsense')).toBe('');
  });
});

describe('chipOf and the header', () => {
  test('the chip comes from the shared status map', () => {
    expect(chipOf(prop({ status: 'modified' }))).toEqual({ label: 'Modified', kind: 'violet' });
    expect(chipOf(prop({ status: 'archived' }))).toEqual({ label: 'Archived', kind: 'neutral' });
  });
  test('the header keeps the client and the kind apart, with a fallback name', () => {
    expect(proposalHeaderOf(prop())).toEqual(expect.objectContaining({ title: 'Test Client', kind: 'Wedding Reception', guests: 120 }));
    expect(proposalHeaderOf(prop({ client_name: '  ' })).title).toBe('Unnamed client');
  });
});

describe('proposalContactsOf', () => {
  test('the phone dials and the email writes, and no Text link is offered', () => {
    const c = proposalContactsOf(prop({ client_phone: '3125550100', client_email: 'client41@example.test' }));
    expect(c.client.telHref).toBe('tel:3125550100');
    expect(c.client.mailHref).toBe('mailto:client41@example.test');
    expect(c.client.smsHref).toBeNull();
  });
});

describe('packageOf', () => {
  test("the stored snapshot's lines, a client-hidden line tagged, and the row's total", () => {
    const pkg = packageOf(prop({
      total_price: '4860.00',
      pricing_snapshot: {
        total: 4860,
        breakdown: [{ label: 'Signature bar', amount: 4900 }, { label: 'Test hidden discount', amount: -40, visible: false }],
        adjustments: [{ type: 'discount', label: 'Test hidden discount', amount: 40, visible: false }],
      },
    }));
    expect(pkg.lines).toEqual([
      { label: 'Signature bar', amount: '$4,900.00' },
      // A discount keeps its minus sign (U+2212), so it never reads as a charge.
      { label: 'Test hidden discount', amount: `${String.fromCharCode(0x2212)}$40.00`, hidden: true },
    ]);
    expect(pkg.total).toBe('$4,860.00');
  });
  test('a snapshot with no breakdown is one package line at the total', () => {
    const pkg = packageOf(prop({ pricing_snapshot: null, package_name: 'Classic bar', total_price: '2010.00' }));
    expect(pkg.lines).toEqual([{ label: 'Classic bar', amount: '$2,010.00' }]);
    expect(pkg.total).toBe('$2,010.00');
  });
});

describe('clientLinkOf', () => {
  test("the desktop's URL, shown as the host, the path and six characters of the token", () => {
    expect(clientLinkOf(prop(), 'https://drbartender.com')).toEqual({
      url: `https://drbartender.com/proposal/${TOKEN}`, text: 'drbartender.com/proposal/8k2f4a',
      host: 'drbartender.com', path: '/proposal/8k2f4a',
    });
    expect(clientLinkOf(prop()).url).toBe(`${PUBLIC_SITE_URL}/proposal/${TOKEN}`);
  });
  test('a draft is not sent yet and has no link', () => {
    expect(clientLinkOf(prop({ status: 'draft' }))).toEqual({ url: null, text: 'not sent yet', host: '', path: '' });
  });
});

describe('gatesOf', () => {
  test('a booked status routes to the event, and nothing else does', () => {
    for (const status of BOOKED_STATUSES) expect(bookedTarget(prop({ status }))).toBe('/events/41');
    for (const status of ['draft', 'sent', 'viewed', 'modified', 'accepted', 'archived']) expect(bookedTarget(prop({ status }))).toBeNull();
  });
  test('sent, viewed and accepted offer Resend proposal; draft and modified Send proposal; both open desktop view', () => {
    for (const status of ['sent', 'viewed', 'accepted']) expect(gatesOf(prop({ status })).send).toEqual({ label: 'Resend proposal', mode: 'desktop' });
    for (const status of ['draft', 'modified']) expect(gatesOf(prop({ status })).send).toEqual({ label: 'Send proposal', mode: 'desktop' });
  });
  test('an options group keeps desktop view, and its first send reads Send options', () => {
    const g = gatesOf(prop({ group_id: 7 }));
    expect(g.grouped).toBe(true);
    expect(g.send).toEqual({ label: 'Resend proposal', mode: 'desktop' });
    expect(g.edit.mode).toBe('desktop');
    for (const status of ['draft', 'modified']) expect(gatesOf(prop({ status, group_id: 7 })).send).toEqual({ label: 'Send options', mode: 'desktop' });
    expect(gatesOf(prop()).grouped).toBe(false);
  });
  test('only the five open statuses offer Edit details and the Client link', () => {
    for (const status of ['declined', 'something_new', undefined]) {
      expect(gatesOf(prop({ status }))).toEqual(expect.objectContaining({ send: null, archive: null, edit: null, link: null }));
    }
  });
  test('Archive for the five open statuses with nothing paid, absent with money on the row', () => {
    for (const status of ['draft', 'sent', 'viewed', 'modified', 'accepted']) expect(gatesOf(prop({ status })).archive).toEqual({ label: 'Archive', mode: 'desktop' });
    expect(gatesOf(prop({ status: 'accepted', amount_paid: '0.01' })).archive).toBeNull();
  });
  test('archived is read-only: no action, no Edit details, no link', () => {
    const g = gatesOf(prop({ status: 'archived', archive_reason: 'no_hire' }));
    expect(g).toEqual(expect.objectContaining({ archived: true, send: null, archive: null, edit: null, link: null }));
  });
  test('legal hold offers nothing that writes or sends, and fails closed', () => {
    const held = gatesOf(prop({ legal_hold: true }));
    expect(held).toEqual(expect.objectContaining({ held: true, send: null, archive: null, edit: null, link: null }));
    // Only an explicit false reads as no hold.
    expect(gatesOf(prop({ legal_hold: undefined })).held).toBe(true);
    expect(gatesOf(prop({ legal_hold: null })).send).toBeNull();
    expect(gatesOf(prop()).held).toBe(false);
  });
  test('a stored copy: every acting row needs a connection, and the Client link still works', () => {
    const g = gatesOf(prop(), { stale: true });
    expect(g.send.mode).toBe('offline');
    expect(g.archive.mode).toBe('offline');
    expect(g.edit.mode).toBe('offline');
    expect(g.link.url).toContain(`/proposal/${TOKEN}`);
  });
  test('no gate offers a Send reminder', () => {
    expect(Object.keys(gatesOf(prop()))).not.toContain('remind');
  });
});
