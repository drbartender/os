// The gmail_sync tick (spec 2026-10-14 section 5.5) with an injected Gmail
// stub and a recording in-memory db: nothing here reaches Google or the dev
// DB. The stub db answers only the statements gmailSync.js and zolaLeads.js
// send and throws on anything else, so a new statement cannot pass unseen;
// gmailSync.db.test.js runs the same statements against Postgres. Every
// positive tick test injects deps.client and asserts a non-zero stored count
// (carry-forward item 3: with no key, createGmailClient() returns null and a
// forgotten stub would read as "feed off"). Every person, address and body
// here is invented.
const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { GmailError, GMAIL_MAILBOX, __resetGmailClient } = require('../gmailClient');
const { buildPeopleIndex } = require('./people');
const {
  makeGmailSyncTick, ensureStateRow, claimLease, releaseLease, SQL, FAIL_WARN_MS, _resetGmailSyncForTest,
  readCursor, resyncAfter, errorClassOf,
} = require('./gmailSync');
const {
  GMAIL_SYNC_MAX_PER_TICK, GMAIL_SYNC_TICK_MS, GMAIL_SKIP_ATTEMPTS, ZOLA_VENDOR_ADDRESS, INBOX_HISTORY_START, PERSONAL_ALIAS,
} = require('./constants');

// The listing's after: value is epoch seconds (Gmail reads YYYY/MM/DD at
// Pacific midnight).
const FLOOR = String(Math.floor(Date.parse(INBOX_HISTORY_START) / 1000));
const cursorJson = (over) => JSON.stringify({ after: FLOOR, phase: 'sent', page: null, done: [], ...over });

const T = (iso) => new Date(iso);
const INDEX = buildPeopleIndex({
  env: {},
  clients: [{ id: 501, name: 'Alex B', phone: null, email: 'alex.b@example.com', created_at: T('2026-09-01T00:00:00Z') }],
  operators: [{ id: 1, role: 'admin', phone: null, presence_nudge_phone: null, email: 'op-one@example.com', name: 'Op One' }],
});
const ADDRESS = 'jamie.q@example.com';
const BODY = 'Secret body words about the fourteenth';
const SUBJECT = 'Private subject line';

// ─── the stub db ───
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const NORM_SQL = Object.fromEntries(Object.entries(SQL).map(([k, v]) => [norm(v), k]));

class DatabaseError extends Error {
  constructor(message) {
    super(message);
    this.code = '22001';
  }
}

