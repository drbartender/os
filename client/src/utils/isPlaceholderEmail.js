// Mirror of server/utils/emailValidation.js isPlaceholderEmail — keep in sync.
// RFC-2606 .invalid placeholders (CC import) are not real addresses: the
// server silently drops them, so the UI must treat them as no-email (no
// receipt popup, email channel unavailable).
export default function isPlaceholderEmail(email) {
  return Boolean(email && String(email).toLowerCase().trim().endsWith('.invalid'));
}
