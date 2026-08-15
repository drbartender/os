import '@testing-library/jest-dom';
import {
  clearLastActive, isRevocationCode, readLastActive, touchLastActive,
  LOCK_AFTER_MS, requestMobileLock, setMobileLockHandler, shouldLock, tokenExpMs,
} from './mobileLock';

function fakeJwt(expSeconds) {
  const payload = Buffer.from(JSON.stringify({ userId: 1, exp: expSeconds }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${payload}.sig`;
}

describe('tokenExpMs', () => {
  it('decodes the exp claim to ms', () => {
    expect(tokenExpMs(fakeJwt(1000))).toBe(1000 * 1000);
  });
  it('returns null on garbage', () => {
    expect(tokenExpMs('not-a-jwt')).toBeNull();
    expect(tokenExpMs(null)).toBeNull();
  });
});

describe('shouldLock', () => {
  const now = 10_000_000_000;
  const liveToken = fakeJwt((now + 3600_000) / 1000);
  it('never locks when not armed or without a token', () => {
    expect(shouldLock({ token: liveToken, lastActiveAt: 0, armed: false, now })).toBe(false);
    expect(shouldLock({ token: null, lastActiveAt: 0, armed: true, now })).toBe(false);
  });
  it('locks when the token is expired', () => {
    expect(shouldLock({ token: fakeJwt((now - 1000) / 1000), lastActiveAt: now, armed: true, now })).toBe(true);
  });
  it('locks after 30 minutes backgrounded, not before', () => {
    expect(shouldLock({ token: liveToken, lastActiveAt: now - LOCK_AFTER_MS - 1, armed: true, now })).toBe(true);
    expect(shouldLock({ token: liveToken, lastActiveAt: now - LOCK_AFTER_MS + 1000, armed: true, now })).toBe(false);
  });
  it('does not lock on a fresh launch with no recorded timestamp and a live token', () => {
    expect(shouldLock({ token: liveToken, lastActiveAt: null, armed: true, now })).toBe(false);
  });
  it('does not lock on an unreadable token that is not expired-proven', () => {
    expect(shouldLock({ token: 'garbage', lastActiveAt: now, armed: true, now })).toBe(false);
  });
});

describe('lock handler registry', () => {
  it('claims only while a handler is registered and accepting', () => {
    expect(requestMobileLock()).toBe(false);
    const unregister = setMobileLockHandler(() => true);
    expect(requestMobileLock()).toBe(true);
    unregister();
    expect(requestMobileLock()).toBe(false);
  });
  it('a declining handler does not claim', () => {
    const unregister = setMobileLockHandler(() => false);
    expect(requestMobileLock()).toBe(false);
    unregister();
  });
});

// External review (2026-08-14): the claim must know the 401's code, and the
// revocation list must have exactly one definition.
describe('revocation codes', () => {
  it('names the two codes middleware/auth.js emits for a dead session', () => {
    expect(isRevocationCode('TOKEN_VERSION_MISMATCH')).toBe(true);
    expect(isRevocationCode('USER_NOT_FOUND')).toBe(true);
    expect(isRevocationCode('INVALID_TOKEN')).toBe(false);
    expect(isRevocationCode(undefined)).toBe(false);
  });
  it('passes the code through to the handler so it can decline', () => {
    const seen = [];
    const unregister = setMobileLockHandler((code) => { seen.push(code); return !isRevocationCode(code); });
    expect(requestMobileLock('INVALID_TOKEN')).toBe(true);
    expect(requestMobileLock('TOKEN_VERSION_MISMATCH')).toBe(false);
    expect(seen).toEqual(['INVALID_TOKEN', 'TOKEN_VERSION_MISMATCH']);
    unregister();
  });
});

describe('the background clock is background time, not inactivity', () => {
  it('clearLastActive removes the stamp so a later evaluation cannot lock', () => {
    touchLastActive(Date.now() - LOCK_AFTER_MS - 1000);
    expect(readLastActive()).not.toBeNull();
    clearLastActive();
    expect(readLastActive()).toBeNull();
    expect(shouldLock({ token: 'x.y.z', lastActiveAt: readLastActive(), armed: true })).toBe(false);
  });
});
