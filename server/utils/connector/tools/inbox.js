'use strict';

// The Inbox pieces the Waiting on you and Thread tools share: a person's inbound messages screened, so a withheld message withholds every Inbox summary drawn from it.
//
// Spec 2026-11-19 section 7.6 guard 1: when a client's message is withheld,
// its Inbox summary is withheld with it. A need line (waiting, handled, a
// promise of ours, a Reopen) and the Inbox AI's close reason are each the
// summary of one of the person's inbound messages, and which one is the
// rules' internal choice, so the check is keyed on the messages, not on
// waiting_since: every inbound message the engine holds for the person is
// screened, and when any is withheld, each summary is withheld naming that
// message (a summary of another message of theirs is withheld with it: the
// list leans toward withholding, and a false alarm costs one look in the
// OS). The withheld pieces are registered on the call's guard under the
// message's own ref, so a message is logged once whichever tool met it
// first; a flag-tier message is not marked here (only the call that shows it
// records its flag).

const { WITHHELD_TEXT, isWithheld, refs } = require('./text');

/**
 * Screen each inbound message. Resolves the record label of the first one
 * withheld, or null.
 * @param {object} guard the call's text guard
 * @param {{ref: string, text?: string|null, subject?: string|null}[]} inbound
 * @param {{label: string, path: string}|null} open what the owner opens to read them
 */
function inboundWithheld(guard, inbound, open = null) {
  let first = null;
  for (const m of inbound) {
    if (!m || !m.ref) continue;
    const record = `message ${m.ref}`;
    // noFlag: this check decides only whether a summary is withheld; a flag
    // is recorded by the call that shows the flagged text, not here.
    const opts = (ref) => ({ record, ref, open, noFlag: true });
    const subject = m.subject ? isWithheld(guard.screened(m.subject, opts(`${refs.message(m.ref)}:subject`)).text) : false;
    const text = typeof m.text === 'string' && m.text !== '' ? isWithheld(guard.screened(m.text, opts(refs.message(m.ref))).text) : false;
    if (!first && (subject || text)) first = record;
  }
  return first;
}

const withheldAs = (record) => `${WITHHELD_TEXT} (${record})`;

module.exports = { inboundWithheld, withheldAs };
