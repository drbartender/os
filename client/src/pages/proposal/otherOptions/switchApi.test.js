// Task 5's own checkpoint: the switch call's error taxonomy.
//
// This is the seam where a money write meets an unreliable network, and each
// branch means something different to the caller: committed, prices moved,
// a guard said no, or WE DO NOT KNOW. Conflating the last two is how a client
// ends up told "that failed" about a switch that actually landed.

import { postSwitch, SWITCH_CONFLICT } from './switchApi';

// utils/api.js calls axios.create() and registers interceptors at import time,
// and switchApi imports API_BASE_URL from it, so a bare jest.mock('axios')
// blanks create() and the whole suite dies before a single test runs.
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
    create: () => ({
      interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
    }),
  },
  post: jest.fn(),
  create: () => ({
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
  }),
}));
// eslint-disable-next-line global-require
const axios = require('axios').default;

const BODY = { package_id: 1, tier_addon_id: null, extra_addon_ids: [], acknowledged_total: 100 };

beforeEach(() => { jest.resetAllMocks(); });

test('a committed switch returns the fresh payload', async () => {
  axios.post.mockResolvedValue({ data: { id: 7, total_price: 1234 } });
  const r = await postSwitch('tok', BODY);
  expect(r.ok).toBe(true);
  expect(r.payload.total_price).toBe(1234);
});

test('a 409 is a CONFLICT carrying the fresh quote, not a refusal', async () => {
  axios.post.mockRejectedValue({
    response: { status: 409, data: { code: SWITCH_CONFLICT, error: 'moved', quote: { comparable: true } } },
  });
  const r = await postSwitch('tok', BODY);
  expect(r.conflict).toBe(true);
  expect(r.refused).toBeUndefined();
  expect(r.quote).toEqual({ comparable: true });
});

test('a 409 WITHOUT the conflict code is a refusal, not a reprice', async () => {
  // Guard 409s exist too (PAYMENT_IN_FLIGHT). Treating one as a reprice would
  // show a client "confirm at $X" for a switch the server will never accept.
  axios.post.mockRejectedValue({
    response: { status: 409, data: { code: 'PAYMENT_IN_FLIGHT', error: 'A payment is already in progress.' } },
  });
  const r = await postSwitch('tok', BODY);
  expect(r.refused).toBe(true);
  expect(r.conflict).toBeUndefined();
  expect(r.error).toMatch(/already in progress/);
});

test('a guard refusal surfaces the server message', async () => {
  axios.post.mockRejectedValue({
    response: { status: 400, data: { error: 'This proposal can no longer be changed online.' } },
  });
  const r = await postSwitch('tok', BODY);
  expect(r.refused).toBe(true);
  expect(r.error).toMatch(/no longer be changed/);
});

test('a refusal with no message still says something a human wrote', async () => {
  axios.post.mockRejectedValue({ response: { status: 500, data: {} } });
  const r = await postSwitch('tok', BODY);
  expect(r.refused).toBe(true);
  expect(r.error).toBeTruthy();
});

test('NO RESPONSE is its own case: unknown, never refused', async () => {
  // A timeout means the write may well have landed. Reporting it as a refusal
  // would tell the client nothing changed while their proposal quietly did.
  axios.post.mockRejectedValue(new Error('Network Error'));
  const r = await postSwitch('tok', BODY);
  expect(r.unknown).toBe(true);
  expect(r.refused).toBeUndefined();
  expect(r.ok).toBe(false);
});

test('the body is passed through untouched, and the total is never recomputed here', async () => {
  axios.post.mockResolvedValue({ data: {} });
  await postSwitch('tok', BODY);
  const [, sent] = axios.post.mock.calls[0];
  expect(sent).toEqual(BODY);
});
