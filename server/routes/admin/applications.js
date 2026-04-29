const express = require('express');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../utils/errors');

const router = express.Router();

// Onboarding step booleans on `users` — order matters; first incomplete step is
// surfaced as the "blocker" on the application detail page.
const ONBOARDING_STEPS = [
  'welcome_viewed',
  'field_guide_completed',
  'agreement_completed',
  'contractor_profile_completed',
  'payday_protocols_completed',
  'onboarding_completed',
];

// Append-only activity event writer. Pass either the pool or a transaction
// client; both expose `.query`.
async function writeActivity(client, { user_id, actor_id, event_type, metadata }) {
  await client.query(
    `INSERT INTO application_activity (user_id, actor_id, event_type, metadata)
     VALUES ($1, $2, $3, $4)`,
    [user_id, actor_id, event_type, metadata ? JSON.stringify(metadata) : null]
  );
}

// Enrich a raw application row with derived fields the frontend expects:
// onboarding_progress (0..1), onboarding_blocker, flags array.
function enrichApplicationRow(row) {
  const completed = ONBOARDING_STEPS.filter(s => row[s]);
  const onboarding_progress = completed.length / ONBOARDING_STEPS.length;
  const firstIncomplete = ONBOARDING_STEPS.find(s => !row[s]);
  const onboarding_blocker = firstIncomplete
    ? firstIncomplete.replace(/_/g, ' ').replace(/completed$/, '').trim()
    : null;

  const flags = [];
  if (row.basset_file_url) flags.push('BASSET');
  if (row.referral_source) flags.push('Referral');
  if (!row.basset_file_url && row.has_bartending_experience) flags.push('No BASSET');

  return { ...row, onboarding_progress, onboarding_blocker, flags };
}

// ─── Applications ─────────────────────────────────────────────────

// List all applications (paginated).
//   ?archived=true   returns only rejected/archived applicants
//   default          returns active hiring states (applied, interviewing, in_progress)
//                    — needed by the new kanban which shows the Onboarding column
router.get('/applications', auth, adminOnly, asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const archived = req.query.archived === 'true';

  // Status filter uses a CASE expression parameterized by $1 (archived boolean)
  // to avoid any SQL-string interpolation on the WHERE clause.
  const ARCHIVED_FILTER = `AND CASE WHEN $1 THEN u.onboarding_status = 'rejected'
                                    ELSE u.onboarding_status IN ('applied', 'interviewing', 'in_progress', 'hired') END`;

  const [appsResult, countResult, statusCountsResult, archivedCountResult] = await Promise.all([
    pool.query(`
      SELECT
        u.id, u.email, u.onboarding_status, u.created_at,
        u.welcome_viewed, u.field_guide_completed, u.agreement_completed,
        u.contractor_profile_completed, u.payday_protocols_completed, u.onboarding_completed,
        a.full_name, a.phone, a.city, a.state, a.positions_interested,
        a.has_bartending_experience, a.bartending_years, a.setup_confidence,
        a.headshot_file_url, a.basset_file_url, a.resume_file_url,
        a.referral_source, a.interview_at, a.rejection_reason,
        a.created_at as applied_at,
        a.travel_distance, a.available_saturdays,
        a.reliable_transportation, a.comfortable_working_alone,
        a.last_bartending_time
      FROM users u
      INNER JOIN applications a ON a.user_id = u.id
      WHERE u.role IN ('staff', 'manager') ${ARCHIVED_FILTER}
      ORDER BY a.created_at DESC
      LIMIT $2 OFFSET $3
    `, [archived, limit, offset]),
    pool.query(
      `SELECT COUNT(*) FROM applications a INNER JOIN users u ON u.id = a.user_id WHERE u.role IN ('staff', 'manager') ${ARCHIVED_FILTER}`,
      [archived]
    ),
    // Active status counts (legacy — used by the soon-to-retire HiringDashboard).
    pool.query(`
      SELECT u.onboarding_status, COUNT(*) as count
      FROM users u INNER JOIN applications a ON a.user_id = u.id
      WHERE u.role IN ('staff', 'manager') AND u.onboarding_status IN ('applied', 'interviewing')
      GROUP BY u.onboarding_status
    `),
    // Archived (rejected) count — always returned regardless of view
    pool.query(
      `SELECT COUNT(*) FROM applications a INNER JOIN users u ON u.id = a.user_id WHERE u.role IN ('staff', 'manager') AND u.onboarding_status = 'rejected'`
    )
  ]);

  // Build statusCounts for the active tabs (all = sum of non-rejected)
  const statusCounts = {};
  let activeTotal = 0;
  statusCountsResult.rows.forEach(r => {
    statusCounts[r.onboarding_status] = parseInt(r.count);
    activeTotal += parseInt(r.count);
  });
  statusCounts.all = activeTotal;

  const archivedCount = parseInt(archivedCountResult.rows[0].count);

  res.json({
    applications: appsResult.rows.map(enrichApplicationRow),
    total: parseInt(countResult.rows[0].count),
    page,
    pages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
    limit,
    statusCounts,
    archivedCount,
  });
}));

