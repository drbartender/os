/**
 * SMS body templates for Dr. Bartender, client-facing automated SMS.
 * One exported function per touch; each returns a plain string (the SMS body).
 * Mirrors emailTemplates.js. Copy is verbatim from the automated-communication
 * spec section 5. NO em dashes (per CLAUDE.md), commas, periods, parentheticals.
 *
 * Phase 3 creates this file with the client SMS copy. Phase 4a appends staff
 * SMS copy below.
 */

/** Defensive fallbacks so a missing merge field never renders 'undefined'. */
function ev(label) { return label || 'event'; }
function dt(date) { return date || 'your event'; }

// ─── 1.2 Initial proposal SMS ────────────────────────────────────
function initialProposalSms({ eventTypeLabel, eventDate, link }) {
  return `Hi, Dallas here. Just sent your proposal for the ${ev(eventTypeLabel)} on ${dt(eventDate)}. Review the details and check out here: ${link}. Let me know if you have any questions or need any changes.`;
}

// ─── 2.1 Sign+pay confirmation SMS ───────────────────────────────
function signPayConfirmationSms({ eventDate }) {
  return `Hi, Dallas here. You're booked for ${dt(eventDate)}! Confirmation email and Potion Planner link are coming your way. Reply here anytime if you have questions.`;
}

// ─── 1.3 Drip touch 1 (+1d) ──────────────────────────────────────
function dripTouch1Sms({ eventTypeLabel, eventDate }) {
  return `Hi, Dallas here. Did you get the proposal I sent for the ${ev(eventTypeLabel)} on ${dt(eventDate)}? Let me know if you have any questions.`;
}

// ─── 1.3 Drip touch 3 (+10d) ─────────────────────────────────────
function dripTouch3Sms({ eventTypeLabel, eventDate, link }) {
  return `Hi, Dallas here. Quick thought on the ${ev(eventTypeLabel)} on ${dt(eventDate)}. Want to tweak anything before it books up? Easy to adjust: ${link}.`;
}

// ─── 1.3 Drip touch 5 (+21d), SMS half ───────────────────────────
function dripTouch5Sms({ eventDate, link }) {
  return `Hi, Dallas here. Last check on your ${dt(eventDate)} event. Want to lock it in before someone else grabs the date? ${link}`;
}

// ─── 3.7 Drink plan nudge SMS ────────────────────────────────────
function drinkPlanNudgeSms({ eventDate, plannerUrl, consultUrl }) {
  const consultClause = consultUrl ? `, or book a consult: ${consultUrl}` : '';
  return `Hi, Dallas here. Time to lock in drinks for ${dt(eventDate)}. Use the Potion Planner: ${plannerUrl}${consultClause}. Or just call us.`;
}

// ─── 3.5 Balance due today SMS ───────────────────────────────────
function balanceDueTodaySms({ eventDate, link }) {
  return `Hi, Dallas here. Your balance for ${dt(eventDate)} is due today. Pay here: ${link}. Let me know if you need anything.`;
}

// ─── 3.6 Late balance SMS (t1 gentle, t3 firmer) ─────────────────
function balanceLateSms({ eventDate, link, daysLate }) {
  if (Number(daysLate) >= 3) {
    return `Hi, Dallas here. Your balance for ${dt(eventDate)} is 3 days past due. Please pay here ASAP: ${link}. Or call me so we can sort it out.`;
  }
  return `Hi, Dallas here. Just a reminder, your balance for ${dt(eventDate)} is now 1 day past due. Pay here: ${link}.`;
}

// ─── 3.3 Payment failure SMS ─────────────────────────────────────
function paymentFailureSms({ eventDate, link }) {
  return `Hi, Dallas here. Your payment for ${dt(eventDate)} didn't go through. Tap here to update your card: ${link}. Reach out if you need help.`;
}

