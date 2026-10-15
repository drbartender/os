'use strict';

// Pass 2 (spec 5.7): full rows, by ref, for the people the rules keep. Calls
// and proposal sends carry everything in their header already. A gm event is
// looked up by its readRef ('gm:<id>'), which every suffixed sibling of one
// Sent mail shares, and loaded by its row id (spec 2026-10-14 section 5.1).

const { loadSmsDetails } = require('./readSms');
const { loadThumbtackDetails } = require('./readThumbtack');
const { loadMessageLogDetails } = require('./readMessageLog');
const { loadGmailDetails } = require('./readGmail');
const { TT_MISSED_TEXT } = require('./constants');

async function loadDetails(events, db) {
  const sms = new Set();
  const tt = new Set();
  const ml = new Set();
  const gm = new Set();
  for (const e of events) {
    if (!e.meta || e.meta.companionOf) continue;
    if (e.meta.source === 'sms') sms.add(Number(e.meta.id));
    else if (e.meta.source === 'tt') tt.add(e.ref.slice(3));
    else if (e.meta.source === 'ml') ml.add(Number(e.meta.id));
    else if (e.meta.source === 'gm') gm.add(Number(e.meta.id));
  }
  const [a, b, c, d] = await Promise.all([
    loadSmsDetails([...sms], db), loadThumbtackDetails([...tt], db), loadMessageLogDetails([...ml], db),
    loadGmailDetails([...gm], db),
  ]);
  return new Map([...a, ...b, ...c, ...d]);
}

function mergeDetails(events, details) {
  return events.map((e) => {
    const d = details.get((e.meta && e.meta.readRef) || e.ref);
    if (!d) return { ...e, text: e.text === undefined ? null : e.text };
    const meta = { ...e.meta };
    if (d.media) meta.media = d.media;
    if (d.failureReason !== undefined) meta.failureReason = d.failureReason;
    if (d.subject !== undefined) meta.subject = d.subject;
    if (d.senderName !== undefined) meta.senderName = d.senderName;
    let text = d.text !== undefined ? d.text : e.text;
    // The fixed lines, never what the source row holds: Thumbtack's notice, or
    // a Zola notice the OS could not read (its stored text is null).
    if (e.kind === 'tt_missed' || e.kind === 'zola_unread') text = e.text;
    // A quoted relay notice whose words come out empty holds nothing of
    // theirs: it stays "never received" (Task 18 F1).
    if (e.kind === 'message' && e.meta.relayQuoted && !String(text || '').trim()) {
      return { ...e, channel: 'thumbtack', line: null, kind: 'tt_missed', text: TT_MISSED_TEXT, meta };
    }
    return { ...e, text: text === undefined ? null : text, meta };
  });
}

module.exports = { loadDetails, mergeDetails };
