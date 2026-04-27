const express = require('express');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError } = require('../../utils/errors');

const router = express.Router();

// ─── Managers ─────────────────────────────────────────────────────

router.get('/managers', auth, adminOnly, asyncHandler(async (req, res) => {
  const result = await pool.query(
    "SELECT id, email, role, can_hire, can_staff, created_at FROM users WHERE role = 'manager' ORDER BY created_at DESC"
  );
  res.json({ managers: result.rows });
}));

// Elevate an existing staff member to manager
router.post('/managers', auth, adminOnly, asyncHandler(async (req, res) => {
  const { user_id, can_hire, can_staff } = req.body;
  if (!user_id) throw new ValidationError({ user_id: 'user_id is required.' });

  // Verify the user exists and is staff
  const existing = await pool.query('SELECT id, role FROM users WHERE id = $1', [user_id]);
  if (!existing.rows[0]) throw new NotFoundError('User not found.');
  if (existing.rows[0].role === 'manager') {
    throw new ConflictError('User is already a manager.', 'ALREADY_MANAGER');
  }
  if (existing.rows[0].role === 'admin') {
    throw new ConflictError('Cannot change admin role.', 'ADMIN_IMMUTABLE');
  }
  const result = await pool.query(
    `UPDATE users SET role = 'manager', can_hire = $1, can_staff = $2
     WHERE id = $3
     RETURNING id, email, role, can_hire, can_staff, created_at`,
    [can_hire || false, can_staff || false, user_id]
  );
  res.status(200).json(result.rows[0]);
}));

router.put('/managers/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const { can_hire, can_staff, email } = req.body;
  const result = await pool.query(
    `UPDATE users SET can_hire = $1, can_staff = $2, email = COALESCE($3, email)
     WHERE id = $4 AND role = 'manager'
     RETURNING id, email, role, can_hire, can_staff`,
    [can_hire ?? false, can_staff ?? false, email || null, req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Manager not found.');
  res.json(result.rows[0]);
}));

// Demote manager back to staff (don't delete the account)
router.delete('/managers/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `UPDATE users SET role = 'staff', can_hire = false, can_staff = false
     WHERE id = $1 AND role = 'manager' RETURNING id`,
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Manager not found.');
  res.json({ success: true });
}));

module.exports = router;
