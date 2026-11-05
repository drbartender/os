// server/routes/proposals/pricingInputs.test.js
'use strict';
// Pure tests for the shared pricing-input gate (audit PRC-05): no DB, a
// function of the body alone. The route half, 400s naming the field through
// the real create, PATCH and /calculate handlers, is crud.pricingInputs.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertPricingInputs, MAX_GUESTS, MAX_BARS, MAX_BARTENDERS, MAX_HOURS } = require('./pricingInputs');
const { MIN_HOURS } = require('../../utils/contractDuration');

function refused(body, opts) {
  let caught = null;
  try { assertPricingInputs(body, opts); } catch (e) { caught = e; }
  assert.ok(caught, `expected a refusal for ${JSON.stringify(body)}`);
  assert.equal(caught.statusCode, 400);
  return caught.fieldErrors;
}

test('absent and null inputs pass: each route keeps its own default or stored value', () => {
  assert.doesNotThrow(() => assertPricingInputs({}));
  assert.doesNotThrow(() => assertPricingInputs(undefined));
  assert.doesNotThrow(() => assertPricingInputs({ guest_count: null, num_bars: null, num_bartenders: null, event_duration_hours: null }));
  assert.doesNotThrow(() => assertPricingInputs({ venue_name: 'Test Hall', adjustments: [] }));
});

test('whole numbers in bounds pass, as numbers and as the numeric strings the routes read with Number()', () => {
  for (const guest_count of [1, 50, MAX_GUESTS, '75', ' 80 ']) assert.doesNotThrow(() => assertPricingInputs({ guest_count }), String(guest_count));
  for (const num_bars of [0, 1, MAX_BARS, '2']) assert.doesNotThrow(() => assertPricingInputs({ num_bars }), String(num_bars));
  for (const num_bartenders of [0, 1, 3, MAX_BARTENDERS, '2']) assert.doesNotThrow(() => assertPricingInputs({ num_bartenders }), String(num_bartenders));
  for (const event_duration_hours of [MIN_HOURS, 1, 4, 4.5, 5.1, '4.0', '5.5', MAX_HOURS]) {
    assert.doesNotThrow(() => assertPricingInputs({ event_duration_hours }), String(event_duration_hours));
  }
});

test('a guest count that is zero, negative, fractional, past the bound or not a number is refused naming guest_count', () => {
  for (const guest_count of [0, -1, -50, 1.5, MAX_GUESTS + 1, 'abc', '', true, {}, [], NaN, Infinity]) {
    const fe = refused({ guest_count });
    assert.deepEqual(Object.keys(fe), ['guest_count'], String(guest_count));
    assert.match(fe.guest_count, /whole number from 1 to 1000/);
  }
});

test('a negative, fractional or oversized bar count is refused naming num_bars; zero passes', () => {
  for (const num_bars of [-1, 0.5, MAX_BARS + 1, 'x', true]) {
    assert.deepEqual(Object.keys(refused({ num_bars })), ['num_bars'], String(num_bars));
  }
  assert.doesNotThrow(() => assertPricingInputs({ num_bars: 0 }));
});

test('a fractional, negative or oversized bartender count is refused naming num_bartenders; absent re-derives', () => {
  for (const num_bartenders of [1.5, -1, MAX_BARTENDERS + 1, '2.5', 'two']) {
    const fe = refused({ num_bartenders });
    assert.deepEqual(Object.keys(fe), ['num_bartenders'], String(num_bartenders));
  }
  assert.doesNotThrow(() => assertPricingInputs({ num_bartenders: undefined }));
});

test('a duration below the contract floor, above a day, off the tenths grid or not a number is refused', () => {
  for (const event_duration_hours of [0, -4, 0.4, 4.25, 4.33, MAX_HOURS + 0.1, 'abc', '', true]) {
    const fe = refused({ event_duration_hours });
    assert.deepEqual(Object.keys(fe), ['event_duration_hours'], String(event_duration_hours));
    assert.match(fe.event_duration_hours, /tenths of an hour/);
  }
});

test('the /calculate preview reads duration_hours and its refusal names that field', () => {
  assert.deepEqual(Object.keys(refused({ duration_hours: 4.25 }, { durationField: 'duration_hours' })), ['duration_hours']);
  assert.doesNotThrow(() => assertPricingInputs({ duration_hours: 4.5 }, { durationField: 'duration_hours' }));
  // Under that option event_duration_hours is not the preview's field and is not read.
  assert.doesNotThrow(() => assertPricingInputs({ event_duration_hours: -1 }, { durationField: 'duration_hours' }));
});

test('every bad field is named in one refusal', () => {
  const fe = refused({ guest_count: -50, num_bars: -1, num_bartenders: 1.5, event_duration_hours: 4.25 });
  assert.deepEqual(Object.keys(fe).sort(), ['event_duration_hours', 'guest_count', 'num_bars', 'num_bartenders']);
});