// hook(name, params), when given, runs before every statement (BEGIN, COMMIT
// and ROLLBACK by those names) and may throw: a database in trouble. known
// lists the people the personal lookup finds: [{ address, at }], each known
// from `at` on (personalMail.js; gmailSync.db.test.js runs the real one).
function fakeDb({
  failInsertFor = new Set(), failLeadsFor = new Set(), raceIds = new Set(), hook = null, connectError = null, known = [],
} = {}) {
  const s = {
    state: null, messages: new Map(), skips: new Map(), leads: [], nextId: 1, nextLead: 1, released: 0,
  };
  const log = [];
  let snap = null;
  const copy = () => structuredClone({
    state: s.state, messages: s.messages, skips: s.skips, leads: s.leads, nextId: s.nextId, nextLead: s.nextLead,
  });
  const rows = (r = []) => ({ rows: r, rowCount: r.length });
  const ownerOk = (owner) => s.state && s.state.lease_owner === owner;
  // An UPDATE's answer: rowCount 1 when the lease owner matched, as Postgres says.
  const updated = (ok) => ({ rows: [], rowCount: ok ? 1 : 0 });
  const handlers = {
    ensureState: () => {
      if (!s.state) {
        s.state = {
          history_id: null, backfill_page: null, backfill_done: false, lease_owner: null, lease_until: null,
          last_ok_at: null, last_error: null, consecutive_errors: 0,
        };
      }
      return rows();
    },
    claim: ([owner, secs]) => {
      const st = s.state;
      if (!st || !(st.lease_until === null || st.lease_until < new Date() || st.lease_owner === owner)) return rows();
      st.lease_owner = owner;
      st.lease_until = new Date(Date.now() + secs * 1000);
      return rows([{ history_id: st.history_id, backfill_page: st.backfill_page, backfill_done: st.backfill_done, last_ok_at: st.last_ok_at }]);
    },
    release: ([owner]) => {
      const ok = ownerOk(owner);
      if (ok) { s.state.lease_owner = null; s.state.lease_until = null; }
      return updated(ok);
    },
    startList: ([owner, historyId, page]) => {
      const ok = ownerOk(owner);
      if (ok) Object.assign(s.state, { history_id: historyId, backfill_page: page, backfill_done: false });
      return updated(ok);
    },
    savePage: ([owner, page]) => { const ok = ownerOk(owner); if (ok) s.state.backfill_page = page; return updated(ok); },
    finishList: ([owner]) => {
      const ok = ownerOk(owner);
      if (ok) Object.assign(s.state, { backfill_page: null, backfill_done: true });
      return updated(ok);
    },
    saveHistory: ([owner, id]) => { const ok = ownerOk(owner); if (ok) s.state.history_id = id; return updated(ok); },
    tickOk: ([owner]) => {
      const ok = ownerOk(owner);
      if (ok) Object.assign(s.state, { last_ok_at: new Date(), consecutive_errors: 0 });
      return updated(ok);
    },
    tickError: ([cls, owner]) => {
      if (!ownerOk(owner)) return rows();
      s.state.last_error = cls;
      s.state.consecutive_errors += 1;
      return rows([{ consecutive_errors: s.state.consecutive_errors }]);
    },
    storedIds: ([ids]) => rows(ids.filter((id) => s.messages.has(id) && !raceIds.has(id)).map((gmail_id) => ({ gmail_id }))),
    skipRows: ([ids]) => rows(ids.filter((id) => s.skips.has(id))
      .map((id) => ({ gmail_id: id, attempts: s.skips.get(id).attempts, unavailable: s.skips.get(id).unavailable || 0 }))),
    sentRefs: ([ids, thread]) => rows([...s.messages.values()]
      .filter((m) => m.direction === 'out' && (m.kind || 'message') === 'message' && (ids.includes(m.message_id_header) || m.thread_id === thread))
      .map((m) => ({ message_id_header: m.message_id_header, thread_id: m.thread_id }))),
    insert: (p) => {
      const [gmailId] = p;
      if (failInsertFor.has(gmailId)) throw new DatabaseError(`value too long: ${ADDRESS} ${BODY}`);
      if (s.messages.has(gmailId)) return rows();
      const keys = ['gmail_id', 'thread_id', 'direction', 'kind', 'from_address', 'from_name', 'to_addresses', 'subject', 'text', 'attachments', 'message_id_header', 'in_reply_to', 'at', 'bounced_to', 'personal', 'personal_to'];
      const row = Object.fromEntries(keys.map((k, i) => [k, p[i]]));
      row.id = s.nextId++;
      row.failed = false;
      row.zola_lead_id = null;
      s.messages.set(gmailId, row);
      return rows([{ id: row.id }]);
    },
    // The statement's merge, restated (gmailSync.db.test.js runs the real one).
    markBounced: ([ids, to]) => {
      for (const m of s.messages.values()) {
        if (m.direction !== 'out' || !ids.includes(m.message_id_header)) continue;
        const had = m.bounced_to || [];
        if (!to || !to.length || (m.failed && !had.length)) m.bounced_to = null;
        else m.bounced_to = [...new Set([...had, ...to])].sort();
        m.failed = true;
      }
      return rows();
    },
    // The personal judgment's two lookups, restated over the stub's rows.
    knownAt: ([addresses, at]) => rows(addresses.filter((a) => known.some((k) => k.address === a && new Date(k.at) <= new Date(at)))
      .map((address) => ({ address }))),
    answeredInbound: ([inReplyTo, threadId, at]) => {
      const human = [...s.messages.values()].filter((m) => m.direction === 'in' && m.kind === 'message' && !m.zola_lead_id);
      const pick = human.find((m) => inReplyTo && m.message_id_header === inReplyTo)
        || human.filter((m) => m.thread_id === threadId && new Date(m.at) <= new Date(at)).sort((a, b) => (new Date(b.at) - new Date(a.at)) || (b.id - a.id))[0];
      return rows(pick ? [{ personal: pick.personal, from_address: pick.from_address }] : []);
    },
    linkLead: ([leadId, rowId]) => {
      for (const m of s.messages.values()) if (m.id === rowId) m.zola_lead_id = leadId;
      return rows();
    },
    recordSkip: ([id, cls]) => {
      const prev = s.skips.get(id);
      const next = { attempts: prev ? prev.attempts + 1 : 1, last_error: cls };
      s.skips.set(id, next);
      return rows([{ attempts: next.attempts }]);
    },
    clearSkip: ([id]) => { s.skips.delete(id); return rows(); },
    recordUnavailable: ([id, cls]) => {
      const prev = s.skips.get(id);
      const next = { attempts: prev ? prev.attempts : 0, unavailable: (prev ? prev.unavailable || 0 : 0) + 1, last_error: cls };
      s.skips.set(id, next);
      return rows([{ unavailable: next.unavailable }]);
    },
  };
  async function query(sql, params = []) {
    const text = norm(sql);
    log.push({ sql: text, params });
    if (hook) hook(['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text) ? text : NORM_SQL[text] || text, params);
    if (text === 'BEGIN') { snap = copy(); return rows(); }
    if (text === 'COMMIT') { snap = null; return rows(); }
    if (text === 'ROLLBACK') { if (snap) Object.assign(s, snap); snap = null; return rows(); }
    const name = NORM_SQL[text];
    if (name) return handlers[name](params);
    // zolaLeads.js, the writer (its statements are its own, matched by shape).
    if (/^SELECT id FROM zola_leads WHERE lead_uuid = \$1$/.test(text)) return rows();
    if (/^SELECT id, lead_uuid FROM zola_leads WHERE couple_label_key = \$1 AND closed_at IS NULL/.test(text)) {
      return rows(s.leads.filter((l) => l.couple_label_key === params[0]).slice(-1).map((l) => ({ id: l.id, lead_uuid: null })));
    }
    if (/^INSERT INTO zola_leads /.test(text)) {
      if ([...failLeadsFor].some((label) => params[1].includes(label))) throw new DatabaseError('lead insert failed');
      const lead = { id: s.nextLead++, couple_label: params[1], couple_label_key: params[2] };
      s.leads.push(lead);
      return rows([{ id: lead.id }]);
    }
    throw new Error(`stub db: unexpected statement: ${text.slice(0, 80)}`);
  }
  return {
    s, log,
    query,
    connect: async () => {
      if (connectError) throw connectError();
      return { query, release: () => { s.released += 1; } };
    },
    sqlCount: (name) => log.filter((l) => l.sql === norm(SQL[name])).length,
    count: (re) => log.filter((l) => re.test(l.sql)).length,
  };
}

// ─── the Gmail stub ───
const b64 = (str) => Buffer.from(str).toString('base64url');
function mail(id, {
  labels = ['INBOX', 'CATEGORY_PERSONAL'], from = `Jamie Q <${ADDRESS}>`, to = GMAIL_MAILBOX, subject = SUBJECT,
  body = BODY, extra = [], threadId = `th-${id}`, messageId = `<${id}@mail.example.com>`, inReplyTo = null,
  internalDate = Date.parse('2026-10-12T15:00:00Z'),
} = {}) {
  const headers = [['From', from], ['To', to], ['Subject', subject], ['Message-ID', messageId], ...extra];
  if (inReplyTo) headers.push(['In-Reply-To', inReplyTo]);
  return {
    id, threadId, labelIds: labels, internalDate: String(internalDate),
    payload: { mimeType: 'text/plain', headers: headers.map(([name, value]) => ({ name, value })), body: { data: b64(body) } },
  };
}
const bulk = (id) => mail(id, { labels: ['INBOX', 'CATEGORY_UPDATES'], from: 'shop@store.example.com' });
const authPass = 'mx.google.com; dkim=pass header.i=@zola.com header.s=s1 header.b=Ab1; dmarc=pass (p=REJECT) header.from=zola.com';
const authFail = 'mx.google.com; dkim=fail header.i=@zola.com header.s=s1 header.b=Ab1; dmarc=fail (p=REJECT) header.from=zola.com';
const zola = (id, subject, auth = authPass) => mail(id, {
  from: `Zola <${ZOLA_VENDOR_ADDRESS}>`, subject, labels: ['INBOX', 'CATEGORY_UPDATES'], extra: [['Authentication-Results', auth]],
});

const notFound = () => ({ error: new GmailError('GmailNotFoundError', 404, 'api') });
// pages: the second listing pass (everything but Sent); sentPages: the
// first pass, Sent only. pagesFor(q) overrides both.
function gmail({
  messages = [], history = [], latest = '9999', pages = null, sentPages = null, pagesFor = null, historyPageSize = 100,
  profileHistoryId = '5000', overrides = {},
} = {}) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const calls = [];
  const fetched = [];
  const client = {
    calls, fetched,
    getProfile: async () => { calls.push(['getProfile']); return { data: { emailAddress: GMAIL_MAILBOX, historyId: profileHistoryId } }; },
    listMessages: async (args) => {
      calls.push(['listMessages', args]);
      const set = (pagesFor ? pagesFor(args.q) : (args.q.startsWith('in:sent ') ? sentPages : pages)) || [];
      const at = Number(args.pageToken || 0);
      const list = set[at] || [];
      const next = at + 1 < set.length ? String(at + 1) : undefined;
      return { data: { messages: list.map((id) => ({ id, threadId: `th-${id}` })), nextPageToken: next } };
    },
    listHistory: async (args) => {
      calls.push(['listHistory', args]);
      const after = history.filter((r) => BigInt(r.id) > BigInt(args.startHistoryId));
      const start = Number(args.pageToken || 0);
      const slice = after.slice(start, start + historyPageSize);
      const next = start + historyPageSize < after.length ? String(start + historyPageSize) : undefined;
      return { data: { history: slice.length ? slice : undefined, historyId: latest, nextPageToken: next } };
    },
    getMessage: async (id) => {
      calls.push(['getMessage', id]);
      fetched.push(id);
      const m = byId.get(id);
      return m ? { data: structuredClone(m) } : notFound();
    },
    ...overrides,
  };
  return client;
}
// One history record per id, ids added in order, record ids from 1001.
const records = (ids, start = 1001) => ids.map((id, i) => ({ id: String(start + i), messagesAdded: [{ message: { id, labelIds: ['INBOX'] } }] }));

// ─── the harness ───
let sentry;
let cacheCalls;
let clock;
let out;
beforeEach(() => {
  _resetGmailSyncForTest();
  __resetGmailClient();
  sentry = { calls: [], captureMessage(msg, ctx) { this.calls.push({ msg, ctx }); } };
  cacheCalls = 0;
  clock = Date.parse('2026-10-14T15:00:00Z');
  out = [];
  for (const level of ['log', 'warn', 'error']) {
    mock.method(console, level, (...args) => { out.push(args.map(String).join(' ')); });
  }
});
afterEach(() => mock.restoreAll());

function tickFor(client, db, extra = {}) {
  return makeGmailSyncTick({
    client, db, sentry, now: () => clock, loadIndex: async () => INDEX, cache: { invalidate: () => { cacheCalls += 1; } }, ...extra,
  });
}
// A steady-state db: the state row exists, the backfill is done.
function steadyDb(historyId = '1000', opts = {}) {
  const db = fakeDb(opts);
  db.s.state = {
    history_id: historyId, backfill_page: null, backfill_done: true, lease_owner: null, lease_until: null,
    last_ok_at: T('2026-10-14T14:59:00Z'), last_error: null, consecutive_errors: 0,
  };
  return db;
}

// ─── tests ───

test('ensureStateRow then claimLease: inserted once, claimed when free, refused when held, claimed when expired, released', async () => {
  const db = fakeDb();
  await ensureStateRow(db);
  await ensureStateRow(db);
  assert.equal(db.sqlCount('ensureState'), 2);
  const a = await claimLease(db, 'owner-a');
  assert.ok(a, 'claimed when free');
  assert.equal(await claimLease(db, 'owner-b'), null, 'refused while another owner holds an unexpired lease');
  db.s.state.lease_until = new Date(Date.now() - 1000);
  assert.ok(await claimLease(db, 'owner-b'), 'claimed once expired');
  await releaseLease(db, 'owner-a');
  assert.equal(db.s.state.lease_owner, 'owner-b', 'a release names its owner');
  await releaseLease(db, 'owner-b');
  assert.deepEqual([db.s.state.lease_owner, db.s.state.lease_until], [null, null]);

  const fresh = fakeDb();
  const client = gmail({ pages: [['h1']], messages: [mail('h1')] });
  const sum = await tickFor(client, fresh)();
  assert.equal(sum.stored, 1);
  const order = fresh.log.map((l) => NORM_SQL[l.sql]).filter(Boolean);
  assert.deepEqual(order.slice(0, 2), ['ensureState', 'claim'], 'the first tick on an empty table inserts the row, then claims it');
  assert.equal(fresh.s.state.lease_owner, null, 'released at the end');
});

test('a held lease ends the tick before any Gmail call', async () => {
  const db = steadyDb();
  db.s.state.lease_owner = 'another-instance';
  db.s.state.lease_until = new Date(Date.now() + 60000);
  const client = gmail({ history: records(['h1']), messages: [mail('h1')] });
  assert.equal(await tickFor(client, db)(), null);
  assert.equal(client.calls.length, 0);
});

test('the feed is off without a key: null, and no statement is sent', async () => {
  const saved = process.env.GMAIL_SERVICE_ACCOUNT_KEY;
  delete process.env.GMAIL_SERVICE_ACCOUNT_KEY;
  try {
    const db = fakeDb();
    const tick = makeGmailSyncTick({ db, sentry, now: () => clock, loadIndex: async () => INDEX });
    assert.equal(await tick(), null);
    assert.equal(db.log.length, 0);
  } finally {
    if (saved !== undefined) process.env.GMAIL_SERVICE_ACCOUNT_KEY = saved;
  }
});

test('first sync: the profile history id BEFORE any listing, the page cursor, oldest first, backfill_done after the last page', async () => {
  const db = fakeDb();
  // Gmail lists newest first: page 0 holds n3 (newest) then n2; page 1 holds n1.
  const client = gmail({ pages: [['n3', 'n2'], ['n1']], messages: [mail('n1'), mail('n2'), mail('n3')], profileHistoryId: '4242' });
  const sum = await tickFor(client, db)();
  const names = client.calls.map((c) => c[0]);
  assert.equal(names[0], 'getProfile', 'the history id is read before the first page');
  assert.ok(names.indexOf('listMessages') > 0);
  assert.deepEqual(client.fetched, ['n2', 'n3', 'n1'], "each page's ids oldest first");
  const lists = client.calls.filter((c) => c[0] === 'listMessages').map((c) => c[1]);
  assert.deepEqual(lists.map((a) => a.q), [`in:sent after:${FLOOR}`, `-in:sent after:${FLOOR}`, `-in:sent after:${FLOOR}`],
    'Sent first, then everything else, from the history floor in epoch seconds');
  assert.ok(lists.every((a) => a.maxResults <= GMAIL_SYNC_MAX_PER_TICK), 'a page is never larger than the cap');
  assert.equal(lists[2].pageToken, '1');
  assert.equal(sum.stored, 3);
  assert.equal(db.s.state.history_id, '4242');
  assert.equal(db.s.state.backfill_done, true);
  assert.equal(db.s.state.backfill_page, null);
  assert.ok(db.log.some((l) => NORM_SQL[l.sql] === 'startList' && l.params[1] === '4242' && l.params[2] === cursorJson()),
    'the history id and the first cursor are stored together');
  const row = db.s.messages.get('n1');
  assert.deepEqual([row.direction, row.kind, row.from_address, row.from_name, row.subject, row.text], ['in', 'message', ADDRESS, 'Jamie Q', SUBJECT, BODY]);
  assert.deepEqual(row.to_addresses, [GMAIL_MAILBOX]);
  assert.equal(row.at.toISOString(), '2026-10-12T15:00:00.000Z');
});

test('steady state: history ids processed, a message that gains Primary is re-read, a stored one is not, the cursor advances', async () => {
  const db = steadyDb('1000');
  db.s.messages.set('old1', { id: 77, gmail_id: 'old1', direction: 'in', thread_id: 'x', message_id_header: null });
  const history = [
    { id: '1001', messagesAdded: [{ message: { id: 'h1', labelIds: ['INBOX'] } }] },
    { id: '1002', labelsAdded: [{ message: { id: 'dragged' }, labelIds: ['CATEGORY_PERSONAL'] }] },
    { id: '1003', labelsAdded: [{ message: { id: 'old1' }, labelIds: ['CATEGORY_PERSONAL'] }] },
    { id: '1004', labelsAdded: [{ message: { id: 'h1' }, labelIds: ['STARRED'] }] },
  ];
  const client = gmail({ history, latest: '1010', messages: [mail('h1'), mail('dragged')] });
  const sum = await tickFor(client, db)();
  const hist = client.calls.find((c) => c[0] === 'listHistory')[1];
  assert.equal(hist.startHistoryId, '1000');
  assert.deepEqual(hist.historyTypes, ['messageAdded', 'labelAdded']);
  assert.deepEqual(client.fetched, ['h1', 'dragged'], 'a stored message is never fetched again');
  assert.equal(sum.stored, 2);
  assert.equal(db.s.state.history_id, '1010', "the window's newest history id once every id is handled");
  assert.equal(db.s.state.consecutive_errors, 0);
  assert.equal(client.calls.some((c) => c[0] === 'getProfile'), false);
});

test('GmailHistoryGoneError triggers the dated resync from last_ok_at minus one day', async () => {
  const db = steadyDb('1000');
  db.s.state.last_ok_at = T('2026-10-10T15:00:00Z');
  const client = gmail({
    pages: [['r1']], messages: [mail('r1')], profileHistoryId: '7777',
    overrides: { listHistory: async () => ({ error: new GmailError('GmailHistoryGoneError', 404, 'api') }) },
  });
  const sum = await tickFor(client, db)();
  const list = client.calls.find((c) => c[0] === 'listMessages');
  const dayBefore = String(Date.parse('2026-10-09T15:00:00Z') / 1000);
  assert.equal(list[1].q, `in:sent after:${dayBefore}`);
  assert.ok(client.calls.findIndex((c) => c[0] === 'getProfile') < client.calls.findIndex((c) => c[0] === 'listMessages'));
  assert.equal(sum.stored, 1);
  assert.equal(db.s.state.history_id, '7777');
  assert.equal(db.s.state.backfill_done, true, 'one page, so the resync finished in this tick');
  assert.equal(db.s.state.consecutive_errors, 0, 'a lost history is no tick failure');
});

test('a resync that spans ticks keeps its date while last_ok_at moves', async () => {
  const db = steadyDb('1000');
  db.s.state.last_ok_at = T('2026-10-10T15:00:00Z');
  const ids = Array.from({ length: 60 }, (_, i) => `rs${i}`);
  const client = gmail({ pages: [ids.slice(0, 50), ids.slice(50)], messages: ids.map((id) => mail(id)) });
  client.listHistory = async () => ({ error: new GmailError('GmailHistoryGoneError', 404, 'api') });
  const tick = tickFor(client, db);
  const first = await tick();
  assert.equal(first.stored, 50);
  assert.equal(db.s.state.backfill_done, false);
  const second = await tick();
  assert.equal(second.stored, 10);
  const qs = client.calls.filter((c) => c[0] === 'listMessages').map((c) => c[1].q);
  const dayBefore = String(Date.parse('2026-10-09T15:00:00Z') / 1000);
  assert.deepEqual([...new Set(qs)], [`in:sent after:${dayBefore}`, `-in:sent after:${dayBefore}`]);
  assert.equal(db.s.state.backfill_done, true);
});

test('a vanished message is dropped and the window advances', async () => {
  const db = steadyDb('1000');
  const client = gmail({ history: records(['gone', 'h1']), latest: '1100', messages: [mail('h1')] });
  const sum = await tickFor(client, db)();
  assert.deepEqual([sum.stored, sum.dropped, sum.failed], [1, 1, 0]);
  assert.equal(db.s.state.history_id, '1100');
  assert.equal(db.s.state.consecutive_errors, 0);
  assert.equal(db.s.skips.size, 0);
});

test('a backfill page larger than the per-tick cap finishes across ticks', async () => {
  const db = fakeDb();
  const ids = Array.from({ length: 120 }, (_, i) => `p${String(i).padStart(3, '0')}`);
  // Mostly bulk mail (dropped, so it leaves no row), with ten humans.
  const messages = ids.map((id, i) => (i % 12 === 0 ? mail(id) : bulk(id)));
  // The stub ignores maxResults, so the page really is larger than the cap.
  const client = gmail({ pages: [ids], messages });
  const tick = tickFor(client, db);
  const sums = [await tick(), await tick(), await tick()];
  assert.deepEqual(sums.map((x) => x.stored + x.dropped), [50, 50, 20]);
  assert.equal(sums.reduce((n, x) => n + x.stored, 0), 10);
  assert.equal(client.fetched.length, 120, 'no id is fetched twice');
  assert.equal(new Set(client.fetched).size, 120);
  assert.equal(db.s.state.backfill_done, true);
  assert.ok(client.calls.filter((c) => c[0] === 'listMessages').every((c) => c[1].maxResults <= GMAIL_SYNC_MAX_PER_TICK));
});

test('a history window larger than the per-tick cap finishes across ticks, the cursor moving record by record', async () => {
  const db = steadyDb('1000');
  const ids = Array.from({ length: 120 }, (_, i) => `w${i}`);
  const client = gmail({ history: records(ids), latest: '2000', messages: ids.map((id, i) => (i % 10 === 0 ? mail(id) : bulk(id))) });
  const tick = tickFor(client, db);
  const first = await tick();
  assert.equal(first.stored + first.dropped, GMAIL_SYNC_MAX_PER_TICK);
  assert.equal(db.s.state.history_id, '1050', 'the last record whose ids were all handled');
  const second = await tick();
  assert.equal(db.s.state.history_id, '1100');
  const third = await tick();
  assert.equal(db.s.state.history_id, '2000');
  assert.equal([first, second, third].reduce((n, x) => n + x.stored, 0), 12);
  assert.equal(client.fetched.length, 120, 'no id is fetched twice');
});

test('stored ids are skipped before any fetch and do not count toward the cap', async () => {
  const db = steadyDb('1000');
  const ids = Array.from({ length: 70 }, (_, i) => `k${i}`);
  ids.slice(0, 30).forEach((id, i) => db.s.messages.set(id, { id: 900 + i, gmail_id: id, direction: 'in' }));
  const client = gmail({ history: records(ids), latest: '3000', messages: ids.map((id) => mail(id)) });
  const sum = await tickFor(client, db)();
  assert.equal(client.fetched.length, 40);
  assert.equal(sum.stored, 40);
  assert.equal(db.s.state.history_id, '3000');
});

test('bounds: at most GMAIL_SYNC_MAX_PER_TICK messages, and GMAIL_SYNC_TICK_MS of wall time', async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `b${i}`);
  const db = steadyDb('1000');
  const client = gmail({ history: records(ids), messages: ids.map((id) => mail(id)) });
  const sum = await tickFor(client, db)();
  assert.equal(client.fetched.length, GMAIL_SYNC_MAX_PER_TICK);
  assert.equal(sum.stored, GMAIL_SYNC_MAX_PER_TICK);

  const slowDb = steadyDb('1000');
  const slow = gmail({ history: records(ids), messages: ids.map((id) => mail(id)) });
  const get = slow.getMessage;
  slow.getMessage = async (id) => { clock += 10000; return get(id); };
  const slowSum = await tickFor(slow, slowDb)();
  assert.equal(slow.fetched.length, Math.floor(GMAIL_SYNC_TICK_MS / 10000) + 1, 'it stops once the wall time is spent');
  assert.equal(slowSum.stored, slow.fetched.length);
  assert.equal(slowDb.s.state.history_id, String(1000 + slow.fetched.length));
});

