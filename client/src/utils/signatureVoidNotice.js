// The notice an admin save shows when the PATCH cleared the client's signature (signature_voided, server/routes/proposals/signatureVoid.js), worded from the status the row was left in; null when nothing was cleared.
//
// One copy for every caller of PATCH /api/proposals/:id that shows a toast:
// the desktop editor, the mobile edit sheet and the remote staffing fee prompt.

export function signatureVoidNotice(data) {
  if (!data || !data.signature_voided) return null;
  return data.status === 'sent'
    ? "This change cleared the client's signature. The proposal is back to Sent, and they sign the new terms again before paying."
    : "This change cleared the client's signature. The proposal stays Accepted, and they sign the new terms again before paying.";
}
