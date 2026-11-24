// The Google Voice web flow (spec section 10) as Playwright glue. It only reads
// the DOM into plain values and acts; every judgment lives in pageLogic.js and
// interstitial.js, where it is unit tested. Selectors are the 2026-10-17
// spike's, which sent one real post byte-exact.
//
// THE CALL-DIALER TRAP: the input "Enter a name or number" is the Call panel's
// dialer, not a message recipient. Nothing here clicks, focuses or types into
// it; its value is only ever READ, to prove it empty before Send.
const { classifyPage } = require('./interstitial');
const {
  oneSendToEntry, oneRecipientChip, threadItemMatches, threadBids, hasToken, fillCheck,
} = require('./pageLogic');

const GV_MESSAGES_URL = 'https://voice.google.com/u/0/messages';

const SEL = {
  newMessage: '[aria-label="Send new message"]',
  recipients: '[role=region][aria-label="Select recipients"]',
  recipientInput: 'input[placeholder="Type a name or phone number"]',
  sendToCandidates: 'gv-contact-list div',
  removeChip: 'button[aria-label^="Remove"]',
  // The message box, by its aria-label only: Google drops the placeholder
  // attribute while the box holds text (seen 2026-11-24), so a placeholder
  // match would lose the box right after the fill and leave the body in the
  // composer. The label was "Type a message" on 2026-10-17 and is "Text
  // message" now. A label this does not know fails at the wait, before
  // anything is typed, so the post falls back.
  messageBox: 'textarea[aria-label="Text message"], textarea[aria-label="Type a message"]',
  sendButton: 'button[aria-label="Send message"]',
  // Read-only (the trap above).
  callPanelInputs: '[role=region][aria-label="Call panel"] input, input[aria-label="Enter a name or number"], input[placeholder="Enter a name or number"]',
  threadList: 'gv-thread-list',
  threadItem: 'gv-thread-list-item',
  // A Thumbtack notice links /request/{r}/bids/{bid}/messages; also match it percent-encoded.
  noticeLinks: 'a[href*="/bids/"], a[href*="%2Fbids%2F" i]',
};

const UI_STEP_TIMEOUT_MS = 8000;
const SETTLE_MS = 20000; // GV renders client-side; nothing is there at domcontentloaded
const THREAD_SETTLE_MS = 2500;
const SEND_TO_WAIT_MS = 8000;
const CHIP_SETTLE_MS = 2000;
const FILL_SETTLE_MS = 800;
const TYPE_DELAY_MS = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// thumbtack-agent's humanPause: a random 0.3 to 1.0 s between UI actions.
const humanPause = () => sleep(300 + Math.floor(Math.random() * 700));
const hostOf = (url) => {
  try { return new URL(url).host; } catch { return ''; }
};

// Every iframe's src and rendered size (the reCAPTCHA challenge check).
function readFrames(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('iframe')).map((f) => {
    const r = f.getBoundingClientRect();
    return { src: f.src || '', w: r.width, h: r.height };
  }));
}

// What GV left us on: 'ok' | 'session_expired' | 'challenge'. Waits (bounded)
// for the compose control or a hop off voice.google.com, then reads only
// structural text: the title, headings, and short control labels outside the
// conversation list (never message content).
async function classify(page) {
  const newMessage = page.locator(SEL.newMessage).first();
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    if (hostOf(page.url()) !== 'voice.google.com') break;
    if (await newMessage.isVisible().catch(() => false)) break;
    await sleep(500);
  }
  const texts = await page.evaluate(() => {
    const out = [document.title];
    const outsideList = (el) => !el.closest('gv-thread-list');
    for (const el of document.querySelectorAll('h1, h2, h3, [role="heading"]')) {
      if (outsideList(el)) out.push((el.innerText || '').slice(0, 120));
    }
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      if (!outsideList(el)) continue;
      const label = (el.getAttribute('aria-label') || el.innerText || '').trim().split('\n')[0];
      if (label && label.length <= 60) out.push(label);
    }
    return out;
  });
  return classifyPage({ host: hostOf(page.url()), texts, frames: await readFrames(page) });
}

// Every own-text run and link target outside the editors and the conversation
// list: what the open thread shows. Own text nodes (not leaf textContent) so a
// token is found even when its element also holds other children.
function readMessageTexts(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('textarea, input, gv-thread-list')) continue;
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
      if (own.trim()) out.push(own);
      if (el.tagName === 'A') out.push(el.getAttribute('href') || '');
    }
    return out;
  });
}

// The first three lines of each rendered conversation-list item (avatar text,
// then the title and its screen-reader twin).
function readThreadItemLines(items) {
  return items.evaluateAll((els) => els.map((el) => (el.innerText || '')
    .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 3)));
}