test('the cache is invalidated once per tick that stored something, and not on an idle tick', async () => {
  const db = steadyDb('1000');
  const client = gmail({ history: records(['c1', 'c2', 'c3']), latest: '1100', messages: ['c1', 'c2', 'c3'].map((id) => mail(id)) });
  const tick = tickFor(client, db);
  const sum = await tick();
  assert.equal(sum.stored, 3);
  assert.equal(cacheCalls, 1);
  await tick();
  assert.equal(cacheCalls, 1, 'nothing new, nothing invalidated');
});

test('the people index loads only when a message needs it', async () => {
  let loads = 0;
  const db = steadyDb('1000');
  const tick = tickFor(gmail({ history: [], latest: '1000' }), db, { loadIndex: async () => { loads += 1; return INDEX; } });
  await tick();
  assert.equal(loads, 0);
  const busy = tickFor(gmail({ history: records(['l1']), messages: [mail('l1')] }), steadyDb('1000'), { loadIndex: async () => { loads += 1; return INDEX; } });
  assert.equal((await busy()).stored, 1);
  assert.equal(loads, 1);
});

test('the people index failing to load fails the tick, and spends no message attempt', async () => {
  const db = steadyDb('1000');
  const client = gmail({ history: records(['i1', 'i2']), latest: '1100', messages: [mail('i1'), mail('i2')] });
  const broken = tickFor(client, db, { loadIndex: async () => { throw new DatabaseError('index query failed'); } });
  const sum = await broken();
  assert.deepEqual([sum.stored, sum.failed], [0, 0]);
  assert.equal(db.s.skips.size, 0);
  assert.equal(db.s.state.consecutive_errors, 1);
  assert.equal(db.s.state.last_error, 'DatabaseError 22001');
  assert.equal(db.s.state.history_id, '1000');
  assert.equal((await tickFor(client, db)()).stored, 2, 'the next good tick takes the window whole');
});

