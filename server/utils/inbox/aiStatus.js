'use strict';

// PLACEHOLDER, owned by lane inbox-engine until lane inbox-ai (C2) Task 21
// replaces this file with the real status: 'off' with no ANTHROPIC_API_KEY,
// 'paused' at the daily cap, 'failing' at 3 or more error reads in the last
// hour, else 'on'. Until that lane lands nothing reads anything, so the honest
// answer is 'off'. getInbox calls this on every request (agreed interface).

const { pool } = require('../../db');

function aiReadStatus(db = pool) {
  void db;
  return Promise.resolve('off');
}

module.exports = { aiReadStatus };