// The list is a cdk virtual scroll that renders about 17 conversations at a
// time, so an older thread is found by scrolling its viewport (the spike's
// read-only gv-find.js move; it never clicks or opens anything). Bounded:
// about 140 conversations, about 6 s when nothing matches.
const LIST_SCROLL_PASSES = 8;
const LIST_SCROLL_SETTLE_MS = 700;

async function findThreadItem(page, items, phone) {
  for (let pass = 0; ; pass += 1) {
    const idx = (await readThreadItemLines(items)).findIndex((lines) => threadItemMatches(lines, phone));
    if (idx >= 0 || pass >= LIST_SCROLL_PASSES) return idx;
    const moved = await page.evaluate(() => {
      const vp = document.querySelector('gv-thread-list cdk-virtual-scroll-viewport')
        || document.querySelector('cdk-virtual-scroll-viewport');
      if (!vp) return false;
      const before = vp.scrollTop;
      vp.scrollTop = before + vp.clientHeight * 0.9;
      return vp.scrollTop !== before;
    });
    if (!moved) return -1;
    await sleep(LIST_SCROLL_SETTLE_MS);
  }
}

// If the one-to-one conversation with the number is in the list, open it and
// read every Thumbtack notice in it (threadBids judges them: any one naming
// the job's bid passes). Opening marks it read on the owner's phone, which the
// send would do anyway (plan decision 7).
// Returns { ok: true, existed, bidIds } or { ok: false, reason }.
async function openThreadIfAny(page, phone, negotiationId = null) {
  const listUp = await page.locator(SEL.threadList).first()
    .waitFor({ state: 'attached', timeout: UI_STEP_TIMEOUT_MS }).then(() => true).catch(() => false);
  if (!listUp) return { ok: false, reason: 'ui_error_before_send' };
  const items = page.locator(SEL.threadItem);
  await items.first().waitFor({ state: 'attached', timeout: UI_STEP_TIMEOUT_MS }).catch(() => {});
  const idx = await findThreadItem(page, items, phone);
  if (idx < 0) return { ok: true, existed: false, bidIds: [] };
  await humanPause();
  // The virtual scroll recycles nodes: re-read the item right before the click.
  const target = items.nth(idx);
  const again = await target.evaluate((el) => (el.innerText || '')
    .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 3));
  if (!threadItemMatches(again, phone)) return { ok: false, reason: 'ui_error_before_send' };
  await target.click();
  await sleep(THREAD_SETTLE_MS);
  const hrefs = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel))
    .filter((a) => !a.closest('gv-thread-list'))
    .map((a) => a.getAttribute('href') || ''), SEL.noticeLinks);
  const { bidIds, wrongThread } = threadBids(hrefs, negotiationId);
  if (wrongThread) return { ok: false, reason: 'wrong_thread' };
  return { ok: true, existed: true, bidIds };
}

// Is the proposal token already in the open thread (spec law 6)? The dry
// run's read; a job reads readTokenMessages instead.
async function threadHasToken(page, token) {
  return hasToken(await readMessageTexts(page), token);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The text of each thread message that holds the token, for the paste rule
// and the before and after count of a click. A hit is found exactly as
// readMessageTexts finds one (an own-text run or a link target, outside the
// editors and the conversation list); its message is the nearest box that is
// not inline, climbing from the hit, so the link and the words around it read
// as one text. Two hits in one box are one message, and a box inside another
// hit box counts once, as the outer. No GV class name is relied on: a message
// GV renders in pieces (a shortened link, a preview card) reads as text that
// is not a known body, which the paste rule takes as a paste, the safe side.
async function readTokenMessages(page, token) {
  const t = String(token == null ? '' : token).trim().toLowerCase();
  if (!UUID_RE.test(t)) return []; // never an empty token, as hasToken
  return page.evaluate((tok) => {
    const inline = (el) => ['inline', 'contents'].includes(getComputedStyle(el).display);
    const units = new Set();
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('textarea, input, gv-thread-list')) continue;
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
      const href = el.tagName === 'A' ? (el.getAttribute('href') || '') : '';
      if (!own.toLowerCase().includes(tok) && !href.toLowerCase().includes(tok)) continue;
      let unit = el;
      while (inline(unit) && unit.parentElement && unit.parentElement !== document.body) unit = unit.parentElement;
      units.add(unit);
    }
    const all = Array.from(units);
    return all.filter((u) => !all.some((o) => o !== u && o.contains(u)))
      .map((u) => u.innerText || u.textContent || '');
  }, t);
}

// The gv-contact-list Send-to candidates, for oneSendToEntry.
function readSendToEntries(candidates) {
  return candidates.evaluateAll((els) => els.map((e) => {
    let own = '';
    for (const n of e.childNodes) if (n.nodeType === 3) own += n.textContent;
    const r = e.getBoundingClientRect();
    return {
      ownText: own,
      w: r.width,
      h: r.height,
      containsOther: els.map((o, j) => (o !== e && e.contains(o) ? j : -1)).filter((j) => j >= 0),
    };
  }));
}

