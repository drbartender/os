import { profileSaveBody } from './helpers';

const SEED = { routing_number: '****0015', account_number: '****3456' };

test('an untouched masked bank field is left out of the save', () => {
  const body = profileSaveBody({ phone: '(312) 555-0100', ...SEED }, SEED);
  expect(body).toEqual({ phone: '(312) 555-0100' });
});

test('a bank box that was blank when the page opened is left out, not sent as a clear', () => {
  // The staffer may have saved numbers after the admin opened the page.
  const body = profileSaveBody({ hourly_rate: '25', routing_number: '', account_number: '' }, { routing_number: '', account_number: '' });
  expect(body).toEqual({ hourly_rate: '25' });
});

test('an edited or deliberately emptied bank box is sent', () => {
  const body = profileSaveBody({ routing_number: '021000021', account_number: '' }, SEED);
  expect(body).toEqual({ routing_number: '021000021', account_number: '' });
});

test('the edit form itself is not changed', () => {
  const form = { phone: 'x', ...SEED };
  profileSaveBody(form, SEED);
  expect(form).toEqual({ phone: 'x', ...SEED });
});
