const express = require('express');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../utils/errors');

const router = express.Router();

// ─── Applications ─────────────────────────────────────────────────

// List all applications (paginated)
// ?archived=true returns only rejected/archived applicants
// Default returns all active (non-rejected) applicants
router.get('/applications', auth, adminOnly, asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const archived = req.query.archived === 'true';

  // Status filter uses a CASE expression parameterized by $1 (archived boolean)
  // to avoid any SQL-string interpolation on the WHERE clause.
  const ARCHIVED_FILTER = `AND CASE WHEN $1 THEN u.onboarding_status = 'rejected'
                                    ELSE u.onboarding_status IN ('applied', 'interviewing') END`;

  const [appsResult, countResult, statusCountsResult, archivedCountResult] = await Promise.all([
    pool.query(`
      SELECT
        u.id, u.email, u.onboarding_status, u.created_at,
        a.full_name, a.phone, a.city, a.state, a.positions_interested,
        a.has_bartending_experience, a.bartending_years, a.setup_confidence,
        a.headshot_file_url, a.created_at as applied_at,
        a.travel_distance, a.available_saturdays,
        a.reliable_transportation, a.comfortable_working_alone
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
    // Active status counts (only applied/interviewing)
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
    applications: appsResult.rows,
    total: parseInt(countResult.rows[0].count),
    page,
    pages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
    limit,
    statusCounts,
    archivedCount,
  });
}));

// Get single application detail with interview notes
router.get('/applications/:userId', auth, adminOnly, asyncHandler(async (req, res) => {
  const userId = req.params.userId;

  const [userRes, appRes, notesRes] = await Promise.all([
    pool.query('SELECT id, email, role, onboarding_status, created_at FROM users WHERE id = $1', [userId]),
    pool.query('SELECT * FROM applications WHERE user_id = $1', [userId]),
    pool.query(`
      SELECT n.*, u.email as admin_email
      FROM interview_notes n
      LEFT JOIN users u ON u.id = n.admin_id
      WHERE n.user_id = $1
      ORDER BY n.created_at DESC
      LIMIT 100
    `, [userId])
  ]);

  if (!userRes.rows[0]) throw new NotFoundError('User not found');
  if (!appRes.rows[0]) throw new NotFoundError('Application not found');

  res.json({
    user: userRes.rows[0],
    application: appRes.rows[0],
    notes: notesRes.rows
  });
}));

// ─── Interview Notes ──────────────────────────────────────────────

// Add interview note
router.post('/applications/:userId/notes', auth, adminOnly, asyncHandler(async (req, res) => {
  const { note } = req.body;
  if (!note || !note.trim()) {
    throw new ValidationError({ note: 'Note cannot be empty.' });
  }

  await pool.query(
    'INSERT INTO interview_notes (user_id, admin_id, note) VALUES ($1, $2, $3)',
    [req.params.userId, req.user.id, note.trim()]
  );

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

module.exports = router;
