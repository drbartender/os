'use strict';

// Zola lead rows (spec 2026-10-14 section 5.6), the WRITER. It runs inside one
// message's transaction (the sync passes that transaction's client as db), so
// every query goes through db and nothing here takes a pool connection of its
// own. Lane zola-leads adds applyNotice, the client creation and the daily cap
// here; this lane stores every gated notice against a lead row and no more.
//
// Everything bounded before it reaches a row: the label is trimmed and cut at
// 120 characters, a lead UUID that is not a strict lowercase UUID is no UUID,
// and a wedding date that is not a real calendar date is no date. A bad value
// therefore never fails the transaction, which would cost the notice.

const { labelKey, boundLabel, UUID_RE } = require('./zolaMail');

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const validUuid = (value) => (typeof value === 'string' && UUID_RE.test(value) ? value : null);

function validYmd(value) {
  const m = typeof value === 'string' ? YMD_RE.exec(value) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? value : null;
}

// The lead a notice belongs to (5.6), in order:
//   1. the row holding the notice's UUID, closed or not;
//   2. an open row with the same normalized label: one still waiting for its
//      UUID first (a notice that names one fills it in), else the newest;
//   3. a new row. A label whose open rows all hold a DIFFERENT UUID is a
//      second couple with the same label: a new row, and the first keeps its
//      UUID.
// The lease and the message's insert gate serialize callers, so two cannot
// both create a row for one notice.
function boundedLabel(label, caller) {
  const coupleLabel = boundLabel(label);
  if (!coupleLabel) throw new TypeError(`${caller} needs a couple label`);
  return coupleLabel;
}

async function insertLead(db, { coupleLabel, uuid, weddingDate }) {
  const made = await db.query(
    `INSERT INTO zola_leads (lead_uuid, couple_label, couple_label_key, wedding_date)
     VALUES ($1, $2, $3, $4::date)
     RETURNING id`,
    [uuid, coupleLabel, labelKey(coupleLabel), validYmd(weddingDate)]
  );
  return { id: made.rows[0].id, created: true };
}

async function findOrCreateLead(db, { label, leadUuid = null, weddingDate = null } = {}) {
  const coupleLabel = boundedLabel(label, 'findOrCreateLead');
  const key = labelKey(coupleLabel);
  const uuid = validUuid(leadUuid);

  if (uuid) {
    const byUuid = await db.query('SELECT id FROM zola_leads WHERE lead_uuid = $1', [uuid]);
    if (byUuid.rows.length) return { id: byUuid.rows[0].id, created: false };
  }
  const { rows } = await db.query(
    `SELECT id, lead_uuid
       FROM zola_leads
      WHERE couple_label_key = $1 AND closed_at IS NULL
      ORDER BY (lead_uuid IS NULL) DESC, id DESC
      LIMIT 1`,
    [key]
  );
  const open = rows[0];
  if (open && !open.lead_uuid) {
    if (uuid) {
      await db.query('UPDATE zola_leads SET lead_uuid = $1, updated_at = NOW() WHERE id = $2 AND lead_uuid IS NULL', [uuid, open.id]);
    }
    return { id: open.id, created: false };
  }
  if (open && !uuid) return { id: open.id, created: false };
  return insertLead(db, { coupleLabel, uuid, weddingDate });
}

// A FRESH lead, never matched by label (spec 5.6): a notice whose subject
// names no couple gets its own "Zola notice <date>" row, so two couples who
// write on the same day never share a lead. The caller's insert gate keeps a
// re-processed notice from making a second one.
async function createLead(db, { label, weddingDate = null } = {}) {
  const lead = await insertLead(db, { coupleLabel: boundedLabel(label, 'createLead'), uuid: null, weddingDate });
  return lead;
}

// A closed notice stamps its lead; a second one keeps the first stamp. A
// closed lead no longer matches by label (a new inquiry under the same label
// is a new lead) but still matches by its UUID.
async function markClosed(db, id) {
  await db.query('UPDATE zola_leads SET closed_at = COALESCE(closed_at, NOW()), updated_at = NOW() WHERE id = $1', [id]);
}

module.exports = { findOrCreateLead, createLead, markClosed };
