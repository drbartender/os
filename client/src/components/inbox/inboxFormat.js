import {
  chicagoDay, chicagoTime, chicagoWeekday, chicagoWeekdayDate, chicagoHour, chicagoInstant, chicagoDayLabel, addDays,
} from '../../utils/chicagoDay';
import { fmtDate } from '../adminos/format';

// Pure view model for the Inbox page (spec docs/superpowers/specs/
// 2026-10-06-inbox-design.md, sections 4 and 11). No React, no fetching, no
// clock of its own: every time-dependent helper takes `nowMs`. Every time it
// prints is Chicago time (decision 28).

// Mirrors server/utils/inbox/constants.js HOT_HOURS: a wait this long is red.
export const HOT_HOURS = 24;
// The design's middle tone for a desktop row icon (InboxDesktop.dc.html).
export const WARN_HOURS = 4;
// How long an Undo toast stays up (the design's 4200 ms, spec 4.4 "about 4 s").
export const UNDO_TOAST_MS = 4200;

// Person keys at least as strict as lane inbox-engine's parsePersonKey, so a
// key the server would refuse reads as gone here, never as a Retry that
// cannot succeed. c-, s- and z- are row ids written one way (no leading
// zeros, at most int4), t- a Thumbtack thread id and e- 16 lowercase hex (an
// email address's hash), exactly as the server parses them. p- is stricter:
// the server parses 1 to 20 digits, this takes exactly ten, the last 10
// digits of a number and the only shape the engine builds (its last10
// returns null under ten digits), so any other p- key reads as gone with no
// request.
const ROW_KEY = /^[csz]-(0|[1-9]\d{0,9})$/;
const OTHER_KEY = /^(?:p-\d{10}|t-[0-9A-Za-z_-]{1,100}|e-[0-9a-f]{16})$/;
export function isPersonKey(key) {
  if (typeof key !== 'string') return false;
  const row = ROW_KEY.exec(key);
  return row ? Number(row[1]) <= 2147483647 : OTHER_KEY.test(key);
}

// Channel tokens: the list payload's `channels` and `channel` strings, and
// thread rows mapped through threadChannel(). Email, Zola and Google Voice
// arrive with pieces 3 and 4; their labels are ready.
const CHANNEL_LABELS = {
  thumbtack: 'Thumbtack',
  text_888: 'Text 888',
  text_1922: 'Text 1922',
  text_0082: 'Text 0082',
  staff_text: 'Staff text',
  email: 'Email',
  zola: 'Zola',
  voice: 'Google Voice',
};
const CHANNEL_ICONS = {
  thumbtack: 'card', text_888: 'chat', text_1922: 'chat', text_0082: 'chat',
  staff_text: 'userplus', email: 'mail', zola: 'book', voice: 'phone',
};

