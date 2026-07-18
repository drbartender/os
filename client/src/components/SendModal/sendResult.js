// Formats a POST /api/comms/send result payload (the object SendModal hands to
// onComplete) into one per-channel-truth toast line. Channels the admin never
// selected are omitted; every attempted channel reports its real outcome, so a
// partial failure ("Emailed x@y.com. Text failed: ...") never hides behind a
// blanket success. Returns { hadFailure, level, message }:
//   hadFailure  true when any attempted channel failed (pick toast.error)
//   level       'error' | 'success' | 'info' (same signal, enum form)
// Shared by every SendModal-consuming surface; single source of truth (a
// cross-lane duplicate of this helper was unified here on 2026-07-18).
export function describeSendResult(results) {
  const r = results || {};
  const clauses = [];
  let sentCount = 0;
  let failedCount = 0;

  if (r.email === 'sent') { clauses.push(`Emailed ${r.recipient_email || 'the client'}`); sentCount += 1; }
  else if (r.email === 'failed') { clauses.push(`Email failed: ${r.email_error || 'unknown error'}`); failedCount += 1; }
  else if (r.email === 'skipped' && r.skip_reasons && r.skip_reasons.email && r.skip_reasons.email !== 'not selected') {
    clauses.push(`Email skipped: ${r.skip_reasons.email}`);
  }

  if (r.sms === 'sent') { clauses.push(`Texted ${r.recipient_phone || 'the client'}`); sentCount += 1; }
  else if (r.sms === 'failed') { clauses.push(`Text failed: ${r.sms_error || 'unknown error'}`); failedCount += 1; }
  else if (r.sms === 'skipped' && r.skip_reasons && r.skip_reasons.sms && r.skip_reasons.sms !== 'not selected') {
    clauses.push(`Text skipped: ${r.skip_reasons.sms}`);
  }

  const message = clauses.length ? `${clauses.join('. ')}.` : 'Done. No message was sent.';
  const level = failedCount ? 'error' : sentCount ? 'success' : 'info';
  return { hadFailure: failedCount > 0, level, message };
}
