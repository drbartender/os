'use strict';
// Calendar feed URL base tests: the feed link takes its origin from
// utils/urls.js, so API_URL wins over RENDER_EXTERNAL_URL as it does for every
// other backend-hosted link. Pure: a stubbed pool, the real router over HTTP.

require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'calendar-feed-url-test-secret-0123456789abcdef';
// Both set, as on Render when ops pins API_URL: the override must win.
process.env.API_URL = 'https://api.override.example.com';
process.env.RENDER_EXTERNAL_URL = 'https://render-default.example.com';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');

const USER = {
  id: 1, email: 'feed-url@example.com', role: 'admin', onboarding_status: 'approved',
  calendar_token: crypto.randomUUID(), can_hire: false, can_staff: false,
  token_version: 0, pre_hired: false, presence_lead_rank: null,
};
const realQuery = pool.query;
let server;
let baseUrl;

function get(p, method = 'GET') {
  const token = jwt.sign({ userId: USER.id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  return new Promise((resolve, reject) => {
    const r = http.request(new URL(p, baseUrl), { method, headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    r.on('error', reject);
    r.end();
  });
}

before(async () => {
  pool.query = async (text) => {
    const t = String(text).replace(/\s+/g, ' ');
    if (t.includes('FROM users WHERE id = $1') || t.includes('RETURNING calendar_token')) {
      return { rows: [USER], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const app = express();
  app.use('/api/calendar', require('./calendar'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  pool.query = realQuery;
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('GET /token builds the feed URL on API_URL, not RENDER_EXTERNAL_URL', async () => {
  const res = await get('/api/calendar/token');
  assert.equal(res.status, 200);
  assert.equal(res.body.feed_url, `https://api.override.example.com/api/calendar/feed/${USER.calendar_token}`);
});

test('POST /token/regenerate builds the feed URL on API_URL too', async () => {
  const res = await get('/api/calendar/token/regenerate', 'POST');
  assert.equal(res.status, 200);
  assert.ok(res.body.feed_url.startsWith('https://api.override.example.com/api/calendar/feed/'), res.body.feed_url);
});
