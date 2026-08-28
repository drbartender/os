import { pollPaymentState } from './settlePoll';

const noSleep = () => Promise.resolve();
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

test('settles on the first paid state and sleeps only between attempts', async () => {
  const seq = [
    { status: 'accepted', amount_paid: 0, total_price: 350 },
    { status: 'accepted', amount_paid: 0, total_price: 350 },
    { status: 'balance_paid', amount_paid: 550, total_price: 550 },
  ];
  let calls = 0;
  const sleeps = [];
  const out = await pollPaymentState({ fetchState: async () => seq[calls++], sleep: async (ms) => { sleeps.push(ms); } });
  expect(out).toEqual({ state: seq[2], reason: 'settled' });
  expect(calls).toBe(3);
  expect(sleeps).toEqual([1500, 1500]);
});

test('exhausts after the attempt budget, with one fewer sleep than attempts', async () => {
  let calls = 0;
  let sleeps = 0;
  const out = await pollPaymentState({
    fetchState: async () => { calls++; return { status: 'accepted' }; },
    sleep: async () => { sleeps++; },
  });
  expect(out).toEqual({ state: null, reason: 'exhausted' });
  expect(calls).toBe(13);
  expect(sleeps).toBe(12);
});

test('a 5xx or a network error is a transient miss, not an abort', async () => {
  let calls = 0;
  const out = await pollPaymentState({
    fetchState: async () => {
      calls++;
      if (calls === 1) throw httpError(502);
      if (calls === 2) throw new Error('network');
      return { status: 'deposit_paid' };
    },
    sleep: noSleep,
  });
  expect(out.reason).toBe('settled');
  expect(calls).toBe(3);
});

test('any 4xx stops the poll at once as blocked', async () => {
  for (const status of [404, 410, 429]) {
    let calls = 0;
    const out = await pollPaymentState({ fetchState: async () => { calls++; throw httpError(status); }, sleep: noSleep });
    expect(out).toEqual({ state: null, reason: 'blocked' });
    expect(calls).toBe(1);
  }
});

test('a 4xx carried as err.status (no response) is blocked too', async () => {
  let calls = 0;
  const out = await pollPaymentState({
    fetchState: async () => { calls++; throw Object.assign(new Error('429'), { status: 429 }); },
    sleep: noSleep,
  });
  expect(out).toEqual({ state: null, reason: 'blocked' });
  expect(calls).toBe(1);
});

test('does not fetch at all when already cancelled', async () => {
  let calls = 0;
  let sleeps = 0;
  const out = await pollPaymentState({
    fetchState: async () => { calls++; return { status: 'accepted' }; },
    sleep: async () => { sleeps++; },
    isCancelled: () => true,
  });
  expect(out).toEqual({ state: null, reason: 'cancelled' });
  // A cancel that is already true must be seen before the first fetch, not after it.
  expect(calls).toBe(0);
  expect(sleeps).toBe(0);
});

test('stops early when cancelled, without buying another interval', async () => {
  let calls = 0;
  let sleeps = 0;
  let cancelled = false;
  const out = await pollPaymentState({
    fetchState: async () => { calls++; cancelled = true; return { status: 'accepted' }; },
    sleep: async () => { sleeps++; },
    isCancelled: () => cancelled,
  });
  expect(out.reason).toBe('cancelled');
  expect(calls).toBe(1);
  // A cancel that arrives mid-fetch must be seen before the sleep, not after it.
  expect(sleeps).toBe(0);
});

test('attempts and interval are configurable', async () => {
  let calls = 0;
  const sleeps = [];
  await pollPaymentState({ fetchState: async () => { calls++; return { status: 'viewed' }; }, attempts: 3, intervalMs: 10, sleep: async (ms) => { sleeps.push(ms); } });
  expect(calls).toBe(3);
  expect(sleeps).toEqual([10, 10]);
});