test('a Zola notice is stored unparsed and linked to a lead by its label, or the dated fallback label', async () => {
  const db = steadyDb('1000');
  const client = gmail({
    history: records(['z1', 'z2', 'z3']), latest: '1100',
    messages: [
      zola('z1', 'New Zola inquiry for Dr. Bartender'),
      zola('z2', 'New message from Alex B & Sam C for Dr. Bartender'),
      zola('z3', 'New message from alex b  &  sam c for Dr. Bartender'),
    ],
  });
  const sum = await tickFor(client, db)();
  assert.deepEqual([sum.stored, sum.unparsed, sum.gateFailed], [3, 3, 0]);
  assert.deepEqual(db.s.leads.map((l) => l.couple_label), ['Zola notice 2026-10-12', 'Alex B & Sam C']);
  const [z1, z2, z3] = ['z1', 'z2', 'z3'].map((id) => db.s.messages.get(id));
  assert.deepEqual([z1.kind, z1.text, z1.direction], ['zola_unparsed', null, 'in']);
  assert.equal(z1.zola_lead_id, db.s.leads[0].id);
  assert.equal(z2.zola_lead_id, db.s.leads[1].id);
  assert.equal(z3.zola_lead_id, db.s.leads[1].id, 'the same couple joins the same lead');
});

test('a Zola notice that fails the gate creates nothing; three in a day send one Sentry warning', async () => {
  const db = steadyDb('1000');
  const ids = ['g1', 'g2', 'g3', 'g4'];
  const client = gmail({
    history: records([...ids, 'ok1']), latest: '1100',
    messages: [...ids.map((id) => zola(id, 'New Zola inquiry for Dr. Bartender', authFail)), mail('ok1')],
  });
  const sum = await tickFor(client, db)();
  assert.deepEqual([sum.stored, sum.gateFailed, sum.dropped], [1, 4, 4]);
  assert.equal(db.s.leads.length, 0);
  assert.equal(db.count(/zola_leads/), 0);
  const warns = sentry.calls.filter((c) => c.ctx.tags.issue === 'zola_gate');
  assert.equal(warns.length, 1);
  assert.deepEqual(warns[0].ctx.extra, { failures_24h: 3 });
  assert.equal(warns[0].msg, 'gmail_sync dropped Zola notices that failed the gate (authentication, or not addressed to us)',
    'the gate counts both refusals; the message names no address and no content');
});

test('a bounce naming our stored Sent row is stored and marks that row failed', async () => {
  const db = steadyDb('1000');
  db.s.messages.set('sent1', {
    id: 50, gmail_id: 'sent1', direction: 'out', thread_id: 'th-sent1', message_id_header: '<sent1@mail.gmail.com>', failed: false,
  });
  const bounce = mail('bn1', {
    from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)',
    inReplyTo: '<sent1@mail.gmail.com>', extra: [['Auto-Submitted', 'auto-replied']],
  });
  const client = gmail({ history: records(['bn1', 'h1']), latest: '1100', messages: [bounce, mail('h1')] });
  const sum = await tickFor(client, db)();
  assert.equal(sum.stored, 2);
  assert.equal(db.s.messages.get('bn1').kind, 'bounce');
  assert.equal(db.s.messages.get('bn1').text, null, 'a delivery report quotes our own mail; its text is not kept');
  assert.equal(db.s.messages.get('sent1').failed, true);
});

test('the insert gate: a re-processed id whose insert returns no row runs no side effect', async () => {
  // Another instance stored these between our pre-check and our insert.
  const raced = new Set(['zr', 'br']);
  const db = steadyDb('1000', { raceIds: raced });
  db.s.messages.set('zr', { id: 61, gmail_id: 'zr', direction: 'in', thread_id: 'th-zr', message_id_header: null });
  db.s.messages.set('br', { id: 62, gmail_id: 'br', direction: 'in', thread_id: 'th-br', message_id_header: null });
  db.s.messages.set('sent1', { id: 63, gmail_id: 'sent1', direction: 'out', thread_id: 't', message_id_header: '<sent1@mail.gmail.com>', failed: false });
  const bounce = mail('br', { from: 'mailer-daemon@googlemail.com', inReplyTo: '<sent1@mail.gmail.com>' });
  const client = gmail({
    history: records(['zr', 'br', 'h1']), latest: '1100',
    messages: [zola('zr', 'New message from Alex B & Sam C for Dr. Bartender'), bounce, mail('h1')],
  });
  const sum = await tickFor(client, db)();
  assert.equal(sum.stored, 1, 'only h1 is new');
  assert.equal(db.count(/zola_leads/), 0, 'no lead row');
  assert.equal(db.sqlCount('linkLead'), 0);
  assert.equal(db.sqlCount('markBounced'), 0, 'no bounce mark');
  assert.equal(db.s.messages.get('sent1').failed, false);
  assert.equal(db.s.state.history_id, '1100', 'a no-op insert still handles the id');
});

test('a failing message: attempts 1, 2, then skipped at 3 with one Sentry capture; it holds the window until then', async () => {
  const db = steadyDb('1000', { failInsertFor: new Set(['bad']) });
  const client = gmail({ history: records(['a1', 'bad', 'c1']), latest: '1100', messages: ['a1', 'bad', 'c1'].map((id) => mail(id)) });
  const tick = tickFor(client, db);

  const one = await tick();
  assert.deepEqual([one.stored, one.failed, one.skipped], [2, 1, 0]);
  assert.equal(db.s.skips.get('bad').attempts, 1);
  assert.equal(db.s.state.history_id, '1001', 'one failure holds the window at the record before it');
  assert.equal(db.s.state.consecutive_errors, 0, 'a message failure is no tick failure');

  const two = await tick();
  assert.deepEqual([two.stored, two.failed, two.skipped], [0, 1, 0]);
  assert.equal(db.s.skips.get('bad').attempts, 2);
  assert.equal(db.s.state.history_id, '1001');

  const three = await tick();
  assert.deepEqual([three.failed, three.skipped], [1, 1]);
  assert.equal(db.s.skips.get('bad').attempts, GMAIL_SKIP_ATTEMPTS);
  assert.equal(db.s.state.history_id, '1100', 'skipped for good, the window advances');
  const captures = sentry.calls.filter((c) => c.ctx.tags.issue === 'skip');
  assert.equal(captures.length, 1);
  assert.deepEqual(captures[0].ctx.extra, { gmail_id: 'bad', error: 'DatabaseError 22001', attempts: 3 });

  db.s.state.history_id = '1000';
  await tick();
  assert.equal(client.fetched.filter((id) => id === 'bad').length, 3, 'a skipped id is never fetched again');
  assert.equal(client.fetched.filter((id) => id === 'c1').length, 1);
  assert.equal(sentry.calls.filter((c) => c.ctx.tags.issue === 'skip').length, 1);
});

test('a failing side effect rolls the row back with it', async () => {
  const db = steadyDb('1000', { failLeadsFor: new Set(['Alex B']) });
  const client = gmail({ history: records(['zf', 'h1']), latest: '1100', messages: [zola('zf', 'New message from Alex B & Sam C for Dr. Bartender'), mail('h1')] });
  const sum = await tickFor(client, db)();
  assert.deepEqual([sum.stored, sum.failed], [1, 1]);
  assert.equal(db.s.messages.has('zf'), false, 'the insert went with the rollback');
  assert.equal(db.s.skips.get('zf').attempts, 1);
  assert.equal(db.s.state.history_id, '1000');
  assert.equal(db.s.released, 2, 'every connection taken is given back');
});

test('a Gmail request error on one message is that message failing, not the tick', async () => {
  const db = steadyDb('1000');
  const client = gmail({ history: records(['rq', 'h1']), latest: '1100', messages: [mail('h1')] });
  const get = client.getMessage;
  client.getMessage = async (id) => (id === 'rq' ? { error: new GmailError('GmailRequestError', 400, 'api') } : get(id));
  const sum = await tickFor(client, db)();
  assert.deepEqual([sum.stored, sum.failed], [1, 1]);
  assert.equal(db.s.skips.get('rq').last_error, 'GmailRequestError:api');
  assert.equal(db.s.state.consecutive_errors, 0);
});

const unavailable = () => ({ error: new GmailError('GmailUnavailableError', 503, 'api') });
// The probe (settlePending) asks getProfile: a real outage leaves it
// unanswered too, while isDown() holds.
function profileDownWhile(client, isDown) {
  const answer = client.getProfile;
  client.getProfile = async () => (isDown() ? (client.calls.push(['getProfile']), unavailable()) : answer());
}

test('a Google outage mid-window keeps the progress made, records the class, and spends nothing', async () => {
  const db = steadyDb('1000');
  const client = gmail({ history: records(['a1', 'b1', 'c1']), latest: '1100', messages: ['a1', 'b1', 'c1'].map((id) => mail(id)) });
  const get = client.getMessage;
  // Down after a1: b1, c1 and the probe (the profile) get no answer.
  let down = false;
  client.getMessage = async (id) => {
    const res = down ? unavailable() : await get(id);
    if (id === 'a1') down = true;
    return res;
  };
  profileDownWhile(client, () => down);
  const tick = tickFor(client, db);
  const sum = await tick();
  assert.equal(sum.stored, 1);
  assert.equal(db.s.state.history_id, '1001');
  assert.equal(db.s.state.consecutive_errors, 1);
  assert.equal(db.s.state.last_error, 'GmailUnavailableError:api');
  assert.equal(db.s.skips.size, 0, 'an outage never spends a message attempt');
  down = false;
  client.getMessage = get;
  const next = await tick();
  assert.equal(next.stored, 2);
  assert.equal(db.s.state.history_id, '1100');
  assert.equal(db.s.state.consecutive_errors, 0);
});

