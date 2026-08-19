/**
 * Moments: the thing the Overview screen leads with.
 *
 * A moment is an occasion worth sending into, not a campaign somebody made.
 * The screen answers "what should I do today" rather than "here is a list of
 * things you created", which is why this module exists at all: the list is
 * DERIVED from the calendar and the contact base, never stored.
 *
 * THE RULE AND THE WINDOW ARE CODE. THE WORDS ARE DATA.
 *
 * Each definition below owns its audience and its window, and those cannot be
 * edited: a moment whose rule drifted from its copy would put authored
 * reasoning above the wrong people. The title, the window label and the "why"
 * prose ship as authored defaults and CAN be rewritten.
 *
 * Overrides store ONLY the fields actually changed. Untouched copy keeps
 * tracking the default, so improving the stock wording later reaches every
 * moment nobody has rewritten, while a rewritten field stays put. Storing the
 * whole record on first edit would freeze all three fields the moment somebody
 * fixed a typo in one.
 *
 * DISMISSAL IS PER OCCURRENCE, never per moment. Clearing the September
 * holiday push clears THIS September; it returns next year. A moment-level
 * dismissal would silently delete a recurring revenue prompt because somebody
 * tidied their screen once, and nobody would ever find out why it stopped
 * appearing. That is what `occurrence_key` is for.
 */

const { pool } = require('../db');
const { AUDIENCES } = require('./marketingAudience');

// Moments name an audience by id; the operator needs its NAME and RULE to act on
// an empty one ("nobody is tagged Corporate yet" is actionable, "past-corporate
// is empty" is not). Safe to import: marketingAudience requires only
// emailValidation, so there is no cycle back to this module.
const AUDIENCE_BY_ID = new Map(AUDIENCES.map(a => [a.id, a]));

/**
 * @typedef {Object} MomentDef
 * @property {string} id
 * @property {string} audienceId   an id from marketingAudience.AUDIENCES
 * @property {(now: Date) => string} occurrenceKey  identifies THIS occurrence
 * @property {(now: Date) => boolean} isOpen        is it worth showing now
 * @property {Object} copy         authored defaults: title, window, why
 */