// ─── 3.12 Event-eve SMS ──────────────────────────────────────────
function eventEveSms({ startTime, location, bartenderName, bartenderPhone, setupMinutes }) {
  // Spec 3.12: name the bartender, time, location, their phone, and the
  // actual scheduled setup minutes. When no bartender is assigned yet, omit
  // the bartender name + phone clauses gracefully.
  const time = startTime || 'your start time';
  const loc = location || 'your venue';
  const setup = Number.isFinite(Number(setupMinutes)) ? Number(setupMinutes) : 60;
  if (bartenderName) {
    const phoneClause = bartenderPhone
      ? ` Their direct number is ${bartenderPhone} if you need them.`
      : '';
    return `Hi, Dallas here. Your bartender tomorrow at ${time}, ${loc} is ${bartenderName}.${phoneClause} They'll arrive ${setup} minutes before your start time to set up. Let me know if you have any questions or need any changes.`;
  }
  return `Hi, Dallas here. Your event is tomorrow at ${time}, ${loc}. Your bartender will arrive ${setup} minutes before your start time to set up. Let me know if you have any questions or need any changes.`;
}

// ─── 3.13 Reschedule SMS ─────────────────────────────────────────
function rescheduleSms({ newDate, newStartTime, newLocation }) {
  return `Hi, Dallas here. Your event has been updated. New details: ${dt(newDate)} at ${newStartTime || 'a new time'}, ${newLocation || 'the same location'}. Full updated confirmation in your email. Let me know if you have any questions.`;
}

// ═════════════════════════════════════════════════════════════════
// Staff-facing SMS copy (Phase 4a). Branded prefix style so staff
// recognize the automation. Verbatim from spec sections 3.15-3.19.
// ═════════════════════════════════════════════════════════════════

/**
 * Staff day-before shift reminder (spec 3.15). Branded prefix style so staff
 * recognize the automation. Includes CONFIRM / CANT response codes.
 */
function staffShiftReminderSms(ctx) {
  return `Shift Reminder from Dr. Bartender: working ${ctx.eventTypeLabel} at ${ctx.clientName} tomorrow at ${ctx.startTimeLocal}, ${ctx.location}. Setup: ${ctx.setupArrivalTime}. Drink plan and shopping list: ${ctx.link}. Reply CONFIRM to acknowledge or CANT if you have a conflict.`;
}

/**
 * Staff post-event thank-you (spec 3.19).
 */
function staffThankYouSms(ctx) {
  return `Thanks from Dr. Bartender for working ${ctx.eventTypeLabel} tonight. Let me know if anything came up. Cheers`;
}

/**
 * Staff schedule-change notice (spec 3.17). Admin-toggled.
 */
function staffScheduleChangeSms(ctx) {
  return `Update from Dr. Bartender: ${ctx.eventTypeLabel} on ${ctx.eventDateLocal} has been changed. New: ${ctx.newDetails}. Reply CONFIRM to stay on the shift or call if there is a conflict.`;
}

/**
 * Staff cancellation / unassignment notice (spec 3.18). Admin-toggled.
 * `kind` is 'cancelled' (the event itself was cancelled) or 'unassigned' (the
 * staffer was removed from a still-running event). Each branch is a complete
 * grammatical standalone sentence, the verb is NOT shared.
 */
function staffCancellationSms(ctx) {
  const sentence = ctx.kind === 'unassigned'
    ? `your shift for the ${ctx.eventTypeLabel} on ${ctx.eventDateLocal} is no longer needed`
    : `the ${ctx.eventTypeLabel} on ${ctx.eventDateLocal} has been cancelled`;
  return `Update from Dr. Bartender: ${sentence}. Sorry for the disruption. Reach out with questions.`;
}

// ─── 2.2 Last-minute staffing confirmation SMS ───────────────────
function lastMinuteStaffingConfirmationSms({ eventDate, bartenderList, isPlural }) {
  const noun = isPlural ? 'bartenders' : 'bartender';
  const verb = isPlural ? 'are' : 'is';
  return `Hi, Dallas here. Your ${noun} for ${eventDate} ${verb} ${bartenderList}. They'll reach out the day of the event. Let me know if you have any questions.`;
}