test('three consecutive tick failures turn the feed failing; Sentry hears at most once an hour', async () => {
  const db = steadyDb('1000');
  const client = gmail({ overrides: { listHistory: async () => ({ error: new GmailError('GmailAuthError', 401, 'token') }) } });
  const tick = tickFor(client, db);
  await tick();
  await tick();
  assert.equal(sentry.calls.length, 0);
  await tick();
  assert.equal(db.s.state.consecutive_errors, 3);
  assert.equal(db.s.state.last_error, 'GmailAuthError:token');
  assert.equal(sentry.calls.length, 1);
  assert.deepEqual(sentry.calls[0].ctx.extra, { error: 'GmailAuthError:token', status: 401, consecutive_errors: 3 });
  clock += 10 * 60000;
  await tick();
  assert.equal(sentry.calls.length, 1, 'not again inside the hour');
  clock += FAIL_WARN_MS;
  await tick();
  assert.equal(sentry.calls.length, 2);
  assert.equal(db.s.state.lease_owner, null, 'a failed tick still releases its lease');

  const ok = gmail({ history: records(['h1']), latest: '1100', messages: [mail('h1')] });
  assert.equal((await tickFor(ok, db)()).stored, 1);
  assert.equal(db.s.state.consecutive_errors, 0);
});

test('logs, last_error, the skip row and Sentry carry an error class, never a body, subject or address', async () => {
  const db = steadyDb('1000', { failInsertFor: new Set(['leak']) });
  const client = gmail({ history: records(['leak', 'h1']), latest: '1100', messages: [mail('leak'), mail('h1')] });
  await tickFor(client, db)();
  await tickFor(client, db)();
  const third = await tickFor(client, db)();
  assert.equal(third.skipped, 1);
  const thrower = gmail({ overrides: { listHistory: async () => { throw new Error(`${ADDRESS} ${BODY} ${SUBJECT}`); } } });
  for (let i = 0; i < 3; i += 1) await tickFor(thrower, db)();
  assert.equal(db.s.state.last_error, 'Error');
  const everything = [
    ...out, JSON.stringify(sentry.calls), db.s.state.last_error, JSON.stringify([...db.s.skips.values()]),
  ].join('\n');
  for (const secret of [ADDRESS, BODY, SUBJECT, 'value too long']) {
    assert.equal(everything.includes(secret), false, secret);
  }
  assert.ok(out.some((line) => /^\[gmail_sync\] stored=\d+ dropped=\d+ unparsed=\d+ skipped=\d+ failed=\d+ gateFailed=\d+$/.test(line)),
    'one summary line per tick');
});

test('a tick still running makes the next one return null', async () => {
  const db = steadyDb('1000');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = gmail({ history: records(['h1']), latest: '1100', messages: [mail('h1')] });
  const get = client.getMessage;
  client.getMessage = async (id) => { await gate; return get(id); };
  const tick = tickFor(client, db);
  const first = tick();
  assert.equal(await tick(), null);
  release();
  assert.equal((await first).stored, 1);
});

// ─── the fix round (checkpoint review of Tasks 8a to 8c) ───

test('two unlabeled Zola inquiries on one day are two fresh leads, each message linked to its own', async () => {
  const db = steadyDb('1000');
  const client = gmail({
    history: records(['zi1', 'zi2']), latest: '1100',
    messages: [zola('zi1', 'New Zola inquiry for Dr. Bartender'), zola('zi2', 'New Zola inquiry for Dr. Bartender')],
  });
  const sum = await tickFor(client, db)();
  assert.equal(sum.stored, 2);
  assert.deepEqual(db.s.leads.map((l) => l.couple_label), ['Zola notice 2026-10-12', 'Zola notice 2026-10-12']);
  assert.equal(db.s.messages.get('zi1').zola_lead_id, db.s.leads[0].id);
  assert.equal(db.s.messages.get('zi2').zola_lead_id, db.s.leads[1].id);
  assert.equal(db.count(/FROM zola_leads WHERE couple_label_key/), 0, 'a fallback label is never matched by label');
});

test('a re-processed unlabeled notice creates no lead row', async () => {
  const db = steadyDb('1000', { raceIds: new Set(['zu']) });
  db.s.messages.set('zu', { id: 70, gmail_id: 'zu', direction: 'in', thread_id: 'th-zu', message_id_header: null });
  const client = gmail({ history: records(['zu', 'h1']), latest: '1100', messages: [zola('zu', 'New Zola inquiry for Dr. Bartender'), mail('h1')] });
  const sum = await tickFor(client, db)();
  assert.equal(sum.stored, 1);
  assert.equal(db.count(/zola_leads/), 0);
  assert.equal(db.s.leads.length, 0);
});

test('a page token Gmail refuses restarts that pass of the listing, and the tick ends normally', async () => {
  const db = steadyDb('1000');
  Object.assign(db.s.state, { backfill_done: false, backfill_page: cursorJson({ phase: 'all', page: '7', done: ['x1'] }) });
  const client = gmail({ pages: [['p1']], messages: [mail('p1')] });
  const list = client.listMessages;
  client.listMessages = async (args) => (args.pageToken === '7' ? { error: new GmailError('GmailRequestError', 400, 'api') } : list(args));
  const tick = tickFor(client, db);
  const first = await tick();
  assert.equal(first.stored, 0);
  assert.equal(db.s.state.backfill_page, cursorJson({ phase: 'all' }), 'same pass, from its first page');
  assert.equal(db.s.state.consecutive_errors, 0);
  assert.ok(out.some((l) => l.includes('GmailRequestError:api') && l.includes('page token')));
  assert.equal(sentry.calls.filter((c) => c.ctx.tags.issue === 'page_token').length, 1);
  const second = await tick();
  assert.equal(second.stored, 1);
  assert.equal(db.s.state.backfill_done, true);
});

test('the history listing stops at half the wall time and the tick still makes progress', async () => {
  const db = steadyDb('1000');
  const ids = Array.from({ length: 10 }, (_, i) => `ht${i}`);
  const client = gmail({ history: records(ids), latest: '2000', historyPageSize: 1, messages: ids.map((id) => mail(id)) });
  const list = client.listHistory;
  client.listHistory = async (args) => { clock += 8000; return list(args); };
  const sum = await tickFor(client, db)();
  assert.equal(client.calls.filter((c) => c[0] === 'listHistory').length, 3, 'no page is asked for past half the budget');
  assert.equal(sum.stored, 3);
  assert.equal(db.s.state.history_id, '1003');
  assert.equal(db.s.state.consecutive_errors, 0);
});

test('the history listing stops once it holds four times the cap of ids', async () => {
  const db = steadyDb('1000');
  const ids = Array.from({ length: 1000 }, (_, i) => `hc${i}`);
  const client = gmail({ history: records(ids), latest: '9000', historyPageSize: 100, messages: ids.map((id) => mail(id)) });
  const sum = await tickFor(client, db)();
  assert.equal(client.calls.filter((c) => c[0] === 'listHistory').length, 2);
  assert.equal(sum.stored, GMAIL_SYNC_MAX_PER_TICK);
  assert.equal(db.s.state.history_id, '1050');
});

test('a non-empty window that made no progress is a tick failure named NoProgress, not an ok', async () => {
  const db = steadyDb('1000');
  const client = gmail({ history: records(['np1', 'np2']), latest: '1100', messages: [mail('np1'), mail('np2')] });
  const list = client.listHistory;
  client.listHistory = async (args) => { clock += 45000; return list(args); };
  const tick = tickFor(client, db);
  const sum = await tick();
  assert.equal(sum.stored, 0);
  assert.equal(db.s.state.history_id, '1000');
  assert.deepEqual([db.s.state.consecutive_errors, db.s.state.last_error], [1, 'NoProgress']);
  assert.equal(db.s.state.last_ok_at.toISOString(), '2026-10-14T14:59:00.000Z', 'no tickOk');
  await tick();
  await tick();
  assert.equal(db.s.state.consecutive_errors, 3);
  const warns = sentry.calls.filter((c) => c.ctx.tags.issue === 'failing');
  assert.equal(warns.length, 1);
  assert.equal(warns[0].ctx.extra.error, 'NoProgress');

  const idle = steadyDb('1000');
  await tickFor(gmail({ history: [], latest: '1000' }), idle)();
  assert.equal(idle.s.state.consecutive_errors, 0, 'an empty window is no failure');
});

test('a reply filed in Updates on a newer page than its Sent row is stored: Sent is listed first', async () => {
  const db = fakeDb();
  const sent = mail('s1', { labels: ['SENT'], from: GMAIL_MAILBOX, to: `Jamie Q <${ADDRESS}>`, messageId: '<s1@mail.gmail.com>' });
  const reply = mail('rp', { labels: ['INBOX', 'CATEGORY_UPDATES'], from: 'events@venue.example.com', inReplyTo: '<s1@mail.gmail.com>' });
  const bounce = mail('bn', { from: 'mailer-daemon@googlemail.com', inReplyTo: '<s1@mail.gmail.com>' });
  // Newest first: the reply and the bounce on page 0, their Sent row on page 1.
  const everything = [['rp', 'bn'], ['s1']];
  const client = gmail({
    messages: [sent, reply, bounce],
    pagesFor: (q) => {
      if (q.startsWith('in:sent ')) return [['s1']];
      if (q.startsWith('-in:sent ')) return [['rp', 'bn']];
      return everything;
    },
  });
  const sum = await tickFor(client, db)();
  assert.equal(sum.stored, 3);
  assert.equal(db.s.messages.get('rp').kind, 'message');
  assert.equal(db.s.messages.get('bn').kind, 'bounce');
  assert.equal(db.s.messages.get('s1').failed, true);
  assert.deepEqual(client.fetched, ['s1', 'bn', 'rp']);
  assert.equal(db.s.state.backfill_done, true);
});