// Get single application detail with scorecard + unified timeline.
// Shape preserves the legacy { user, application, notes } keys (read by the
// soon-to-retire AdminApplicationDetail.js) and adds scorecard + timeline used
// by the rebuilt detail page.
router.get('/applications/:userId', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = req.params.userId;

  const [appRes, userRes, notesRes, scoresRes, activityRes] = await Promise.all([
    pool.query(`
      SELECT
        u.id, u.email, u.onboarding_status, u.created_at,
        u.welcome_viewed, u.field_guide_completed, u.agreement_completed,
        u.contractor_profile_completed, u.payday_protocols_completed, u.onboarding_completed,
        a.*,
        a.created_at AS applied_at
      FROM users u
      INNER JOIN applications a ON a.user_id = u.id
      WHERE u.id = $1
    `, [userId]),
    pool.query('SELECT id, email, role, onboarding_status, created_at FROM users WHERE id = $1', [userId]),
    pool.query(`
      SELECT n.*, u.email as admin_email
      FROM interview_notes n
      LEFT JOIN users u ON u.id = n.admin_id
      WHERE n.user_id = $1
      ORDER BY n.created_at DESC
      LIMIT 100
    `, [userId]),
    pool.query('SELECT * FROM interview_scores WHERE user_id = $1', [userId]),
    pool.query(`
      SELECT
        a.id, a.event_type, a.metadata, a.created_at,
        u.email AS actor_email,
        cp.preferred_name AS actor_name
      FROM application_activity a
      LEFT JOIN users u ON u.id = a.actor_id
      LEFT JOIN contractor_profiles cp ON cp.user_id = a.actor_id
      WHERE a.user_id = $1
      ORDER BY a.created_at DESC
      LIMIT 200
    `, [userId]),
  ]);

  if (!userRes.rows[0]) throw new NotFoundError('User not found');
  if (!appRes.rows[0]) throw new NotFoundError('Application not found');

  const enrichedApp = enrichApplicationRow(appRes.rows[0]);

  // Unified timeline: application_activity (new) UNIONed with legacy interview_notes
  // rendered as note_added events. Newest first.
  const timeline = [
    ...activityRes.rows.map(r => ({
      kind: 'activity',
      event_type: r.event_type,
      metadata: r.metadata,
      actor_name: r.actor_name || r.actor_email || null,
      created_at: r.created_at,
    })),
    ...notesRes.rows.map(r => ({
      kind: 'activity',
      event_type: 'note_added',
      metadata: { note: r.note, legacy: true },
      actor_name: r.admin_email || null,
      created_at: r.created_at,
    })),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({
    user:        userRes.rows[0],   // legacy compat
    application: enrichedApp,        // both legacy + new
    notes:       notesRes.rows,      // legacy compat
    scorecard:   scoresRes.rows[0] || null,
    timeline,
  });
}));

// ─── Interview Notes ──────────────────────────────────────────────

