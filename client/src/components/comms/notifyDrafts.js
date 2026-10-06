// The notify-client draft logic shared by the desktop popup
// (NotifyConfirmModal.jsx) and the phone edit sheet's notify step (lane
// ma-e3). Moved out of the popup verbatim: one copy, so the payload the server
// receives cannot depend on which surface built it.

export const SUBJECT_MAX = 300;
export const SMS_MAX_CHARS = 640;

// Server reasons arrive as `${column} changed`; show the admin words, not columns.
export const REASON_LABELS = {
  'event_date changed': 'Date changed',
  'event_start_time changed': 'Start time changed',
  'event_location changed': 'Location changed',
};
export const humanizeReason = (r) => REASON_LABELS[r] || r;

// One draft per notice: the channels the server marks available AND
// defaulted start ticked; the composable text starts as the server's draft.
export function initialDrafts(notices) {
  return (notices || []).map((n) => ({
    type: n.type,
    channels: Object.entries(n.channels || {})
      .filter(([, c]) => c && c.available && c.default)
      .map(([k]) => k),
    subject: n.draft?.email?.subject || '',
    bodyText: n.draft?.email?.body_text || '',
    smsBody: n.draft?.sms?.body || '',
  }));
}

// True when a ticked channel of a composable notice would be refused: an
// empty or over-long subject, an empty body, an empty or over-long text.
export function draftsOverCap(notices, drafts) {
  return (drafts || []).some((d, i) => {
    const notice = (notices || [])[i];
    if (!notice || !notice.composable) return false;
    if (d.channels.includes('email') && (d.subject.length > SUBJECT_MAX || !d.subject.trim() || !d.bodyText.trim())) return true;
    if (d.channels.includes('sms') && (d.smsBody.length > SMS_MAX_CHARS || !d.smsBody.trim())) return true;
    return false;
  });
}

// The PATCH `notify` list: one entry per notice with a ticked channel; a
// composable notice carries its text for each ticked channel.
export function buildNotifyEntries(notices, drafts) {
  return (drafts || [])
    .filter((d) => d.channels.length > 0)
    .map((d) => {
      const notice = (notices || []).find((n) => n.type === d.type);
      const out = { type: d.type, channels: d.channels };
      if (!notice || !notice.composable) return out;
      if (d.channels.includes('email')) out.email = { subject: d.subject, body_text: d.bodyText };
      if (d.channels.includes('sms')) out.sms = { body: d.smsBody };
      return out;
    });
}

// Per-channel truth after a save (notify-client contract): failures and real
// skips surface; "not selected" and never-offered channels stay silent. Each
// entry is one toast, in the order the desktop always showed them.
export function noticeOutcomes(notifications) {
  const out = [];
  (notifications || []).forEach((n) => {
    if (n.email === 'failed') out.push({ kind: 'error', text: `Saved, but the email failed: ${n.email_error || 'unknown error'}` });
    if (n.sms === 'failed') out.push({ kind: 'error', text: `Saved, but the text failed: ${n.sms_error || 'unknown error'}` });
    ['email', 'sms'].forEach((ch) => {
      if (n[ch] === 'skipped' && n.skip_reasons?.[ch] && n.skip_reasons[ch] !== 'not selected') {
        out.push({ kind: 'info', text: `Saved. ${ch === 'email' ? 'Email' : 'Text'} not sent: ${n.skip_reasons[ch]}` });
      }
    });
  });
  return out;
}
