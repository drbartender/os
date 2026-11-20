'use strict';

// The Claude connector's address check (spec 2026-11-19 section 7.5): in production the MCP endpoint
// and the token endpoint refuse callers outside Anthropic's published range.
//
// A second layer only: every Claude user's traffic leaves from the same range,
// so this stops a caller that is not Claude at all, never another Claude user.
// The range is CLAUDE_CONNECTOR_ALLOWED_CIDRS (comma-separated IPv4 or IPv6
// CIDRs), defaulting to the published 160.79.104.0/21 when the variable is
// absent. An explicitly EMPTY value switches the check off: that is the owner's
// lever if Render's proxy ever reports the wrong address and every call is
// refused (plan, owner steps). Enforced only when NODE_ENV is production, so a
// dev server and the test gate never need the range.
//
// The address is req.ip as Express reads it under `trust proxy` 1
// (server/index.js), the same value the call log records, which is what the
// owner checks after switching the connector on. A malformed range fails
// CLOSED: every caller is refused until the variable is fixed.

const net = require('node:net');
const Sentry = require('@sentry/node');

const DEFAULT_RANGES = '160.79.104.0/21';

function configuredRanges() {
  const raw = process.env.CLAUDE_CONNECTOR_ALLOWED_CIDRS;
  return raw === undefined ? DEFAULT_RANGES : raw;
}

// True when the check applies to this process: production, with a non-empty range.
function addressCheckEnforced() {
  return process.env.NODE_ENV === 'production' && configuredRanges().trim() !== '';
}

// The range as a BlockList, or null when any entry does not parse (fail closed).
function buildList(raw) {
  const list = new net.BlockList();
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!entries.length) return null;
  for (const entry of entries) {
    const m = /^([^/]+)\/(\d{1,3})$/.exec(entry);
    if (!m) return null;
    const family = net.isIP(m[1]);
    const prefix = Number(m[2]);
    if (family === 4 && prefix <= 32) list.addSubnet(m[1], prefix, 'ipv4');
    else if (family === 6 && prefix <= 128) list.addSubnet(m[1], prefix, 'ipv6');
    else return null;
  }
  return list;
}

// An IPv4 address mapped into IPv6 (::ffff:a.b.c.d, how Node reports an IPv4
// peer on a dual-stack socket) is checked as the IPv4 address it is.
function normalize(ip) {
  const s = String(ip || '').trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  return mapped ? mapped[1] : s;
}

// Whether `ip` falls inside the configured range. False for anything that is
// not an IP address, and for every address when the range does not parse.
function isAllowedAddress(ip, raw = configuredRanges()) {
  const list = buildList(raw);
  if (!list) return false;
  const addr = normalize(ip);
  const family = net.isIP(addr);
  if (family === 4) return list.check(addr, 'ipv4');
  if (family === 6) return list.check(addr, 'ipv6');
  return false;
}

// Whether this request may proceed: true outside production or with the check
// switched off, else whether req.ip is inside the range.
function addressAllowed(req) {
  if (!addressCheckEnforced()) return true;
  return isAllowedAddress(req.ip);
}

// The check's state for the settings block: 'unreadable' when the range does
// not parse (every caller is refused), 'off' when it is explicitly empty or
// this is not production, else 'on'.
function addressCheckState() {
  const raw = configuredRanges();
  if (raw.trim() !== '' && !buildList(raw)) return 'unreadable';
  return addressCheckEnforced() ? 'on' : 'off';
}

// At boot, with the connector on: an unreadable range is reported to Sentry
// once, so the first refused call is not the first sign of it. The refusal
// itself stays (fail closed). Returns whether it reported.
let reported = false;
function reportUnreadableRangeOnce(capture = (msg, ctx) => {
  if (process.env.SENTRY_DSN_SERVER) Sentry.captureMessage(msg, ctx);
}) {
  if (reported || addressCheckState() !== 'unreadable') return false;
  reported = true;
  const msg = '[connector] CLAUDE_CONNECTOR_ALLOWED_CIDRS does not parse; every caller of /mcp and /oauth/token is refused until it is fixed';
  console.error(msg);
  try {
    capture(msg, { level: 'error', tags: { component: 'connector', check: 'address_range' } });
  } catch (_) { /* telemetry must never break boot; static-checks: allow swallowed-catch */ }
  return true;
}
function __resetBootReport() { reported = false; }

module.exports = {
  DEFAULT_RANGES,
  addressCheckState,
  reportUnreadableRangeOnce,
  __resetBootReport,
  addressCheckEnforced,
  isAllowedAddress,
  addressAllowed,
};
