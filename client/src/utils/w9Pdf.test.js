import { TextEncoder, TextDecoder } from 'util';
import { EMPTY_W9, validateW9, buildW9File } from './w9Pdf';

// jsPDF needs these and jsdom has neither; the browser does.
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

const COMPLETE = {
  ...EMPTY_W9,
  name: 'Test Recruit',
  address: '100 Example St',
  city: 'Chicago',
  state: 'IL',
  zip: '60601',
  ssn1: '000',
  ssn2: '00',
  ssn3: '0000',
  signatureData: 'Test Recruit',
  signatureMethod: 'type',
};

test('a complete form has no errors', () => {
  expect(validateW9(COMPLETE)).toEqual({});
});

test('an empty form names every required field, each under its own key', () => {
  const errors = validateW9(EMPTY_W9);
  expect(Object.keys(errors).sort()).toEqual(
    ['address', 'city', 'name', 'signature', 'ssn', 'state', 'zip'].sort()
  );
});

test.each([
  ['name', { name: '   ' }],
  ['address', { address: '' }],
  ['city', { city: '' }],
  ['state', { state: '' }],
  ['zip', { zip: '' }],
  ['signature', { signatureData: '' }],
])('a missing %s is reported under that key alone', (key, change) => {
  expect(Object.keys(validateW9({ ...COMPLETE, ...change }))).toEqual([key]);
});

test('the SSN must be 3, 2 and 4 digits', () => {
  expect(validateW9({ ...COMPLETE, ssn3: '' }).ssn).toMatch(/required/);
  expect(validateW9({ ...COMPLETE, ssn1: '00' }).ssn).toMatch(/XXX-XX-XXXX/);
  expect(validateW9({ ...COMPLETE, ssn2: 'ab' }).ssn).toMatch(/XXX-XX-XXXX/);
});

test('with an EIN, the SSN is not asked for and the EIN is', () => {
  const ein = { ...COMPLETE, use_ein: true, ssn1: '', ssn2: '', ssn3: '' };
  expect(validateW9(ein)).toEqual({ ein: 'Employer Identification Number is required.' });
  expect(validateW9({ ...ein, ein: '00-0000000' })).toEqual({});
});

test('the builder returns a named PDF file', async () => {
  const file = await buildW9File(COMPLETE);
  expect(file.type).toBe('application/pdf');
  expect(file.name).toMatch(/^W9_Test_Recruit_\d+\.pdf$/);
  expect(file.size).toBeGreaterThan(0);
});