test('a skip row is cleared inside the transaction that stores the message, and on a drop', async () => {
  const failing = new Set(['cs', 'cd']);
  const db = steadyDb('1000', { failInsertFor: failing });
  const dropped = bulk('cd');
  const client = gmail({ history: records(['cs']), latest: '1100', messages: [mail('cs')] });
  await tickFor(client, db)();
  assert.equal(db.s.skips.get('cs').attempts, 1);
  failing.delete('cs');
  const from = db.log.length;
  const sum = await tickFor(client, db)();
  assert.equal(sum.stored, 1);
  assert.equal(db.s.skips.has('cs'), false);
  const order = db.log.slice(from).map((l) => NORM_SQL[l.sql] || l.sql).filter((x) => ['BEGIN', 'COMMIT', 'insert', 'clearSkip'].includes(x));
  assert.deepEqual(order, ['BEGIN', 'insert', 'clearSkip', 'COMMIT']);

  db.s.skips.set('cd', { attempts: 2, last_error: 'DatabaseError 22001' });
  db.s.state.history_id = '1000';
  const dropper = gmail({ history: records(['cd']), latest: '1200', messages: [dropped] });
  const drop = await tickFor(dropper, db)();
  assert.equal(drop.dropped, 1);
  assert.equal(db.s.skips.has('cd'), false);
});

test('readCursor: a corrupt, foreign or unbounded cursor starts the listing over from the floor', () => {
  const fresh = { after: FLOOR, phase: 'sent', page: null, done: [] };
  for (const raw of [null, '', 'not json', '42', '{"after":"2026/09/08","phase":"sent"}', cursorJson({ phase: 'later' }), cursorJson({ after: '../x' })]) {
    assert.deepEqual(readCursor(raw), fresh, String(raw));
  }
  assert.deepEqual(readCursor(cursorJson({ phase: 'all', page: '17', done: ['a1', 'bad id', 7, 'b2'] })), { after: FLOOR, phase: 'all', page: '17', done: ['a1', 'b2'] });
  assert.equal(readCursor(cursorJson({ page: 'x'.repeat(2000) })).page, null);
});

test('resyncAfter: last_ok_at minus a day in epoch seconds, never before the floor', () => {
  assert.equal(resyncAfter(null), FLOOR);
  assert.equal(resyncAfter('garbage'), FLOOR);
  assert.equal(resyncAfter(new Date('2026-09-08T12:00:00Z')), FLOOR, 'clamped to the floor');
  assert.equal(resyncAfter(new Date('2026-10-10T15:00:00Z')), String(Date.parse('2026-10-09T15:00:00Z') / 1000));
});

test('errorClassOf: class and stage, a SQLSTATE, never a message', () => {
  assert.equal(errorClassOf(new GmailError('GmailAuthError', 401, 'token')), 'GmailAuthError:token');
  assert.equal(errorClassOf(new DatabaseError(`${ADDRESS} too long`)), 'DatabaseError 22001');
  assert.equal(errorClassOf(new TypeError(BODY)), 'TypeError');
  assert.equal(errorClassOf({ class: 'NoProgress' }), 'NoProgress');
  assert.equal(errorClassOf({ class: `${ADDRESS}` }), 'Error', 'anything outside the safe shape');
  assert.equal(errorClassOf(null), 'Error');
});

// ─── the review round (2026-10-15) ───

const rulesModule = require('./gmailRules');
const { EMAIL_CLIENTS_SQL, PEOPLE_STAFF_SQL, PEOPLE_OPERATORS_SQL } = require('./people');
const dsn = (id, named) => mail(id, {
  from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)',
  inReplyTo: named, extra: [['Auto-Submitted', 'auto-replied']],
});

test('a bounce that names its failed recipients stores them on the bounce and merges them onto the Sent row; one that names none fails it whole', async () => {
  const db = steadyDb('1000');
  db.s.messages.set('sent2', {
    id: 50, gmail_id: 'sent2', direction: 'out', kind: 'message', thread_id: 'th-sent2', message_id_header: '<sent2@mail.gmail.com>',
    failed: false, bounced_to: null,
  });
  // The report's failed recipients, as gmailRules hands them over (bouncedTo).
  const named = new Map([['bc1', [' Bad.Cc@Example.com', 'bad.cc@example.com', 7]], ['bc2', ['other.cc@example.com']], ['bc3', []]]);
  const real = rulesModule.classifyMessage;
  mock.method(rulesModule, 'classifyMessage', (args) => {
    const verdict = real(args);
    const id = args.headers.get('message-id').slice(1, 4);
    return verdict.kind === 'bounce' && named.has(id) ? { ...verdict, bouncedTo: named.get(id) } : verdict;
  });
  const client = gmail({ history: records(['bc1', 'bc2']), latest: '1100', messages: ['bc1', 'bc2'].map((id) => dsn(id, '<sent2@mail.gmail.com>')) });
  assert.equal((await tickFor(client, db)()).stored, 2);
  assert.deepEqual(db.s.messages.get('bc1').bounced_to, ['bad.cc@example.com'], 'lowercased, trimmed, strings only, once');
  assert.deepEqual(db.s.messages.get('bc2').bounced_to, ['other.cc@example.com']);
  const sent = db.s.messages.get('sent2');
  assert.deepEqual([sent.failed, sent.bounced_to], [true, ['bad.cc@example.com', 'other.cc@example.com']]);
  const marks = db.log.filter((l) => NORM_SQL[l.sql] === 'markBounced').map((l) => l.params);
  assert.deepEqual(marks, [[['<sent2@mail.gmail.com>'], ['bad.cc@example.com']], [['<sent2@mail.gmail.com>'], ['other.cc@example.com']]]);

  db.s.state.history_id = '1100';
  const whole = gmail({ history: records(['bc3'], 1101), latest: '1200', messages: [dsn('bc3', '<sent2@mail.gmail.com>')] });
  assert.equal((await tickFor(whole, db)()).stored, 1);
  assert.equal(db.s.messages.get('bc3').bounced_to, null, 'a report that names nobody stores none');
  assert.deepEqual([sent.failed, sent.bounced_to], [true, null], 'and fails every recipient of the mail');
});

test('a mail whose words are only whitespace once its NULs are cut is stored with no text', async () => {
  const db = steadyDb('1000');
  const client = gmail({ history: records(['ws1']), latest: '1100', messages: [mail('ws1', { body: '\u0000 \u0000' })] });
  assert.equal((await tickFor(client, db)()).stored, 1);
  assert.equal(db.s.messages.get('ws1').text, null, 'readGmail reads (text IS NULL) as no words');
});

test('a message Gmail never answers while it answers the rest is held, then skipped for good after 20 ticks; the window moves on', async () => {
  const db = steadyDb('1000');
  const client = gmail({ history: records(['ok1', 'bad', 'ok2']), latest: '1100', messages: ['ok1', 'bad', 'ok2'].map((id) => mail(id)) });
  const get = client.getMessage;
  client.getMessage = async (id) => (id === 'bad' ? (client.fetched.push(id), unavailable()) : get(id));
  const tick = tickFor(client, db);
  const one = await tick();
  assert.deepEqual([one.stored, one.failed, one.skipped], [2, 1, 0]);
  assert.deepEqual([db.s.skips.get('bad').attempts, db.s.skips.get('bad').unavailable], [0, 1], 'its own count, not the three attempts');
  assert.equal(db.s.state.history_id, '1001', 'held at the record before it');
  assert.equal(db.s.state.consecutive_errors, 0, 'one silent message is no tick failure');
  for (let i = 2; i <= 19; i += 1) await tick();
  assert.equal(db.s.skips.get('bad').unavailable, 19);
  assert.equal(db.s.state.history_id, '1001');
  assert.equal(sentry.calls.filter((c) => c.ctx.tags.issue === 'skip').length, 0);
  const twenty = await tick();
  assert.equal(twenty.skipped, 1);
  const captures = sentry.calls.filter((c) => c.ctx.tags.issue === 'skip');
  assert.equal(captures.length, 1);
  assert.deepEqual(captures[0].ctx.extra, { gmail_id: 'bad', error: 'GmailUnavailableError:api', attempts: 20 });
  assert.equal(db.s.state.history_id, '1100', 'skipped for good on the strike that skips it: the window advances that tick');
  await tick();
  assert.equal(client.fetched.filter((id) => id === 'bad').length, 20, 'never fetched again');
  assert.equal(client.fetched.filter((id) => id === 'ok1').length, 1);
  assert.equal(db.s.state.consecutive_errors, 0);
});

test('a real outage (every fetch and the probe unanswered) never spends a message, however long it lasts', async () => {
  const db = steadyDb('1000');
  db.s.messages.set('old1', { id: 9, gmail_id: 'old1', direction: 'in', kind: 'message', thread_id: 'x', message_id_header: null });
  const ids = ['o1', 'o2', 'o3'];
  const client = gmail({ history: records(ids), latest: '1100', messages: ids.map((id) => mail(id)) });
  const get = client.getMessage;
  let down = true;
  client.getMessage = async (id) => (down ? (client.fetched.push(id), unavailable()) : get(id));
  profileDownWhile(client, () => down);
  const tick = tickFor(client, db);
  for (let i = 0; i < 25; i += 1) await tick();
  assert.equal(db.s.skips.size, 0, 'no strike in an outage');
  assert.equal(db.s.state.consecutive_errors, 25);
  assert.equal(db.s.state.history_id, '1000');
  assert.equal(db.s.state.last_error, 'GmailUnavailableError:api', 'the held message\'s class');
  assert.equal(client.calls.filter((c) => c[0] === 'getProfile').length, 25, 'the probe asked Gmail for the profile, once a tick');
  assert.equal(client.fetched.includes('old1'), false, 'never a stored message');
  assert.equal(client.fetched.filter((id) => id === 'o3').length, 0, 'two silent fetches in a row end the window');
  down = false;
  assert.equal((await tick()).stored, 3);
  assert.equal(db.s.state.history_id, '1100');
  assert.equal(db.s.state.consecutive_errors, 0);
});

