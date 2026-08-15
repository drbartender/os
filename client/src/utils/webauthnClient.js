import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import api from './api';

// Thin client for /api/auth/webauthn/ (spec section 8). Every URL here starts
// /auth/, inside api.js's 401-exclusion prefix, so a failed unlock can never
// fire the session-expired dispatch.

export function isPasskeySupported() {
  try { return browserSupportsWebAuthn(); } catch (e) { return false; }
}

export async function registerPasskey(label) {
  const { data: options } = await api.post('/auth/webauthn/register-options');
  let attestation;
  try {
    attestation = await startRegistration({ optionsJSON: options });
  } catch (err) {
    // Already-registered is SUCCESS, not failure (lane fleet, 2026-08-14):
    // logout purges the device's enrolled flag but the server row and the OS
    // resident passkey both survive, so the next enroll hits its own id in
    // excludeCredentials and the authenticator throws InvalidStateError.
    // The excluded ids came from this user's own credential rows, so a server
    // row provably exists; treat it as enrolled and let the caller re-arm.
    const alreadyRegistered = err && (err.name === 'InvalidStateError'
      || err.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED'
      || (err.cause && err.cause.name === 'InvalidStateError'));
    if (alreadyRegistered) return { alreadyEnrolled: true };
    throw err;
  }
  const { data } = await api.post('/auth/webauthn/register-verify', { response: attestation, label });
  return data.credential;
}

export async function unlockWithPasskey() {
  const { data: options } = await api.post('/auth/webauthn/assert-options');
  const assertion = await startAuthentication({ optionsJSON: options });
  const { data } = await api.post('/auth/webauthn/assert-verify', { response: assertion });
  return data; // { token, user }, same user shape as login
}
