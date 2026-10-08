'use strict';

// Pass 2 (spec 5.7): full rows, by ref, for the people the rules keep. Calls
// and proposal sends carry everything in their header already.

const { loadSmsDetails } = require('./readSms');
const { loadThumbtackDetails } = require('./readThumbtack');
const { loadMessageLogDetails } = require('./readMessageLog');
const { TT_MISSED_TEXT } = require('./constants');

async function loadDetails(events, db) {
  const sms = new Set();
  const tt = new Set();
  const ml = new Set();
  for (const e of events) {
    if (!e.meta || e.meta.companionOf) continue;
    if (e.meta.source === 'sms') sms.add(Number(e.meta.id));
    else if (e.meta.source === 'tt') tt.add(e.ref.slice(3));
    else if (e.meta.source === 'ml') ml.add(Number(e.meta.id));
  }
  const [a, b, c] = await Promise.all([
    loadSmsDetails([...sms], db), loadThumbtackDetails([...tt], db), loadMessageLogDetails([...ml], db),
  ]);
  return new Map([...a, ...b, ...c]);
}

function mergeDetails(events, details) {
  return events.map((e) => {
    const d = details.get(e.ref);
    if (!d) return { ...e, text: e.text === undefined ? null : e.text };
    const meta = { ...e.meta };
    if (d.media) meta.media = d.media;
    if (d.failureReason !== undefined) meta.failureReason = d.failureReason;
    if (d.subject !== undefined) meta.subject = d.subject;
    if (d.senderName !== undefined) meta.senderName = d.senderName;
    let text = d.text !== undefined ? d.text : e.text;
    if (e.kind === 'tt_missed') text = e.text; // the fixed "never received" line, not Thumbtack's notice
    // A quoted relay notice whose words come out empty holds nothing of
    // theirs: it stays "never received" (Task 18 F1).
    if (e.kind === 'message' && e.meta.relayQuoted && !String(text || '').trim()) {
      return { ...e, channel: 'thumbtack', line: null, kind: 'tt_missed', text: TT_MISSED_TEXT, meta };
    }
    return { ...e, text: text === undefined ? null : text, meta };
  });
}

module.exports = { loadDetails, mergeDetails };