// Add interview note. Writes to BOTH interview_notes (legacy reads still
// work) AND application_activity (so the new timeline picks it up live without
// waiting on a refetch).
router.post('/applications/:userId/notes', auth, adminOnly, asyncHandler(async (req, res) => {
  const { note } = req.body;
  if (!note || !note.trim()) {
    throw new ValidationError({ note: 'Note cannot be empty.' });
  }

  await pool.query(
    'INSERT INTO interview_notes (user_id, admin_id, note) VALUES ($1, $2, $3)',
    [req.params.userId, req.user.id, note.trim()]
  );
  await writeActivity(pool, {
    user_id: req.params.userId,
    actor_id: req.user.id,
    event_type: 'note_added',
    metadata: { note: note.trim() },
  });

  const notesRes = await pool.query(`
    SELECT n.*, u.email as admin_email
    FROM interview_notes n
    LEFT JOIN users u ON u.id = n.admin_id
    WHERE n.user_id = $1
    ORDER BY n.created_at DESC
  `, [req.params.userId]);

  res.status(201).json(notesRes.rows);
}));

// Delete interview note
router.delete('/notes/:noteId', auth, adminOnly, asyncHandler(async (req, res) => {
  const result = await pool.query('DELETE FROM interview_notes WHERE id = $1 RETURNING id', [req.params.noteId]);
  if (!result.rows[0]) throw new NotFoundError('Note not found');
  res.json({ success: true });
}));

// ─── Interview scheduling ─────────────────────────────────────────

// Schedule (or reschedule) an interview. Body: { interview_at, notes?, send_email? }.
// `interview_at` is an ISO 8601 timestamp.
router.put('/applications/:userId/interview', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(userId)) throw new ValidationError('userId invalid');
  const { interview_at, notes, send_email } = req.body;
  if (!interview_at) throw new ValidationError('interview_at required');
  const dt = new Date(interview_at);
  if (isNaN(dt.getTime())) throw new ValidationError('interview_at invalid');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prev = await client.query(
      'SELECT interview_at FROM applications WHERE user_id = $1', [userId]
    );
    if (prev.rowCount === 0) throw new NotFoundError('Application not found');
    const wasScheduled = prev.rows[0].interview_at !== null;

    await client.query(
      'UPDATE applications SET interview_at = $1, updated_at = NOW() WHERE user_id = $2',
      [dt.toISOString(), userId]
    );
    await writeActivity(client, {
      user_id: userId,
      actor_id: req.user.id,
      event_type: wasScheduled ? 'interview_rescheduled' : 'interview_scheduled',
      metadata: { interview_at: dt.toISOString(), notes: notes || null },
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  if (send_email) {
    // Fire-and-forget — do not block the response on Resend hiccups.
    const { sendInterviewConfirmationEmail } = require('../../utils/emailTemplates');
    sendInterviewConfirmationEmail({ userId, interview_at: dt }).catch(err =>
      console.error('Interview confirmation email failed:', err)
    );
  }

  res.json({ ok: true, interview_at: dt.toISOString() });
}));

// Clear a scheduled interview (returns applicant to "unscheduled" state).
router.delete('/applications/:userId/interview', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(userId)) throw new ValidationError('userId invalid');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      'UPDATE applications SET interview_at = NULL, updated_at = NOW() WHERE user_id = $1 RETURNING id',
      [userId]
    );
    if (r.rowCount === 0) throw new NotFoundError('Application not found');
    await writeActivity(client, {
      user_id: userId, actor_id: req.user.id,
      event_type: 'interview_rescheduled',
      metadata: { cleared: true },
    });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }

  res.json({ ok: true });
}));

// ─── Interview scorecard ──────────────────────────────────────────

// Upsert any subset of the 5 scorecard dimensions for an applicant.
// Each dimension is 1..5 or null. Dot-clicks call this with a single field.
router.put('/applications/:userId/scorecard', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(userId)) throw new ValidationError('userId invalid');

  const DIMS = ['personality', 'customer_service', 'problem_solving', 'speed_mindset', 'hire_instinct'];
  const updates = {};
  for (const k of DIMS) {
    if (k in req.body) {
      const v = req.body[k];
      if (v !== null && (!Number.isInteger(v) || v < 1 || v > 5)) {
        throw new ValidationError(`${k} must be an integer 1-5 or null`);
      }
      updates[k] = v;
    }
  }
  if (Object.keys(updates).length === 0) {
    throw new ValidationError('No scorecard fields provided');
  }

  const cols = Object.keys(updates);
  const setClause = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
  const insertCols = ['user_id', 'scored_by', ...cols].join(', ');
  const insertVals = ['$1', '$2', ...cols.map((_, i) => `$${i + 3}`)].join(', ');
  const params = [userId, req.user.id, ...cols.map(c => updates[c])];

  await pool.query(
    `INSERT INTO interview_scores (${insertCols}) VALUES (${insertVals})
     ON CONFLICT (user_id) DO UPDATE SET ${setClause}, updated_at = NOW()`,
    params
  );

  const fresh = await pool.query('SELECT * FROM interview_scores WHERE user_id = $1', [userId]);
  res.json({ scorecard: fresh.rows[0] });
}));