test('a lone message Gmail does not answer is struck only when the probe gets an answer', async () => {
  const db = steadyDb('1000');
  db.s.messages.set('old1', { id: 9, gmail_id: 'old1', direction: 'in', kind: 'message', thread_id: 'x', message_id_header: null });
  const client = gmail({ history: records(['lone']), latest: '1100', messages: [mail('lone'), mail('old1')] });
  const get = client.getMessage;
  let probeDown = true;
  client.getMessage = async (id) => {
    if (id === 'lone' || probeDown) return (client.fetched.push(id), unavailable());
    return get(id);
  };
  profileDownWhile(client, () => probeDown);
  const tick = tickFor(client, db);
  await tick();
  assert.deepEqual([db.s.skips.size, db.s.state.consecutive_errors], [0, 1], 'no answer anywhere: an outage');
  probeDown = false;
  await tick();
  assert.equal(db.s.skips.get('lone').unavailable, 1, 'Gmail answered the probe: the message is struck');
  assert.equal(db.s.state.consecutive_errors, 0);
});

test('a database in trouble fails the tick, never the message: no SQLSTATE, class 08, 53 and 57P', async () => {
  const cases = [
    ['sentRefs', () => new Error('Connection terminated unexpectedly')],
    ['BEGIN', () => Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })],
    ['insert', () => Object.assign(new Error('connection failure'), { code: '08006' })],
    ['insert', () => Object.assign(new Error('too many connections'), { code: '53300' })],
    ['insert', () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })],
  ];
  for (const [stage, make] of cases) {
    let broken = true;
    const db = steadyDb('1000', { hook: (name) => { if (broken && name === stage) throw make(); } });
    const client = gmail({ history: records(['d1']), latest: '1100', messages: [mail('d1')] });
    const tick = tickFor(client, db);
    for (let i = 0; i < 4; i += 1) await tick();
    assert.equal(db.s.skips.size, 0, `${stage}: no message attempt spent`);
    assert.deepEqual([db.s.state.consecutive_errors, db.s.state.history_id], [4, '1000'], stage);
    broken = false;
    assert.equal((await tick()).stored, 1, `${stage}: the mail is stored once the database is back`);
  }
  const pool = steadyDb('1000', { connectError: () => new Error('timeout exceeded when trying to connect') });
  for (let i = 0; i < 4; i += 1) await tickFor(gmail({ history: records(['d2']), latest: '1100', messages: [mail('d2')] }), pool)();
  assert.deepEqual([pool.s.skips.size, pool.s.state.consecutive_errors], [0, 4], 'a pool that cannot hand out a connection');
  // A value the row refuses is the message's own fault: attempts, then the skip.
  const deterministic = steadyDb('1000', { failInsertFor: new Set(['d3']) });
  await tickFor(gmail({ history: records(['d3']), latest: '1100', messages: [mail('d3')] }), deterministic)();
  assert.equal(deterministic.s.skips.get('d3').attempts, 1);
});

test('Google unavailable on the backfill path: the page keeps what it handled, the tick fails, the next one finishes', async () => {
  const db = fakeDb();
  const client = gmail({ pages: [['c1', 'b1', 'a1']], messages: ['a1', 'b1', 'c1'].map((id) => mail(id)) });
  const get = client.getMessage;
  let down = false;
  client.getMessage = async (id) => {
    const res = down ? unavailable() : await get(id);
    if (id === 'a1') down = true;
    return res;
  };
  profileDownWhile(client, () => down);
  const tick = tickFor(client, db);
  const one = await tick();
  assert.equal(one.stored, 1);
  const cursor = JSON.parse(db.s.state.backfill_page);
  assert.deepEqual([cursor.phase, cursor.done], ['all', ['a1']], 'the ids handled before the outage are kept');
  assert.deepEqual([db.s.state.consecutive_errors, db.s.state.last_error, db.s.skips.size], [1, 'GmailUnavailableError:api', 0]);
  down = false;
  client.getMessage = get;
  const two = await tick();
  assert.equal(two.stored, 2);
  assert.equal(db.s.state.backfill_done, true);
  assert.equal(client.fetched.filter((id) => id === 'a1').length, 1, 'a1 is never fetched again');
});

test('two instances at a deploy: a tick that lost its lease mid-tick moves no cursor, records nothing, and stops at its next cursor write', async () => {
  const db = fakeDb();
  const client = gmail({ pages: [['p1'], ['p2']], messages: [mail('p1'), mail('p2')] });
  const get = client.getMessage;
  client.getMessage = async (id) => {
    // The new instance claims the expired lease while p1 is read.
    if (id === 'p1') Object.assign(db.s.state, { lease_owner: 'instance-b', lease_until: new Date(Date.now() + 60000) });
    return get(id);
  };
  const sum = await tickFor(client, db)();
  assert.equal(sum.stored, 1, 'the insert gate makes the stored mail safe either way');
  assert.deepEqual(client.fetched, ['p1'], 'p2 is left for the instance that holds the lease');
  assert.equal(db.s.state.backfill_page, cursorJson({ phase: 'all' }), 'the cursor is where the tick left it while it still held the lease');
  assert.deepEqual([db.s.state.lease_owner, db.s.state.consecutive_errors, db.s.state.last_ok_at], ['instance-b', 0, null]);
  assert.ok(out.some((l) => l.includes('lease')), 'the stop is logged');

  const steady = steadyDb('1000');
  const hist = gmail({ history: records(['h1', 'h2']), latest: '1100', messages: [mail('h1'), mail('h2')] });
  const hget = hist.getMessage;
  hist.getMessage = async (id) => {
    if (id === 'h2') Object.assign(steady.s.state, { lease_owner: 'instance-b', lease_until: new Date(Date.now() + 60000) });
    return hget(id);
  };
  await tickFor(hist, steady)();
  assert.deepEqual([steady.s.state.history_id, steady.s.state.lease_owner, steady.s.state.consecutive_errors], ['1000', 'instance-b', 0]);
});

test('a malformed message (not an object) takes the skip path; a garbage object is dropped; the tick goes on', async () => {
  const db = steadyDb('1000');
  const client = gmail({ history: records(['m1', 'm2', 'h1']), latest: '1100', messages: [mail('h1')] });
  const get = client.getMessage;
  client.getMessage = async (id) => {
    if (id === 'm1') return { data: 'not a Gmail message' };
    if (id === 'm2') return { data: { id: 'm2', payload: 42, labelIds: 'INBOX' } };
    return get(id);
  };
  const tick = tickFor(client, db);
  const one = await tick();
  assert.deepEqual([one.stored, one.failed, one.dropped], [1, 1, 1]);
  assert.equal(db.s.skips.get('m1').last_error, 'TypeError');
  assert.equal(db.s.state.consecutive_errors, 0);
  await tick();
  const three = await tick();
  assert.equal(three.skipped, 1);
  assert.equal(db.s.state.history_id, '1100');
});

test('a reply rule never fires off our own auto-reply: a Sent vacation answer in the thread is no stored Sent mail', async () => {
  const db = steadyDb('1000');
  db.s.messages.set('vac', {
    id: 40, gmail_id: 'vac', direction: 'out', kind: 'auto_reply', thread_id: 'th-promo', message_id_header: '<vac@mail.gmail.com>',
  });
  const promo = mail('pr1', { labels: ['INBOX', 'CATEGORY_UPDATES'], from: 'deals@shop.example.com', threadId: 'th-promo', inReplyTo: '<vac@mail.gmail.com>' });
  const sum = await tickFor(gmail({ history: records(['pr1']), latest: '1100', messages: [promo] }), db)();
  assert.deepEqual([sum.stored, sum.dropped], [0, 1]);
  assert.ok(SQL.sentRefs.includes("kind = 'message'"), 'the statement the stub restates');
});

test('the sync loads the slim email index by default: three reads, never the leads, phones or marketing rows', async () => {
  const db = steadyDb('1000');
  const query = db.query;
  const asked = [];
  db.query = async (sql, params) => {
    if ([EMAIL_CLIENTS_SQL, PEOPLE_STAFF_SQL, PEOPLE_OPERATORS_SQL].includes(sql)) { asked.push(sql); return { rows: [] }; }
    return query(sql, params);
  };
  const tick = makeGmailSyncTick({ client: gmail({ history: records(['l1']), latest: '1100', messages: [mail('l1')] }), db, sentry, now: () => clock });
  assert.equal((await tick()).stored, 1);
  assert.deepEqual(asked.sort(), [EMAIL_CLIENTS_SQL, PEOPLE_OPERATORS_SQL, PEOPLE_STAFF_SQL].sort());
});

test('the summary line is logged only by a tick that counted something', async () => {
  const db = steadyDb('1000');
  await tickFor(gmail({ history: [], latest: '1000' }), db)();
  assert.equal(out.filter((l) => l.startsWith('[gmail_sync] stored=')).length, 0, 'an idle minute logs nothing');
  await tickFor(gmail({ history: records(['s1']), latest: '1100', messages: [mail('s1')] }), db)();
  assert.deepEqual(out.filter((l) => l.startsWith('[gmail_sync] stored=')), ['[gmail_sync] stored=1 dropped=0 unparsed=0 skipped=0 failed=0 gateFailed=0']);
});

// ─── the re-review round (2026-10-15) ───

test('only a data error (SQLSTATE class 22 or 23) costs the message an attempt; every other database error fails the tick', async () => {
  // An undefined column after a failed migration, a privilege, Neon's proxy
  // (XX000), a system error, a serialization failure, a deadlock, a lock
  // timeout, a statement timeout: none of them is the message's fault.
  for (const code of ['42703', '42501', 'XX000', '58030', '40001', '40P01', '55P03', '57014']) {
    let broken = true;
    const db = steadyDb('1000', { hook: (name) => { if (broken && name === 'insert') throw Object.assign(new Error(`boom ${ADDRESS}`), { code }); } });
    const client = gmail({ history: records(['d1']), latest: '1100', messages: [mail('d1')] });
    const tick = tickFor(client, db);
    for (let i = 0; i < 4; i += 1) await tick();
    assert.equal(db.s.skips.size, 0, `${code}: no message attempt spent`);
    assert.deepEqual([db.s.state.consecutive_errors, db.s.state.history_id, db.s.state.last_error], [4, '1000', `Error ${code}`], code);
    broken = false;
    assert.equal((await tick()).stored, 1, `${code}: the mail is stored once the database is back`);
  }
  for (const code of ['22001', '22P02', '23505', '23514']) {
    const db = steadyDb('1000', { hook: (name) => { if (name === 'insert') throw Object.assign(new Error('refused'), { code }); } });
    const sum = await tickFor(gmail({ history: records(['d1']), latest: '1100', messages: [mail('d1')] }), db)();
    assert.deepEqual([sum.failed, db.s.skips.get('d1').attempts, db.s.state.consecutive_errors], [1, 1, 0], `${code}: the message's own fault`);
  }
});

