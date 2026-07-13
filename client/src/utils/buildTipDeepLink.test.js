import { buildTipDeepLink } from './buildTipDeepLink';

describe('buildTipDeepLink', () => {
  describe('venmo', () => {
    test('handle present → profile URL (amount ignored)', () => {
      expect(buildTipDeepLink({ kind: 'venmo', handles: { venmo_handle: 'dallas' } }))
        .toBe('https://venmo.com/u/dallas');
      expect(buildTipDeepLink({ kind: 'venmo', handles: { venmo_handle: 'dallas' }, amount: 25 }))
        .toBe('https://venmo.com/u/dallas');
    });

    test('handle is URL-encoded', () => {
      expect(buildTipDeepLink({ kind: 'venmo', handles: { venmo_handle: 'a b' } }))
        .toBe('https://venmo.com/u/a%20b');
    });

    test('missing handle → null', () => {
      expect(buildTipDeepLink({ kind: 'venmo', handles: {} })).toBeNull();
      expect(buildTipDeepLink({ kind: 'venmo', handles: { venmo_handle: '' } })).toBeNull();
    });
  });

  describe('cashapp', () => {
    test('no amount → cashtag URL', () => {
      expect(buildTipDeepLink({ kind: 'cashapp', handles: { cashapp_handle: 'dallas' } }))
        .toBe('https://cash.app/$dallas');
    });

    test('positive amount is injected into the path', () => {
      expect(buildTipDeepLink({ kind: 'cashapp', handles: { cashapp_handle: 'dallas' }, amount: 25 }))
        .toBe('https://cash.app/$dallas/25');
    });

    test('zero / non-positive amount is not injected', () => {
      expect(buildTipDeepLink({ kind: 'cashapp', handles: { cashapp_handle: 'dallas' }, amount: 0 }))
        .toBe('https://cash.app/$dallas');
      expect(buildTipDeepLink({ kind: 'cashapp', handles: { cashapp_handle: 'dallas' }, amount: -5 }))
        .toBe('https://cash.app/$dallas');
    });

    test('non-numeric amount is not injected', () => {
      expect(buildTipDeepLink({ kind: 'cashapp', handles: { cashapp_handle: 'dallas' }, amount: 'abc' }))
        .toBe('https://cash.app/$dallas');
    });

    test('handle is URL-encoded', () => {
      expect(buildTipDeepLink({ kind: 'cashapp', handles: { cashapp_handle: 'a b' } }))
        .toBe('https://cash.app/$a%20b');
    });

    test('missing handle → null', () => {
      expect(buildTipDeepLink({ kind: 'cashapp', handles: {} })).toBeNull();
      expect(buildTipDeepLink({ kind: 'cashapp', handles: { cashapp_handle: '' } })).toBeNull();
    });
  });

  describe('paypal', () => {
    test('bare username → paypal.me/username', () => {
      expect(buildTipDeepLink({ kind: 'paypal', handles: { paypal_url: 'dallas' } }))
        .toBe('https://paypal.me/dallas');
    });

    test('already a paypal.me path is preserved', () => {
      expect(buildTipDeepLink({ kind: 'paypal', handles: { paypal_url: 'paypal.me/dallas' } }))
        .toBe('https://paypal.me/dallas');
    });

    test('strips http(s):// scheme', () => {
      expect(buildTipDeepLink({ kind: 'paypal', handles: { paypal_url: 'https://paypal.me/dallas' } }))
        .toBe('https://paypal.me/dallas');
      expect(buildTipDeepLink({ kind: 'paypal', handles: { paypal_url: 'http://paypal.me/dallas' } }))
        .toBe('https://paypal.me/dallas');
    });

    test('strips a www. prefix', () => {
      expect(buildTipDeepLink({ kind: 'paypal', handles: { paypal_url: 'https://www.paypal.me/dallas' } }))
        .toBe('https://paypal.me/dallas');
      expect(buildTipDeepLink({ kind: 'paypal', handles: { paypal_url: 'www.paypal.me/dallas' } }))
        .toBe('https://paypal.me/dallas');
    });

    test('trims trailing slashes', () => {
      expect(buildTipDeepLink({ kind: 'paypal', handles: { paypal_url: 'https://paypal.me/dallas/' } }))
        .toBe('https://paypal.me/dallas');
      expect(buildTipDeepLink({ kind: 'paypal', handles: { paypal_url: 'paypal.me/dallas///' } }))
        .toBe('https://paypal.me/dallas');
    });

    test('positive amount is appended', () => {
      expect(buildTipDeepLink({ kind: 'paypal', handles: { paypal_url: 'dallas' }, amount: 25 }))
        .toBe('https://paypal.me/dallas/25');
      expect(buildTipDeepLink({ kind: 'paypal', handles: { paypal_url: 'https://www.paypal.me/dallas/' }, amount: 25 }))
        .toBe('https://paypal.me/dallas/25');
    });

    test('zero / non-positive amount is not appended', () => {
      expect(buildTipDeepLink({ kind: 'paypal', handles: { paypal_url: 'dallas' }, amount: 0 }))
        .toBe('https://paypal.me/dallas');
    });

    test('missing url → null', () => {
      expect(buildTipDeepLink({ kind: 'paypal', handles: {} })).toBeNull();
      expect(buildTipDeepLink({ kind: 'paypal', handles: { paypal_url: '' } })).toBeNull();
    });
  });

  describe('card (Stripe)', () => {
    test('link present → the raw Stripe payment link (amount ignored)', () => {
      expect(buildTipDeepLink({
        kind: 'card',
        handles: { stripe_payment_link_url: 'https://buy.stripe.com/abc123' },
        amount: 25,
      })).toBe('https://buy.stripe.com/abc123');
    });

    test('missing link → null', () => {
      expect(buildTipDeepLink({ kind: 'card', handles: {} })).toBeNull();
      expect(buildTipDeepLink({ kind: 'card', handles: { stripe_payment_link_url: '' } })).toBeNull();
    });
  });

  describe('zelle', () => {
    test('always null (no universal deep link)', () => {
      expect(buildTipDeepLink({ kind: 'zelle', handles: { zelle_handle: 'dallas@example.com' } }))
        .toBeNull();
      expect(buildTipDeepLink({ kind: 'zelle', handles: {} })).toBeNull();
    });
  });

  test('unknown kind → null', () => {
    expect(buildTipDeepLink({ kind: 'bitcoin', handles: { venmo_handle: 'dallas' } })).toBeNull();
  });
});