export function channelLabel(token) {
  if (CHANNEL_LABELS[token]) return CHANNEL_LABELS[token];
  const s = String(token || '').replace(/_/g, ' ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

export function channelIcon(token) {
  return CHANNEL_ICONS[token] || 'chat';
}

/** A thread row's channel token. A text with no line is the 888 (spec 5.8). */
export function threadChannel(row) {
  if (!row) return '';
  if (row.channel === 'text') return `text_${row.line || '888'}`;
  return row.channel || '';
}

/** Distinct channel tokens of the thread's messages, first seen first. */
export function threadChannels(thread, sinceIso) {
  const since = sinceIso ? Date.parse(sinceIso) : NaN;
  const out = [];
  for (const row of thread || []) {
    if (!row || row.direction === 'system') continue;
    if (!Number.isNaN(since) && Date.parse(row.at) < since) continue;
    const token = threadChannel(row);
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

/** "Text 1922" for one channel, else "2 channels" (the phone's MESSAGES head). */
export function channelCount(tokens) {
  const list = tokens || [];
  if (list.length === 0) return '';
  if (list.length === 1) return channelLabel(list[0]);
  return `${list.length} channels`;
}

/** "Text 1922 + Email" (the desktop thread header). */
export function channelJoin(tokens) {
  return (tokens || []).map(channelLabel).join(' + ');
}

/**
 * The wait since `sinceIso`: the rail's number and unit, the long and short
 * forms, and whether it is hot (red at 24 hours, spec 4.1).
 */
export function waitParts(sinceIso, nowMs) {
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return null;
  const mins = Math.max(0, Math.floor((nowMs - since) / 60000));
  const hours = Math.floor(mins / 60);
  const hot = mins >= HOT_HOURS * 60;
  const tone = hot ? 'danger' : mins >= WARN_HOURS * 60 ? 'warn' : 'info';
  if (mins < 60) {
    return { n: String(mins), unit: 'MIN', long: `${mins} min`, short: `${mins}m`, hot, tone };
  }
  if (hours < 48) {
    let long = `${hours} hrs`;
    if (hours === 1) long = mins % 60 ? `1 hr ${mins % 60} min` : '1 hr';
    return { n: String(hours), unit: hours === 1 ? 'HR' : 'HRS', long, short: `${hours}h`, hot, tone };
  }
  const days = Math.floor(hours / 24);
  return { n: String(days), unit: 'DAYS', long: `${days} days`, short: `${days}d`, hot, tone };
}

// "Zul's on it", "Dallas is on it" (spec 4.1).
function onItLabel(name) {
  const who = String(name || '').trim() || 'Someone';
  return /s$/i.test(who) ? `${who} is on it` : `${who}'s on it`;
}

/**
 * The one state chip (spec 4.1, in priority order on the server). On an item
 * the viewer opened deliberately, "Not read yet" is no longer true for them,
 * so `deliberate` drops it while the seen write lands.
 */
export function stateChip(state, { deliberate = false } = {}) {
  if (!state || !state.type) return null;
  if (state.type === 'claim') {
    return state.mine ? { kind: 'ok', label: "You're on it" } : { kind: 'info', label: onItLabel(state.by_name) };
  }
  if (state.type === 'promise') {
    return { kind: 'warn', label: state.mine ? "You said you'd follow up" : 'Follow-up promised' };
  }
  if (state.type === 'reopened') return { kind: 'neutral', label: 'Reopened' };
  if (state.type === 'unseen') return deliberate ? null : { kind: 'accent', label: 'Not read yet' };
  return null;
}

/**
 * The line beside the chip on an opened item: who promised and what they
 * said ("You said Monday"), or when a claim was made ("since Mon 11:02 AM").
 */
export function stateNote(state, nowMs) {
  if (!state) return null;
  if (state.type === 'promise' && state.promised_by) {
    if (state.mine) return `You said ${state.promised_by}`;
    if (state.by_name) return `${state.by_name} said ${state.promised_by}`;
    return `Promised ${state.promised_by}`;
  }
  if (state.type === 'claim' && state.since) return `since ${stampLabel(state.since, nowMs)}`;
  return null;
}

/**
 * A moment as the Inbox prints it: "5:41 PM" today, "Wed 8:00 AM" within six
 * days either way, else "Thu Oct 15, 8:00 AM". Chicago time.
 */
export function stampLabel(iso, nowMs) {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const day = chicagoDay(new Date(at).toISOString());
  const today = chicagoDay(new Date(nowMs).toISOString());
  const time = chicagoTime(at);
  if (day === today) return time;
  const apart = Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
  if (Math.abs(apart) <= 6) return `${chicagoWeekday(at)} ${time}`;
  return `${chicagoWeekdayDate(at)}, ${time}`;
}

/** "12 min ago", "3 hrs ago", "2 days ago" (the feeds line, spec 4.6). */
export function agoLabel(iso, nowMs) {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'never';
  const mins = Math.max(0, Math.floor((nowMs - at) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? '1 hr ago' : `${hours} hrs ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

const AI_LINES = {
  off: 'AI read off',
  paused: 'AI read paused at its daily cap',
  failing: 'AI read failing',
};

// Display names for the sources that are not a line number (the design's
// feed row: "Gmail 4 min ago", "Zola 1 hr ago").
const FEED_NAMES = { thumbtack: 'Thumbtack', gmail: 'Gmail', zola: 'Zola' };
// The Gmail feed's status when it is not on (spec 2026-10-14 sections 4.6
// and 12), in the AI status line's style: the words replace the time.
const GMAIL_LINES = {
  off: 'Gmail off',
  failing: 'Gmail failing',
  catching_up: 'Gmail catching up',
};

/**
 * The feeds line (spec 4.6): each source and when it last delivered, a quiet
 * dot at 48 hours (the server's `quiet`), and the AI read's status when it is
 * not on. The hover title carries the Chicago clock time with "CT". Gmail's
 * time is its last good sync, not its last mail, and a Gmail status other
 * than on says so in place of the time.
 */
export function feedItems(feeds, ai, nowMs) {
  const items = (feeds || []).map((f) => {
    const name = FEED_NAMES[f.source] || String(f.source || '');
    const gmail = f.source === 'gmail';
    const when = f.last_at ? `${chicagoWeekdayDate(f.last_at)}, ${chicagoTime(f.last_at)} CT` : null;
    const statusLine = gmail ? GMAIL_LINES[f.status] : null;
    if (statusLine) {
      return {
        key: `feed-${f.source}`,
        text: statusLine,
        quiet: true,
        title: when ? `${statusLine}; last good sync ${when}` : statusLine,
      };
    }
    let title = `${name} has delivered nothing yet`;
    if (when) title = gmail ? `${name} last synced ${when}` : `${name} last delivered ${when}`;
    else if (gmail) title = `${name} has not synced yet`;
    return {
      key: `feed-${f.source}`,
      text: `${name} ${f.last_at ? agoLabel(f.last_at, nowMs) : 'never'}`,
      quiet: !!f.quiet,
      title,
    };
  });
  const status = ai && ai.status;
  if (AI_LINES[status]) items.push({ key: 'ai', text: AI_LINES[status], quiet: true, title: AI_LINES[status] });
  return items;
}

const WHO = {
  D: { label: 'D', cls: 'ib-who ib-who-d', title: 'Dallas' },
  Z: { label: 'Z', cls: 'ib-who ib-who-z', title: 'Zul' },
  AI: { label: 'AI', cls: 'ib-who ib-who-ai', title: 'Closed by the system' },
};

/** Recently handled, grouped by Chicago day, newest first, each row with what
 * they needed beside why it closed (spec 4.5). */
export function handledGroups(rows, nowMs) {
  const sorted = (rows || []).slice().sort((a, b) => Date.parse(b.closed_at) - Date.parse(a.closed_at));
  const now = new Date(nowMs);
  const groups = [];
  let g = null;
  let lastDay = null;
  for (const r of sorted) {
    // The day label once per Chicago day, not once per row (as threadModel).
    const ymd = chicagoDay(r.closed_at);
    if (!g || ymd !== lastDay) {
      g = { day: chicagoDayLabel(r.closed_at, now), items: [] };
      groups.push(g);
      lastDay = ymd;
    }
    g.items.push({
      key: r.person_key,
      personKey: r.person_key,
      name: r.name,
      need: r.need || '',
      time: chicagoTime(r.closed_at),
      reason: r.reason_text || '',
      who: WHO[r.by] || null,
      channel: channelLabel(r.channel),
    });
  }
  return groups;
}

/**
 * Snooze presets (spec 4.4): 3 hours; tomorrow 8:00 AM; or a day in the next
 * seven at 8:00 AM, all Chicago. Tomorrow through a week out keeps every pick
 * inside the server's 8-day limit.
 */
export function snoozeOptions(nowMs) {
  const today = chicagoDay(new Date(nowMs).toISOString());
  const three = new Date(nowMs + 3 * 3600 * 1000).toISOString();
  const tomorrow = chicagoInstant(addDays(today, 1), 8, 0).toISOString();
  const days = [1, 2, 3, 4, 5, 6, 7].map((i) => {
    const ymd = addDays(today, i);
    const until = chicagoInstant(ymd, 8, 0).toISOString();
    return {
      key: ymd,
      dow: chicagoWeekday(until).toUpperCase(),
      day: String(Number(ymd.slice(8, 10))),
      until,
      label: `${chicagoWeekdayDate(until)}, 8:00 AM`,
    };
  });
  return {
    presets: [
      { key: '3h', icon: 'clock', label: '3 hours', until: three, when: stampLabel(three, nowMs) },
      { key: 'tomorrow', icon: 'sun', label: 'Tomorrow morning', until: tomorrow, when: `${chicagoWeekday(tomorrow)} 8:00 AM` },
    ],
    days,
  };
}

/** "It's 10:40 PM for them", outside 8 AM to 9 PM Chicago (spec 4.3). */
export function lateNote(nowMs) {
  const hour = chicagoHour(nowMs);
  if (hour === null || (hour >= 8 && hour < 21)) return null;
  return `It's ${chicagoTime(nowMs)} for them`;
}

/** The opted-out notice (spec 4.3); the date is omitted when unknown. */
export function optOutText(optedOut) {
  const since = optedOut && optedOut.since ? chicagoDay(optedOut.since) : '';
  const lead = since ? `Texts are off for this person since ${fmtDate(since)}.` : 'Texts are off for this person.';
  return `${lead} Texts from 888, 1922 or 0082 will not deliver.`;
}

/** "Last good load 2:12 PM CT · 8 were waiting" (spec 4.7). */
export function lastGoodLine(lastGood) {
  if (!lastGood || !lastGood.at) return null;
  const time = chicagoTime(lastGood.at);
  if (!time) return null;
  const n = Number(lastGood.waiting) || 0;
  return `Last good load ${time} CT · ${n} ${n === 1 ? 'was' : 'were'} waiting`;
}

/** Waiting rows, longest wait first (the server sorts; this keeps it so). */
export function sortWaiting(rows) {
  return (rows || []).slice().sort((a, b) => Date.parse(a.waiting_since) - Date.parse(b.waiting_since));
}

/** The person the desktop selects on its own: the longest wait, `except` aside. */
export function firstWaitingKey(rows, except) {
  const row = sortWaiting(rows).find((r) => r.person_key !== except);
  return row ? row.person_key : null;
}

/**
 * The claim button (spec 4.4): On it; on your own claim it releases; on
 * someone else's it takes over ("Take over" on the phone, "Take over from
 * Zul" on the desktop, the design's two labels).
 */
export function claimButton(state) {
  if (state && state.type === 'claim' && state.mine) {
    return { action: 'release', label: "You're on it", longLabel: "You're on it", icon: 'check', mine: true, takeoverFrom: null };
  }
  if (state && state.type === 'claim') {
    const who = state.by_name || 'them';
    return { action: 'claim', label: 'Take over', longLabel: `Take over from ${who}`, icon: 'userplus', mine: false, takeoverFrom: state.by_name || null };
  }
  return { action: 'claim', label: 'On it', longLabel: 'On it', icon: 'pin', mine: false, takeoverFrom: null };
}
