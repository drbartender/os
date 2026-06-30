'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parsePositionsNeeded, rosterCounts } = require('./positionsNeeded');

test('parses flat string array (JSON string)', () => {
  assert.deepEqual(
    parsePositionsNeeded('["Bartender","Bartender","Banquet Server"]'),
    ['Bartender', 'Bartender', 'Banquet Server'],
  );
});

test('parses flat string array (already an array)', () => {
  assert.deepEqual(
    parsePositionsNeeded(['Bartender', 'Server']),
    ['Bartender', 'Banquet Server'],
  );
});

test('parses legacy object array and canonicalizes + expands by count', () => {
  assert.deepEqual(
    parsePositionsNeeded([{ position: 'bartender', count: 2 }, { position: 'Server', count: 1 }]),
    ['Bartender', 'Bartender', 'Banquet Server'],
  );
});

test('malformed -> []', () => {
  assert.deepEqual(parsePositionsNeeded('not json'), []);
  assert.deepEqual(parsePositionsNeeded(null), []);
  assert.deepEqual(parsePositionsNeeded(42), []);
  assert.deepEqual(parsePositionsNeeded('{}'), []);
});

test('drops unknown roles', () => {
  assert.deepEqual(parsePositionsNeeded(['Bartender', 'Chef']), ['Bartender']);
});

test('rosterCounts tallies per role', () => {
  assert.deepEqual(
    rosterCounts(['Bartender', 'Bartender', 'Banquet Server']),
    { Bartender: 2, 'Banquet Server': 1 },
  );
  assert.deepEqual(rosterCounts([]), {});
});
