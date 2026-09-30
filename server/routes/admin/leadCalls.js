// Lead call bridge: needs-attention feed. NARROWED 2026-07-20 per Dallas:
// a missed or after-hours lead needs no callback (speed-to-lead value dies
// with the moment; follow-up is the normal email/SMS pipeline), so those
// are NOT attention items. Only system-fault chains surface: the machine
// could not place calls at all (Twilio failure, missing config, bad phone
// data). At healthy steady state this feed is empty and the Sales tab's
// lead-call items simply never exist. 7-day window; a lead that leaves
// 'new' clears its item. Driven FROM lead_call_attempts, so pre-feature
// leads never surface. Read-only; the overview NeedsYouStrip consumes it.
//
// WIDENED 2026-08-25 (spec 2026-08-25 section 5.3) into a UNION over
// consult_call_attempts, tagged with a `kind` column so the client can label
// the two halves differently. The lead half is untouched, including its
// status list: this widening is not licence to surface a missed lead. The
// route keeps its name because it is the same feed.
//
// The consult half is faults-only for the same reason, with one difference
// that is easy to get backwards, so read this before adding a filter to it.
//
// DO NOT add `AND c.scheduled_at > NOW()`. Ruling S-R2: rev 2 of the spec
// carried that line by borrowing the LEAD rule that once the moment passes
// there is nothing to rescue, and the reasoning does not transfer.
//
// Two arguments carry the rule, and neither one is a head count. First: a
// missed lead is a lost opportunity, but a failed consult is a client who was
// PROMISED a call and did not get one, so the slot passing CREATES the
// callback obligation rather than retiring it. Second: skipped_unconfigured
// emails NOTHING, so this feed is its ONLY surface, and it is written at ring
// 1, which fires at slot-90s. The filter hid it about ninety seconds after it
// was written and it was invisible from then on.
//
// The head count, stated correctly because rev 2 stated it wrong and a comment
// a reader can falsify discredits the rule it defends. TWO statuses can only
// be written after the slot: failed/too_late, which needs NOW() past
// scheduled_at + 600s to exist at all, and skipped_missed_window, whose sweep
// runs from 3 to 30 minutes behind the slot. ONE more is path-dependent, the
// VA-leg failure reached through the ring-3 hop at slot+180s. Rev 2 also said
// skipped_cap with va_leg_cap_tripped is written on the Zul hop after the
// slot; that is FALSE and should not be repeated. Its one writer is
// advanceChain's ADMIN_PHONE-unset branch, where Zul takes the call directly,
// and that runs at ring 1, ninety seconds BEFORE the slot. The ring-3 hop
// files no cap marker at all when the international ceiling is spent: it falls
// through to finishMissed on purpose, so Dallas still gets the text with the
// booker's number instead of silence.
//
// `c.status = 'scheduled'` is the honest clearing mechanism: a consult that
// reaches completed, cancelled or no_show is genuinely closed. The 7-day bound
// on a.created_at bounds the rest.
//
// `missed` is not an item on either half. A missed consult already texted the
// operator the booker's number, so a second surface adds nothing.
//
// skipped_cap IS a fault here, and it is the entry that matters most: the
// Cal.com booking page is PUBLIC, so a cap trip is the one fault class a
// stranger can cause, which makes it exactly the abuse signal this feed
// exists to show. It carries THREE details and `detail` rides through
// untouched so the client can label them apart:
//   cap_tripped        openChain's chain-open daily cap. The DOMINANT one:
//                      what a stranger hammering the booking page hits first.
//   dial_cap_tripped   the ceiling on rings to Dallas.
//   va_leg_cap_tripped the ceiling on international legs to Zul.
// skipped_disabled stays out: the kill switch being off on purpose.
//
// skipped_cancelled stays out too, but NOT for the reason this comment used to
// give. "A booking that went away" is true of only two of its four details.
// The other two describe a consult that is still LIVE: `rescheduled` means the
// slot moved, and `rescheduled_unresolved` is stamped by consultCallChain.js on
// rows selected with `c.status = 'scheduled' AND c.scheduled_at > NOW()`, which
// is the one path in the feature that stops a call that would otherwise have
// rung. Those genuinely want attention.
//
// It stays out anyway because SQL here cannot tell WHICH row is which. An
// unresolved reschedule marks every future sibling sharing the booker's email,
// and the ordinary case marks exactly one, the phantom left behind by the
// booking that moved. Surfacing the status would therefore fire a false
// attention item on every routine reschedule. The split we chose instead:
// consultCallChain.js emails once when it stops MORE than one row, which is
// the case where a separate legitimate booking was caught, and the client
// labels the details apart on the detail pages (consultCallLabel.js) so no
// browsing surface calls a live booking cancelled. Corrected 2026-08-26; the
// write side owes this case a status of its own, tracked in the backlog.
//
// The limits are PER HALF (ruling S-R1). A single shared LIMIT was a denial
// of visibility on the revenue-critical half: skipped_cap rows do not count
// toward CONSULT_CALL_DAILY_CAP (ruling R15), so a stranger booking enough
// public slots could file more qualifying consult rows than the whole limit
// and push every Thumbtack lead fault off the feed. Lead 200 keeps that
// half's historical capacity byte-identical; consult 100 bounds the half a
// stranger controls; the merged input is therefore at most 300, so the outer
// 300 can never truncate either half and is pure belt and braces.
const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');

const router = express.Router();

/** GET /api/admin/lead-call-attention - open lead-call and consult-call attention rows. */
router.get('/lead-call-attention', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT * FROM (
      (
        SELECT a.id, 'lead' AS kind, a.status, a.detail, a.created_at,
               l.customer_name, l.proposal_id, l.client_id
          FROM lead_call_attempts a
          JOIN thumbtack_leads l ON l.id = a.lead_id
         WHERE a.status IN ('failed','skipped_unconfigured','skipped_invalid_phone')
           AND a.created_at > NOW() - INTERVAL '7 days'
           AND l.status = 'new'
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT 200
      )
      UNION ALL
      (
        SELECT a.id, 'consult' AS kind, a.status, a.detail, a.created_at,
               c.booker_name AS customer_name, c.proposal_id, c.client_id
          FROM consult_call_attempts a
          JOIN consults c ON c.id = a.consult_id
         WHERE a.status IN ('failed','skipped_unconfigured','skipped_invalid_phone',
                            'skipped_missed_window','skipped_cap')
           AND a.created_at > NOW() - INTERVAL '7 days'
           AND c.status = 'scheduled'
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT 100
      )
    ) x
    ORDER BY created_at DESC, id DESC
    LIMIT 300
  `);
  res.json(result.rows);
}));

module.exports = router;