// ─── Stage transitions ────────────────────────────────────────────

// Generic forward move. Allowed transitions:
//   applied      -> interviewing
//   interviewing -> in_progress (== onboarding)
// Onboarding -> active is automatic when paperwork completes (handled elsewhere).
router.post('/applications/:userId/move', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(userId)) throw new ValidationError('userId invalid');
  const { to } = req.body;
  const allowed = { applied: ['interviewing'], interviewing: ['in_progress'] };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prev = await client.query('SELECT onboarding_status FROM users WHERE id = $1', [userId]);
    if (prev.rowCount === 0) throw new NotFoundError('User not found');
    const from = prev.rows[0].onboarding_status;
    if (!allowed[from] || !allowed[from].includes(to)) {
      throw new ValidationError(`Transition ${from} -> ${to} not allowed`);
    }
    await client.query(
      'UPDATE users SET onboarding_status = $1, updated_at = NOW() WHERE id = $2',
      [to, userId]
    );
    await writeActivity(client, {
      user_id: userId, actor_id: req.user.id,
      event_type: 'status_changed',
      metadata: { from, to },
    });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }

  res.json({ ok: true });
}));

// Reject an applicant. Body: { rejection_reason }.
router.post('/applications/:userId/reject', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(userId)) throw new ValidationError('userId invalid');
  const reason = (req.body.rejection_reason || '').trim();
  if (!reason) throw new ValidationError('rejection_reason required');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prev = await client.query('SELECT onboarding_status FROM users WHERE id = $1', [userId]);
    if (prev.rowCount === 0) throw new NotFoundError('User not found');
    const from = prev.rows[0].onboarding_status;

    await client.query(
      `UPDATE users SET onboarding_status = 'rejected', updated_at = NOW() WHERE id = $1`,
      [userId]
    );
    await client.query(
      'UPDATE applications SET rejection_reason = $1, updated_at = NOW() WHERE user_id = $2',
      [reason, userId]
    );
    await writeActivity(client, {
      user_id: userId, actor_id: req.user.id,
      event_type: 'status_changed',
      metadata: { from, to: 'rejected', reason },
    });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }

  res.json({ ok: true });
}));

// Restore a rejected applicant back to Applied.
router.post('/applications/:userId/restore', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(userId)) throw new ValidationError('userId invalid');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prev = await client.query('SELECT onboarding_status FROM users WHERE id = $1', [userId]);
    if (prev.rowCount === 0) throw new NotFoundError('User not found');
    if (prev.rows[0].onboarding_status !== 'rejected') {
      throw new ValidationError('Only rejected applicants can be restored');
    }
    await client.query(
      `UPDATE users SET onboarding_status = 'applied', updated_at = NOW() WHERE id = $1`, [userId]
    );
    await writeActivity(client, {
      user_id: userId, actor_id: req.user.id,
      event_type: 'status_changed',
      metadata: { from: 'rejected', to: 'applied' },
    });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }

  res.json({ ok: true });
}));

// Send a paperwork-reminder email to an applicant in onboarding.
router.post('/applications/:userId/reminder', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(userId)) throw new ValidationError('userId invalid');

  const { sendPaperworkReminderEmail } = require('../../utils/emailTemplates');
  await sendPaperworkReminderEmail({ userId });
  await writeActivity(pool, {
    user_id: userId, actor_id: req.user.id,
    event_type: 'reminder_sent',
    metadata: { kind: 'paperwork' },
  });

  res.json({ ok: true });
}));

module.exports = router;
