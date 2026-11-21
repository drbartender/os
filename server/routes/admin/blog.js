// /blog admin endpoints

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const { uploadFile } = require('../../utils/storage');
const { isValidUpload, safeUploadExtension } = require('../../utils/fileValidation');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError } = require('../../utils/errors');
const { chicagoTodayYmd } = require('../../utils/businessTime');

const DOMPurify = createDOMPurify(new JSDOM('').window);

const BLOG_SANITIZE_OPTIONS = {
  ALLOWED_TAGS: ['h2', 'h3', 'p', 'br', 'strong', 'em', 'a', 'img', 'figure', 'figcaption', 'ul', 'ol', 'li', 'blockquote', 'hr'],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'target', 'rel', 'class'],
};

const router = express.Router();

// ─── Blog Posts (admin CRUD) ─────────────────────────────────────

// published_at holds a calendar day at UTC midnight: the date the admin typed
// (new Date('YYYY-MM-DD') parses as UTC midnight), or, when none was typed,
// today's Chicago date in the same shape. Stamping the raw moment instead would
// put an evening publish on the next UTC day, and the public pages format the
// UTC day.
function todayPublishDate() {
  return new Date(chicagoTodayYmd());
}

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// List all posts (drafts + published) — excludes body (large HTML blob)
router.get('/blog', auth, adminOnly, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;
  const result = await pool.query(
    `SELECT id, slug, title, excerpt, cover_image_url, published, published_at, created_at, updated_at
     FROM blog_posts
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  res.json(result.rows);
}));

// Create post
router.post('/blog', auth, adminOnly, asyncHandler(async (req, res) => {
  let { title, slug, excerpt, body, cover_image_url, published, published_at } = req.body; // eslint-disable-line prefer-const
  if (!title || !body) {
    const fieldErrors = {};
    if (!title) fieldErrors.title = 'Title is required';
    if (!body) fieldErrors.body = 'Body is required';
    throw new ValidationError(fieldErrors);
  }
  body = DOMPurify.sanitize(body, BLOG_SANITIZE_OPTIONS);
  if (!slug) slug = slugify(title);
  if (published_at) {
    published_at = new Date(published_at);
  } else {
    published_at = published ? todayPublishDate() : null;
  }

  try {
    const result = await pool.query(
      `INSERT INTO blog_posts (title, slug, excerpt, body, cover_image_url, published, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [title, slug, excerpt, body, cover_image_url || null, !!published, published_at]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505' && err.constraint?.includes('slug')) {
      throw new ConflictError('A post with that slug already exists', 'DUPLICATE_SLUG');
    }
    throw err;
  }
}));

// Upload blog image
router.post('/blog/upload-image', auth, adminOnly, asyncHandler(async (req, res) => {
  if (!req.files?.image) {
    throw new ValidationError({ image: 'No image provided' });
  }
  const file = req.files.image;
  if (!isValidUpload(file)) {
    throw new ValidationError({ image: 'Invalid file type. Use JPEG, PNG, or WebP.' });
  }
  // Only allow image types (not PDF)
  const mime = file.mimetype?.toLowerCase() || '';
  if (mime === 'application/pdf') {
    throw new ValidationError({ image: 'PDF files are not allowed for blog images.' });
  }

  // The stored extension comes from the sniffed bytes (the file passed
  // isValidUpload), never from the client's filename, so a new key is always
  // `blog_<uuid>.jpg`, `.png` or `.webp` (audit 2026-11-05 AUTH-06 follow-up);
  // the public reader (routes/blog.js) still accepts the older unsanitized shapes.
  const ext = safeUploadExtension(file);
  const filename = `blog_${uuidv4()}${ext}`;
  await uploadFile(file.data, filename);

  res.json({ url: `/api/blog/images/${filename}` });
}));

// Get single post with full body (admin edit)
router.get('/blog/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    throw new ValidationError({ id: 'Invalid post id' });
  }
  const result = await pool.query(
    `SELECT id, slug, title, excerpt, body, cover_image_url,
            published, published_at, created_at, updated_at
     FROM blog_posts WHERE id = $1`,
    [id]
  );
  if (result.rows.length === 0) {
    throw new NotFoundError('Post not found');
  }
  res.json(result.rows[0]);
}));

// Update post
router.put('/blog/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, slug, excerpt, cover_image_url, published, published_at: reqPublishedAt } = req.body;
  const body = req.body.body ? DOMPurify.sanitize(req.body.body, BLOG_SANITIZE_OPTIONS) : req.body.body;

  // Fetch current state to check publish transition
  const current = await pool.query('SELECT * FROM blog_posts WHERE id = $1', [id]);
  if (current.rows.length === 0) {
    throw new NotFoundError('Post not found');
  }

  const post = current.rows[0];
  // Use explicitly provided date, or auto-set on first publish
  let published_at;
  if (reqPublishedAt) {
    published_at = new Date(reqPublishedAt);
  } else if (published && !post.published && !post.published_at) {
    published_at = todayPublishDate();
  } else {
    published_at = post.published_at;
  }

  try {
    const result = await pool.query(
      `UPDATE blog_posts
       SET title = $1, slug = $2, excerpt = $3, body = $4, cover_image_url = $5,
           published = $6, published_at = $7
       WHERE id = $8
       RETURNING *`,
      [title, slug, excerpt, body, cover_image_url || null, !!published, published_at, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505' && err.constraint?.includes('slug')) {
      throw new ConflictError('A post with that slug already exists', 'DUPLICATE_SLUG');
    }
    throw err;
  }
}));

// Delete post
router.delete('/blog/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'DELETE FROM blog_posts WHERE id = $1 RETURNING id',
    [req.params.id]
  );
  if (result.rows.length === 0) {
    throw new NotFoundError('Post not found');
  }
  res.json({ message: 'Post deleted' });
}));

module.exports = router;