/**
 * BEO unack nudge SMS (spec section 6.3). The CTA drives staff to the portal
 * where the click is itself the read-receipt signal; we do NOT reuse the
 * existing CONFIRM keyword. Body length budgeted for 2 segments worst case;
 * eventTypeLabel is GSM-7-normalized then truncated to 40 chars to avoid an
 * unexpected UCS-2 segment-cap halving.
 */
function staffBeoNudgeSms({ eventTypeLabel, eventDateLocal, beoUrl }) {
  const normalized = String(eventTypeLabel || 'your event')
    // Replace curly quotes with GSM-7-safe equivalents. Pragmatic minimum;
    // unhandled UCS-2 chars (emoji etc.) take the larger segment cost.
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
  const truncated = normalized.length > 40
    ? normalized.slice(0, 40) + '…'
    : normalized;
  return `BEO ready from Dr. Bartender: ${truncated} on ${eventDateLocal}. Tap to review and confirm: ${beoUrl}`;
}

// ═════════════════════════════════════════════════════════════════
// Staff Drop / Cover marketplace SMS (Phase 5, spec §6.5).
// ═════════════════════════════════════════════════════════════════

/**
 * Sanitize to GSM-7-friendly chars (curly quotes only). Keeps the segment
 * budget predictable; falling out to UCS-2 halves segment capacity.
 */
function gsmSafe(str) {
  return String(str || '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

/**
 * Cover-broadcast SMS, spec §6.5. Fired to qualified teammates when a staffer
 * with an approved shift requests a cover (in the 72h-336h window). Anonymized:
 * the requesting staffer is surfaced by initials only so the receiving teammate
 * is not pressured by identity. Budgeted for 2 segments worst case.
 *
 * `first_initial_last_initial` example: "J.B." or just "J." when only the
 * preferred name is known. `shift_role` is the position label (bartender,
 * barback). `shift_url` is the deep link to the shift in the staff portal.
 */
function cover_broadcast_sms({
  first_initial_last_initial,
  client_name,
  event_date_short,
  shift_role,
  shift_url,
}) {
  const initials = gsmSafe(first_initial_last_initial || '?');
  const role = gsmSafe(shift_role || 'bartender');
  const client = gsmSafe(client_name || 'a client');
  const date = gsmSafe(event_date_short || 'soon');
  return `Cover needed from Dr. Bartender: ${initials} needs a ${role} cover for ${client} on ${date}. Tap to claim: ${shift_url}`;
}

/**
 * Staff emergency-drop SMS to management, spec §6.5. Front-loads the actor
 * and the reason so the first SMS preview line carries the urgent signal,
 * then appends shift info for context. `reason` is truncated to 80 chars so
 * the front-load fits in the first segment (the reason is also captured
 * in full in the email and in the proposal_activity_log row).
 */
function staff_drop_to_management_sms({
  staff_name,
  client_name,
  event_date_short,
  hours_to_event,
  reason,
}) {
  const name = gsmSafe(staff_name || 'A staffer');
  const reasonText = gsmSafe(reason || '').slice(0, 80);
  const client = gsmSafe(client_name || 'an event');
  const date = gsmSafe(event_date_short || 'soon');
  const hours = Number.isFinite(Number(hours_to_event))
    ? `${Math.round(Number(hours_to_event))}h`
    : 'soon';
  return `EMERGENCY DROP from ${name}: ${reasonText}. Shift: ${client} on ${date}, ${hours} out.`;
}

module.exports = {
  initialProposalSms,
  signPayConfirmationSms,
  dripTouch1Sms,
  dripTouch3Sms,
  dripTouch5Sms,
  drinkPlanNudgeSms,
  balanceDueTodaySms,
  balanceLateSms,
  paymentFailureSms,
  eventEveSms,
  rescheduleSms,
  staffShiftReminderSms,
  staffThankYouSms,
  staffScheduleChangeSms,
  staffCancellationSms,
  lastMinuteStaffingConfirmationSms,
  staffBeoNudgeSms,
  cover_broadcast_sms,
  staff_drop_to_management_sms,
};
