import '@testing-library/jest-dom';
import { offlineGet, OFFLINE_OK_HEADER } from './offlineRead';
import api from './api';

jest.mock('./api', () => ({ __esModule: true, default: { get: jest.fn() } }));

beforeEach(() => { api.get.mockResolvedValue({ data: { ok: true }, staleAt: '2026-09-29T17:00:00.000Z' }); });

test('adds the opt-in header and passes the response through untouched', async () => {
  const res = await offlineGet('/shifts/detail/17');
  expect(api.get).toHaveBeenCalledWith('/shifts/detail/17', { headers: { 'X-Offline-Ok': '1' } });
  expect(res).toEqual({ data: { ok: true }, staleAt: '2026-09-29T17:00:00.000Z' });
  expect(OFFLINE_OK_HEADER).toBe('X-Offline-Ok');
});

test('keeps the params and any other header the caller passed', async () => {
  await offlineGet('/shifts', { params: { scope: 'past' }, headers: { 'X-Other': 'a' } });
  expect(api.get).toHaveBeenCalledWith('/shifts', {
    params: { scope: 'past' },
    headers: { 'X-Other': 'a', 'X-Offline-Ok': '1' },
  });
});

test('never mutates the config it was given', async () => {
  const config = { params: { scope: 'past' } };
  await offlineGet('/shifts', config);
  expect(config).toEqual({ params: { scope: 'past' } });
});

test('a rejection passes through', async () => {
  api.get.mockRejectedValue({ status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' });
  await expect(offlineGet('/shifts')).rejects.toEqual({ status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' });
});
