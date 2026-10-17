'use strict';
// Pieces the override conversion scripts share (plan
// 2026-10-16-price-override-removal, Tasks V1-V4).

const fs = require('fs');
const path = require('path');
const { BRANCH_PREFIX } = require('./branch');
const { isLegalHold } = require('../../server/utils/legalHold');
const { isWholeCents } = require('../../server/utils/adjustmentRules');

// The guard every block checks and the export records: an md5 of the money
// columns, never updated_at (a client page view moves it). One text, used
// verbatim by the export, the fresh compute and both blocks.
const MONEY_MD5_EXPR = 'md5(row(total_price, amount_paid, status, total_price_override, adjustments, pricing_snapshot)::text)';

const TERMINAL_STATUSES = Object.freeze(['archived', 'completed']);
const hasOverride = (row) => row.total_price_override !== null && row.total_price_override !== undefined;
const isLiveOverride = (row) => hasOverride(row) && !TERMINAL_STATUSES.includes(row.status);

// Ids the conversion must never touch: the legal-hold seam (which reads
// LEGAL_HOLD_PROPOSAL_IDS and fails closed) plus any extra ids a caller adds
// (the rehearsal's synthetic hold). Extra ids only ever ADD to the refusal.
function heldCheck(extraIds = []) {
  const extra = (extraIds || []).map(Number);
  if (extra.some((n) => !Number.isSafeInteger(n) || n < 1)) throw new Error('held ids must be positive integers');
  return (id) => isLegalHold(id) || extra.includes(Number(id));
}

function parseIdList(text) {
  if (!text) return [];
  return String(text).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    if (!/^[0-9]+$/.test(s)) throw new Error(`not an id: ${s}`);
    return Number(s);
  });
}

// Integer cents of a money value the SQL blocks can read the same way: a
// finite JSON number or a plain decimal string, in whole cents. null for a
// missing value (null or undefined), NaN for anything else.
const PLAIN_DECIMAL = /^\s*-?[0-9]+(\.[0-9]+)?\s*$/;
function moneyCents(v) {
  if (v === null || v === undefined) return null;
  let n = NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && PLAIN_DECIMAL.test(v)) n = Number(v);
  if (!Number.isFinite(n) || !isWholeCents(n)) return NaN;
  return Math.round(n * 100);
}

// Only a URI file branch.js wrote (its name keeps the conversion prefix), so no
// tool here can be pointed at a hand-made URI, prod's own above all.
function readUriFile(file) {
  if (!file) throw new Error('name the URI file branch.js wrote');
  if (!path.basename(file).startsWith(BRANCH_PREFIX)) throw new Error(`${file} is not a URI file branch.js wrote`);
  const uri = fs.readFileSync(file, 'utf8').trim();
  if (!/^postgres(ql)?:\/\//.test(uri)) throw new Error(`${file} does not hold a connection URI`);
  return uri;
}

const pgConfig = (uri) => ({ connectionString: uri, ssl: uri.includes('neon.tech') ? { rejectUnauthorized: false } : false });

// Everything the conversion writes to disk carries free-text labels: chmod 600.
function writePrivate(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
const writePrivateJson = (file, data) => writePrivate(file, `${JSON.stringify(data, null, 2)}\n`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

module.exports = {
  MONEY_MD5_EXPR, TERMINAL_STATUSES, hasOverride, isLiveOverride, heldCheck, parseIdList, moneyCents,
  readUriFile, pgConfig, writePrivate, writePrivateJson, readJson, argValue,
};