// The proven new-message flow, for a new or an existing conversation (GV
// appends to the existing one). Returns { ok: true } or { ok: false, reason }.
async function composeTo(page, phone) {
  const last10 = String(phone).replace(/\D/g, '').slice(-10);
  await humanPause();
  await page.locator(SEL.newMessage).first().click();
  const region = page.locator(SEL.recipients).first();
  const input = region.locator(SEL.recipientInput).first();
  const ready = await input.waitFor({ state: 'visible', timeout: UI_STEP_TIMEOUT_MS })
    .then(() => true).catch(() => false);
  if (!ready) return { ok: false, reason: 'ui_error_before_send' };
  await humanPause();
  await input.click();
  await input.fill('');
  // Key by key, never the +1: a one-go fill shows no suggestion, and Enter
  // in this field does not add the number.
  await input.pressSequentially(last10, { delay: TYPE_DELAY_MS });

  const candidates = page.locator(SEL.sendToCandidates).filter({ hasText: /^\s*Send to/i });
  let idx = -1;
  const deadline = Date.now() + SEND_TO_WAIT_MS;
  while (idx < 0 && Date.now() < deadline) {
    await sleep(500);
    idx = oneSendToEntry(await readSendToEntries(candidates), phone);
  }
  if (idx < 0) return { ok: false, reason: 'ui_error_before_send' };
  await humanPause();
  await candidates.nth(idx).click();
  await sleep(CHIP_SETTLE_MS);

  const chips = await region.evaluate((reg, sel) => {
    const field = reg.querySelector('input'); // after a pick its placeholder reads "Add recipients"
    return {
      labels: Array.from(reg.querySelectorAll(sel)).map((b) => b.getAttribute('aria-label') || ''),
      inputValue: field ? field.value : null,
    };
  }, SEL.removeChip);
  if (!oneRecipientChip(chips.labels, phone, chips.inputValue)) return { ok: false, reason: 'ui_error_before_send' };
  return { ok: true };
}

// Fill the body in one go (never key by key: Enter sends in GV) and read back
// everything fillCheck judges. Returns { ok: true } or { ok: false, reason }.
async function fillAndCheck(page, body) {
  // Exactly one rendered message box, or nothing is typed: a thread opened
  // before the compose may leave its own composer in the page.
  const shown = page.locator(SEL.messageBox).filter({ visible: true });
  const ready = await shown.first().waitFor({ state: 'visible', timeout: UI_STEP_TIMEOUT_MS })
    .then(() => true).catch(() => false);
  if (!ready) return { ok: false, reason: 'ui_error_before_send' };
  if ((await shown.count()) !== 1) return { ok: false, reason: 'ui_error_before_send' };
  const box = shown.first();
  await humanPause();
  await box.fill(body);
  await sleep(FILL_SETTLE_MS);
  const value = await box.inputValue();
  // Still exactly one after the fill: a box that appeared since the count
  // above would make the read and the Send button ambiguous.
  if ((await shown.count()) !== 1) return { ok: false, reason: 'ui_error_before_send' };
  const callPanelValues = await page.locator(SEL.callPanelInputs).evaluateAll((els) => els.map((e) => e.value || ''));
  const frames = await readFrames(page);
  const send = page.locator(SEL.sendButton).filter({ visible: true });
  const sendCount = await send.count();
  const sendEnabled = sendCount === 1 ? await send.first().isEnabled() : false;
  return fillCheck({ value, body, callPanelValues, frames, sendCount, sendEnabled });
}

async function clickSend(page) {
  await page.locator(SEL.sendButton).filter({ visible: true }).first().click();
}

// One read of the post-send proof; the caller polls it for up to 20 s and
// compares tokenCount with the same read taken right before the click.
async function readVerify(page, token) {
  const messages = await readTokenMessages(page, token);
  // The one rendered message box's value; none or several reads as null
  // (unreadable), which can only lose a 'sent', never make one.
  const boxValue = await page.evaluate((sel) => {
    const shown = [...document.querySelectorAll(sel)].filter((ta) => {
      const r = ta.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    });
    return shown.length === 1 ? shown[0].value : null;
  }, SEL.messageBox);
  return { tokenCount: messages.length, boxEmpty: boxValue === null ? null : boxValue === '' };
}

// Empty the message box after a check that did not lead to a click, so no
// filled draft is left behind. Returns what is left in it (null: no box).
async function clearComposer(page) {
  const box = page.locator(SEL.messageBox).filter({ visible: true }).first();
  if (!(await box.isVisible().catch(() => false))) return null;
  await box.fill('');
  return box.inputValue();
}

module.exports = {
  GV_MESSAGES_URL, UI_STEP_TIMEOUT_MS,
  classify, openThreadIfAny, threadHasToken, readTokenMessages, composeTo, fillAndCheck, clickSend, readVerify,
  clearComposer,
};