test('a token that will not mint while a message is fetched fails the tick and strikes no message', async () => {
  const db = steadyDb('1000');
  const client = gmail({ history: records(['t1', 't2']), latest: '1100', messages: [mail('t1'), mail('t2')] });
  const get = client.getMessage;
  let tokenDown = true;
  client.getMessage = async (id) => (tokenDown && id === 't1'
    ? (client.fetched.push(id), { error: new GmailError('GmailUnavailableError', 503, 'token') }) : get(id));
  const tick = tickFor(client, db);
  const one = await tick();
  assert.deepEqual([one.stored, one.failed], [0, 0]);
  assert.equal(db.s.skips.size, 0, 'no unavailable strike on the message being fetched');
  assert.deepEqual([db.s.state.consecutive_errors, db.s.state.last_error, db.s.state.history_id], [1, 'GmailUnavailableError:token', '1000']);
  assert.deepEqual(client.fetched, ['t1'], 'the tick ends at the token');
  tokenDown = false;
  assert.equal((await tick()).stored, 2);
  assert.deepEqual([db.s.state.consecutive_errors, db.s.state.history_id, db.s.skips.size], [0, '1100', 0]);
});

test('the probe is the profile: a first backfill with nothing stored strikes a message Gmail never answers, and skips it at 20', async () => {
  const db = fakeDb();
  const client = gmail({ pages: [['p1']], messages: [mail('p1')] });
  client.getMessage = async (id) => (client.fetched.push(id), unavailable());
  const tick = tickFor(client, db);
  const one = await tick();
  assert.deepEqual([one.stored, one.failed, db.s.messages.size], [0, 1, 0], 'nothing is stored to fetch again');
  assert.deepEqual([db.s.skips.get('p1').unavailable, db.s.state.consecutive_errors], [1, 0], 'Gmail answered the profile: struck, no outage');
  for (let i = 2; i <= 20; i += 1) await tick();
  assert.equal(db.s.skips.get('p1').unavailable, 20);
  assert.equal(db.s.state.backfill_done, true, 'skipped for good, the listing finishes that tick');
  assert.equal(db.s.state.consecutive_errors, 0);
});

test('the probe never fetches a stored message: a newest row Gmail will not serve turns no tick into an outage', async () => {
  const db = steadyDb('1000');
  db.s.messages.set('old1', { id: 9, gmail_id: 'old1', direction: 'in', kind: 'message', thread_id: 'x', message_id_header: null });
  const client = gmail({ history: records(['lone']), latest: '1100', messages: [mail('lone'), mail('old1')] });
  client.getMessage = async (id) => (client.fetched.push(id), unavailable());
  const tick = tickFor(client, db);
  for (let i = 1; i <= 20; i += 1) await tick();
  assert.deepEqual([db.s.skips.get('lone').unavailable, db.s.state.consecutive_errors], [20, 0]);
  assert.equal(db.s.state.history_id, '1100', 'skipped for good by the probe\'s strike, the window advances that tick');
  assert.equal(client.fetched.includes('old1'), false);
});

test('a probe refused for auth fails the tick with the auth class and strikes nobody', async () => {
  const db = steadyDb('1000');
  const client = gmail({ history: records(['lone']), latest: '1100', messages: [mail('lone')] });
  client.getMessage = async (id) => (client.fetched.push(id), unavailable());
  client.getProfile = async () => ({ error: new GmailError('GmailAuthError', 401, 'api') });
  await tickFor(client, db)();
  assert.deepEqual([db.s.skips.size, db.s.state.consecutive_errors, db.s.state.last_error], [0, 1, 'GmailAuthError:api']);
});

test('a bounce row stores the Sent Message-ID it marked as its in_reply_to, so the reader places it with that Sent mail', async () => {
  const db = steadyDb('1000');
  db.s.messages.set('sent3', {
    id: 50, gmail_id: 'sent3', direction: 'out', kind: 'message', thread_id: 'th-sent3', message_id_header: '<sent3@mail.gmail.com>',
    failed: false, bounced_to: null,
  });
  // In-Reply-To names mail we never stored; References ends with our Sent row.
  const report = mail('bn3', {
    from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)',
    inReplyTo: '<elsewhere@mail.example.com>',
    extra: [['Auto-Submitted', 'auto-replied'], ['References', '<older@mail.example.com> <sent3@mail.gmail.com>']],
  });
  const reply = mail('rp3', { inReplyTo: '<elsewhere@mail.example.com>' });
  const sum = await tickFor(gmail({ history: records(['bn3', 'rp3']), latest: '1100', messages: [report, reply] }), db)();
  assert.equal(sum.stored, 2);
  assert.equal(db.s.messages.get('bn3').kind, 'bounce');
  assert.equal(db.s.messages.get('bn3').in_reply_to, '<sent3@mail.gmail.com>', 'the row it marked, not the raw header');
  assert.equal(db.s.messages.get('sent3').failed, true);
  assert.equal(db.s.messages.get('rp3').in_reply_to, '<elsewhere@mail.example.com>', 'any other mail keeps its own In-Reply-To');
});

// ─── personal mail (spec 2026-10-14 decision 6, as decided 2026-10-15) ───

const FRIEND = 'friend.r@example.com';
const toAlias = (id, opts = {}) => mail(id, { from: `Robin Friend <${FRIEND}>`, to: PERSONAL_ALIAS, ...opts });

test('the personal judgment is stored on the row when the mail is stored: a dallas@-only mail from someone nobody knew, and the rest', async () => {
  const db = steadyDb('1000', { known: [{ address: 'alex.b@example.com', at: '2026-09-01T00:00:00Z' }] });
  const sentFromAlias = mail('ps4', {
    labels: ['SENT'], from: `Dallas <${PERSONAL_ALIAS}>`, to: `${FRIEND}, Alex B <alex.b@example.com>`, threadId: 'th-ps1',
    inReplyTo: '<ps1@mail.example.com>', internalDate: Date.parse('2026-10-12T16:00:00Z'),
  });
  const messages = [
    toAlias('ps1', { threadId: 'th-ps1' }),
    mail('ps2', { from: `Robin Friend <${FRIEND}>`, to: GMAIL_MAILBOX }),
    mail('ps3', { from: 'Alex B <alex.b@example.com>', to: PERSONAL_ALIAS }),
    sentFromAlias,
  ];
  const sum = await tickFor(gmail({ history: records(['ps1', 'ps2', 'ps3', 'ps4']), latest: '1100', messages }), db)();
  assert.equal(sum.stored, 4);
  const row = (id) => [db.s.messages.get(id).personal, db.s.messages.get(id).personal_to];
  assert.deepEqual(row('ps1'), [true, null], 'to the owner alias alone, from someone nobody knew');
  assert.deepEqual(row('ps2'), [false, null], 'the same sender to the business mailbox is business');
  assert.deepEqual(row('ps3'), [false, null], 'a client when it arrived');
  assert.deepEqual(row('ps4'), [true, [FRIEND]], 'the reply from the alias is personal for the friend, not the client it copies');
  assert.equal(db.sqlCount('knownAt'), 3, 'only the three mails that could be personal are looked up, never the contact@ one');
});

// Test 9 of the 2026-10-15 brief: a judgment that cannot run is never a
// business mail. An outage fails the tick and spends no attempt; a value the
// database refuses is the message's own fault, as for the insert.
test('a database error in the personal lookup fails the tick and stores nothing; the mail is stored personal once the database is back', async () => {
  let broken = true;
  const db = steadyDb('1000', { hook: (name) => { if (broken && name === 'knownAt') throw new Error('Connection terminated unexpectedly'); } });
  const tick = tickFor(gmail({ history: records(['pm1']), latest: '1100', messages: [toAlias('pm1')] }), db);
  const one = await tick();
  assert.deepEqual([one.stored, one.failed, db.s.messages.size, db.s.skips.size], [0, 0, 0, 0], 'nothing stored, no attempt spent');
  assert.deepEqual([db.s.state.consecutive_errors, db.s.state.history_id], [1, '1000'], 'the tick failed and the window held');
  assert.equal(db.count(/^ROLLBACK$/), 1, 'the open transaction was rolled back');
  broken = false;
  assert.equal((await tick()).stored, 1);
  assert.equal(db.s.messages.get('pm1').personal, true);

  let sentBroken = true;
  const sentDb = steadyDb('1000', { hook: (name) => { if (sentBroken && name === 'answeredInbound') throw Object.assign(new Error('timeout'), { code: '57014' }); } });
  const reply = mail('pm2', { labels: ['SENT'], from: GMAIL_MAILBOX, to: FRIEND, inReplyTo: '<friend-1@mail.example.com>' });
  const sentTick = tickFor(gmail({ history: records(['pm2']), latest: '1100', messages: [reply] }), sentDb);
  assert.deepEqual([(await sentTick()).stored, sentDb.s.messages.size, sentDb.s.skips.size, sentDb.s.state.consecutive_errors], [0, 0, 0, 1],
    'a Sent mail whose answered lookup failed is not stored either');
  sentBroken = false;
  assert.equal((await sentTick()).stored, 1);

  const data = steadyDb('1000', { hook: (name) => { if (name === 'knownAt') throw Object.assign(new Error('refused'), { code: '22P02' }); } });
  const dataTick = tickFor(gmail({ history: records(['pm3']), latest: '1100', messages: [toAlias('pm3')] }), data);
  for (let i = 1; i <= GMAIL_SKIP_ATTEMPTS; i += 1) {
    const sum = await dataTick();
    assert.deepEqual([sum.stored, data.s.messages.size, data.s.skips.get('pm3').attempts], [0, 0, i], `attempt ${i}`);
  }
  assert.equal(data.s.messages.size, 0, 'skipped for good, never stored as business');
});
