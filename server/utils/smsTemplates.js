/**
 * SMS body templates for Dr. Bartender — client-facing automated SMS.
 * One exported function per touch; each returns a plain string (the SMS body).
 * Mirrors emailTemplates.js. Copy is verbatim from the automated-communication
 * spec section 5. NO em dashes (per CLAUDE.md) — commas, periods, parentheticals.
 *
 * Phase 3 creates this file with the client SMS copy. Phase 4a appends staff
 * SMS copy below.
 */

/** Defensive fallbacks so a missing merge field never renders 'undefined'. */
function ev(label) { return label || 'event'; }
function dt(date) { return date || 'your event'; }

// ─── 1.2 Initial proposal SMS ────────────────────────────────────
function initialProposalSms({ eventTypeLabel, eventDate, link }) {
  return `Hi, Dallas here. Just sent your proposal for the ${ev(eventTypeLabel)} on ${dt(eventDate)}. View and book here: ${link}. Let me know if you have any questions or need any changes.`;
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
};
