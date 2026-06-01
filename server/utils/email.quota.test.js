require('dotenv').config();

// Unit tests for the Resend quota/rate-limit detector in utils/email.js. A quota
// rejection must be classified as retryable (→ QuotaExceededError → dispatcher
// defers the row) rather than a hard failure that drops the notification.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isQuotaError } = require('./email');

test('isQuotaError > true for the daily-quota message Resend returns', () => {
  assert.equal(isQuotaError({ message: 'You have reached your daily email sending quota.' }), true);
});

test('isQuotaError > true for an HTTP 429', () => {
  assert.equal(isQuotaError({ statusCode: 429, message: 'Too Many Requests' }), true);
  assert.equal(isQuotaError({ status: 429 }), true);
});

test('isQuotaError > true for a rate_limit_exceeded error name', () => {
  assert.equal(isQuotaError({ name: 'rate_limit_exceeded', message: 'slow down' }), true);
});

test('isQuotaError > false for an unrelated send error', () => {
  assert.equal(isQuotaError({ message: 'The `to` field is invalid.' }), false);
  assert.equal(isQuotaError({ name: 'validation_error', message: 'bad request' }), false);
});

test('isQuotaError > false for null / undefined', () => {
  assert.equal(isQuotaError(null), false);
  assert.equal(isQuotaError(undefined), false);
});