/** Chicago is where the business is; windows are judged in local time. */
const TZ = 'America/Chicago';
// Constructed once: building an Intl formatter is the expensive part, and this
// ran six times per resolveMoments.
const DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
function localParts(now) {
  // Read by TYPE, never by position. Positional destructuring is correct on a
  // full-ICU build (en-CA formats year-month-day) and SILENTLY WRONG on a
  // small-ICU one, where the locale falls back to en-US month/day/year: the
  // holiday window would simply never open and occurrence keys would become
  // garbage, with no error anywhere. Date-window code is the last place to
  // accept a silent failure mode for two lines of convenience.
  const parts = DAY_FMT.formatToParts(now);
  const get = (t) => Number(parts.find(p => p.type === t).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

const MOMENTS = [
  {
    id: 'holiday-corporate',
    audienceId: 'past-corporate',
    // Its audience is gated on a human classification ('corporate' = ANY(tags)),
    // so nobody matching is a SETUP GAP somebody can close today.
    emptyAudience: 'configure',
    // Keyed by YEAR: this is an annual push, so dismissing it clears one year.
    occurrenceKey: (now) => String(localParts(now).year),
    // Open from August through the Sep 5 send date. Corporate holiday work is
    // booked in September, so a prompt arriving in October is a post-mortem.
    isOpen: (now) => {
      const { month, day } = localParts(now);
      return month === 8 || (month === 9 && day <= 5);
    },
    copy: {
      title: 'Holiday parties are booked in September',
      window: 'Send by Sep 5',
      why: 'Every corporate client you have ever had books in Q4 and none of them has '
        + 'ever come back. This is the one send with a repeat-revenue thesis behind it.',
    },
  },
  {
    id: 'one-year-on',
    audienceId: 'one-year-on',
    // Purely temporal. Nobody matching means nobody has hit a year YET, and only
    // time changes that, so nagging daily about it would be the cry-wolf failure
    // this codebase keeps re-learning. (An earlier version of this comment said
    // the audience was empty for another 7 months because the earliest prod event
    // was 4 months old. WRONG — that counted native proposals only; the audience
    // reads GREATEST(agg.last_finished, cc.last_event) and legacy_cc_proposals
    // goes back to 2024-12-05, so this resolves to ~27 today. The reasoning holds
    // regardless of whether it happens to be empty right now.)
    emptyAudience: 'wait',
    // Keyed by MONTH: it is a rolling monthly prompt over a moving cohort.
    occurrenceKey: (now) => {
      const { year, month } = localParts(now);
      return `${year}-${String(month).padStart(2, '0')}`;
    },
    isOpen: () => true,
    copy: {
      title: 'People hit their one-year mark this month',
      window: 'Rolling',
      why: 'Anniversary of a finished event. The 11-month automated nudge already went '
        + 'out; this is the human follow-up nobody has ever sent.',
    },
  },
  {
    id: 'cold-quotes',
    audienceId: 'cold-quotes-spring',
    // Derived entirely from proposal data (quoted Mar-Jun, never paid). Nobody
    // matching is a fact about the book, not a thing to go configure.
    emptyAudience: 'wait',
    occurrenceKey: (now) => {
      const { year, month } = localParts(now);
      return `${year}-${String(month).padStart(2, '0')}`;
    },
    isOpen: () => true,
    copy: {
      title: "Spring quotes said 'keep us in mind'",
      window: 'Any time',
      why: 'They asked to be remembered and nobody has been back to them. No deadline '
        + 'on this one, which is exactly why it never happens.',
    },
  },
];

const MOMENT_BY_ID = new Map(MOMENTS.map(m => [m.id, m]));

/** Only these three may be rewritten. The rule and the audience may not. */
const EDITABLE_FIELDS = ['title', 'window', 'why'];

/** Resend's free tier. Surfaced so a send is never planned past what will go. */
const DAILY_SEND_CAP = Number(process.env.RESEND_DAILY_CAP || 100);

/**
 * Resolve every moment for `now`: copy with overrides applied, live headcount,
 * whether this occurrence was dismissed, and whether the audience exceeds
 * what can go out today.
 *
 * @param {Date} now
 * @param {(audienceId: string) => Promise<number>} countFor
 *   Injected rather than imported so this module stays testable without a
 *   database and so the caller controls how many audience queries it runs.
 */
async function resolveMoments(now, countFor) {
  const [overrides, dismissals] = await Promise.all([
    pool.query('SELECT moment_id, field, value FROM marketing_moment_overrides'),
    pool.query('SELECT moment_id, occurrence_key FROM marketing_moment_dismissals'),
  ]);

  const overrideMap = new Map();
  for (const r of overrides.rows) {
    if (!overrideMap.has(r.moment_id)) overrideMap.set(r.moment_id, {});
    overrideMap.get(r.moment_id)[r.field] = r.value;
  }
  const dismissed = new Set(dismissals.rows.map(r => `${r.moment_id}::${r.occurrence_key}`));

  const out = [];
  for (const def of MOMENTS) {
    const key = def.occurrenceKey(now);
    const isDismissed = dismissed.has(`${def.id}::${key}`);
    const open = def.isOpen(now);
    const edits = overrideMap.get(def.id) || {};
    const count = await countFor(def.audienceId);

    out.push({
      id: def.id,
      audience_id: def.audienceId,
      audience_name: (AUDIENCE_BY_ID.get(def.audienceId) || {}).name || def.audienceId,
      audience_rule: (AUDIENCE_BY_ID.get(def.audienceId) || {}).rule || null,
      empty_audience: def.emptyAudience,
      occurrence_key: key,
      open,
      dismissed: isDismissed,
      emailable: count,
      // Field by field, so an untouched field still tracks the default.
      title: edits.title ?? def.copy.title,
      window: edits.window ?? def.copy.window,
      why: edits.why ?? def.copy.why,
      edited_fields: EDITABLE_FIELDS.filter(f => f in edits),
      // The spec asks this moment to say when the audience will not fit in one
      // day. It is true of any of them, so it is computed for all three rather
      // than hardcoded to the one the design happened to illustrate.
      exceeds_daily_cap: count > DAILY_SEND_CAP,
      daily_cap: DAILY_SEND_CAP,
    });
  }
  return out;
}

/**
 * SENDABLE today: open, not dismissed for this occurrence, AND with somebody to
 * reach. The last clause is the one the old comment here omitted, and omitting it
 * in prose is how it came to be omitted in thought: a moment whose window is open
 * but whose audience is empty was silently dropped by every consumer of this
 * predicate, so "no moment this month" and "a moment worth thousands whose
 * audience nobody has configured" rendered identically. That is what
 * `needsSetup` below exists to separate.
 */
const isLive = (m) => m.open && !m.dismissed && m.emailable > 0;

/**
 * OPEN BUT UNSENDABLE: its window is open and it has not been dismissed, but the
 * audience resolves to nobody. This is not "nothing to do" — it is the one state
 * that needs a human, because the fix is configuration (tag some contacts), not
 * waiting. Found 2026-08-14: `holiday-corporate` was open, undismissed, and
 * invisible on every surface because `client_tags` was empty in prod, with three
 * weeks left on an annual, revenue-bearing window.
 *
 * The `empty_audience === 'configure'` clause is load-bearing and was added after
 * the first cut of this predicate. Two of the three moments are open PERMANENTLY
 * (`isOpen: () => true`) and their audiences are temporal, so without it a brand
 * new business nags "needs setup" on every load for months about audiences that
 * only time can fill. A surface that cries wolf gets ignored, and then it hides
 * the real one — which is the exact bug this predicate exists to prevent.
 */
const needsSetup = (m) => m.open && !m.dismissed && m.emailable === 0
  && m.empty_audience === 'configure';

/**
 * The automations that reach a contact without anyone pressing anything.
 * ONE definition: Overview names them, Sent lists them with their counts, and a
 * fifth automation must not require remembering to edit two screens.
 */
const AUTOMATIONS = [
  { name: 'Unsigned proposal drip', trigger: 'Proposal sent, not signed', touches: '5 touches' },
  { name: 'Review request', trigger: '2 days after each event', touches: '1 touch' },
  { name: 'Six months out', trigger: '6 months after a signed and paid booking', touches: '1 touch' },
  { name: 'Retention nudge', trigger: '11 months after an event', touches: '1 touch' },
  { name: 'New Year touch', trigger: 'January 2', touches: '1 touch' },
];
// If you add a handler with category 'marketing' in marketingHandlers.js, add it
// here. Both screens tell the operator this list is COMPLETE ("every email a
// contact gets from you"), which is exactly the promise that makes an omission
// worse than having no list: six_months_out was registered, live, and missing.

module.exports = {
  MOMENTS,
  AUTOMATIONS,
  MOMENT_BY_ID,
  EDITABLE_FIELDS,
  DAILY_SEND_CAP,
  resolveMoments,
  isLive,
  needsSetup,
  _localParts: localParts,
};
