require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../../db');

if (process.env.NODE_ENV === 'production') throw new Error('zolaLeads.test.js refuses to run against production');

const { findOrCreateLead, createLead, markClosed } = require('./zolaLeads');
const { labelKey, UUID_RE } = require('./zolaMail');

// Every row this suite writes carries a label that starts with this prefix,
// and only those rows are ever deleted: before (a crashed earlier run) and
// after. Invented couples only.
const PREFIX = 'zz-test-zolaleads ';
const label = (couple) => `${PREFIX}${couple}`;
const clean = () => pool.query('DELETE FROM zola_leads WHERE couple_label LIKE $1', ['zz-test-zolaleads %']);
const uuid = () => crypto.randomUUID();
async function rowOf(id) {
  const { rows } = await pool.query(
    `SELECT id, lead_uuid, couple_label, couple_label_key, to_char(wedding_date, 'YYYY-MM-DD') AS wedding_date,
            client_id, closed_at
       FROM zola_leads WHERE id = $1`,
    [id]
  );
  return rows[0];
}

before(clean);
after(async () => {
  try {
    await clean();
  } finally {
    await pool.end();
  }
});

test('find by uuid', async () => {
  const u = uuid();
  const first = await findOrCreateLead(pool, { label: label('Alex B & Sam C'), leadUuid: u });
  assert.equal(first.created, true);
  const again = await findOrCreateLead(pool, { label: label('a label that changed'), leadUuid: u });
  assert.deepEqual(again, { id: first.id, created: false });
});

test('find by open label, whatever the spacing and case', async () => {
  const first = await findOrCreateLead(pool, { label: label('Lee D & Max E') });
  assert.equal(first.created, true);
  const again = await findOrCreateLead(pool, { label: `  ${label('LEE  D &   max e')} ` });
  assert.deepEqual(again, { id: first.id, created: false });
});

test('create: the label, its key, the uuid and the date; a bad date is null and an empty label refused', async () => {
  const u = uuid();
  const made = await findOrCreateLead(pool, { label: `  ${label('Kim F & Ray G')} `, leadUuid: u, weddingDate: '2027-06-12' });
  assert.equal(made.created, true);
  const row = await rowOf(made.id);
  assert.deepEqual(
    [row.couple_label, row.couple_label_key, row.lead_uuid, row.wedding_date, row.client_id, row.closed_at],
    [label('Kim F & Ray G'), labelKey(label('Kim F & Ray G')), u, '2027-06-12', null, null]
  );
  const badDate = await findOrCreateLead(pool, { label: label('Ari H & Noa J'), weddingDate: '2027-02-30' });
  assert.equal((await rowOf(badDate.id)).wedding_date, null, 'a date that is not on the calendar is no date');
  await assert.rejects(findOrCreateLead(pool, { label: '   ' }), /label/);
});

test('a uuid is filled on a label match', async () => {
  const first = await findOrCreateLead(pool, { label: label('Dana K & Eli L') });
  const u = uuid();
  const again = await findOrCreateLead(pool, { label: label('Dana K & Eli L'), leadUuid: u });
  assert.deepEqual(again, { id: first.id, created: false });
  assert.equal((await rowOf(first.id)).lead_uuid, u);
});

test('the same label with a different uuid makes a second row, and the first keeps its uuid', async () => {
  const [u1, u2] = [uuid(), uuid()];
  const a = await findOrCreateLead(pool, { label: label('Jo M & Pat N'), leadUuid: u1 });
  const b = await findOrCreateLead(pool, { label: label('Jo M & Pat N'), leadUuid: u2 });
  assert.equal(b.created, true);
  assert.notEqual(b.id, a.id);
  assert.deepEqual([(await rowOf(a.id)).lead_uuid, (await rowOf(b.id)).lead_uuid], [u1, u2]);
  assert.deepEqual(await findOrCreateLead(pool, { label: label('Jo M & Pat N'), leadUuid: u2 }), { id: b.id, created: false });
  assert.deepEqual(await findOrCreateLead(pool, { label: label('Jo M & Pat N') }), { id: b.id, created: false },
    'no uuid, two open rows: the newest');
});

test('closed rows are not matched by label, though their uuid still finds them', async () => {
  const u = uuid();
  const a = await findOrCreateLead(pool, { label: label('Rae P & Sky Q'), leadUuid: u });
  await markClosed(pool, a.id);
  const stamped = (await rowOf(a.id)).closed_at;
  assert.ok(stamped instanceof Date);
  await markClosed(pool, a.id);
  assert.equal((await rowOf(a.id)).closed_at.getTime(), stamped.getTime(), 'a second close keeps the first stamp');
  const b = await findOrCreateLead(pool, { label: label('Rae P & Sky Q') });
  assert.equal(b.created, true);
  assert.notEqual(b.id, a.id);
  assert.deepEqual(await findOrCreateLead(pool, { label: label('Rae P & Sky Q'), leadUuid: u }), { id: a.id, created: false });
});

test('a bad uuid is ignored', async () => {
  assert.equal(UUID_RE.test(uuid()), true);
  const bad = ['NOT-A-UUID', uuid().toUpperCase(), `${uuid()}/extra`, ` ${uuid()}`, 42];
  for (const leadUuid of bad) {
    const made = await findOrCreateLead(pool, { label: label(`Val R & Wes S ${String(leadUuid).length}`), leadUuid });
    assert.equal((await rowOf(made.id)).lead_uuid, null, String(leadUuid));
  }
  const open = await findOrCreateLead(pool, { label: label('Zed T & Uma V') });
  const again = await findOrCreateLead(pool, { label: label('Zed T & Uma V'), leadUuid: 'NOT-A-UUID' });
  assert.deepEqual(again, { id: open.id, created: false });
  assert.equal((await rowOf(open.id)).lead_uuid, null, 'a bad uuid is never filled in either');
});

test('createLead always makes a fresh row: one fallback label twice is two leads, never matched by label', async () => {
  const notice = label('Zola notice 2026-10-12');
  const a = await createLead(pool, { label: notice });
  const b = await createLead(pool, { label: `  ${notice} ` });
  assert.deepEqual([a.created, b.created], [true, true]);
  assert.notEqual(a.id, b.id);
  const rows = await Promise.all([rowOf(a.id), rowOf(b.id)]);
  assert.deepEqual(rows.map((r) => [r.couple_label, r.couple_label_key, r.lead_uuid]), [
    [notice, labelKey(notice), null], [notice, labelKey(notice), null],
  ]);
  await assert.rejects(createLead(pool, { label: ' ' }), /label/);
});
