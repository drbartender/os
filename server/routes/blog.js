// Blog post endpoints

const express = require('express');
const path = require('path');
const { pool } = require('../db');
const { getSignedUrl } = require('../utils/storage');
const asyncHandler = require('../middleware/asyncHandler');
const { NotFoundError, ExternalServiceError } = require('../utils/errors');
const { publicReadLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

// ─── Public: list published posts ────────────────────────────────

// List published posts (includes chapter_number)
router.get('/', publicReadLimiter, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  const result = await pool.query(`
    SELECT id, slug, title, excerpt, cover_image_url, published_at,
           ROW_NUMBER() OVER (ORDER BY published_at ASC) as chapter_number
    FROM blog_posts
    WHERE published = true
    ORDER BY published_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  res.json(result.rows);
}));

// ─── Public: serve blog images (no auth) ─────────────────────────

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

// The two key shapes the admin uploaders write at the bucket root for these
// public images (admin/blog.js, emailMarketing/designer.js and the archived
// importer): `blog_<uuid v4>` and `email_<uuid v4>`, each followed by the
// uploaded file's extension. The prefix and the lowercase uuid are the
// security: no other writer produces them, the root also holds the staff
// headshots (`<userId>_headshot_<uuid>`) and other private objects, and this
// route is unauthenticated, so any other key is a 404 before any signing
// (audit 2026-11-05 AUTH-06). The extension is the loose part: admin/blog.js
// stored path.extname(file.name) unsanitized until 2026-11-05, so a stored
// cover may carry any shape, and the reader accepts up to 32 characters after
// the dot that are not a slash, a backslash, whitespace or a parent step.
// Nothing is moved: the stored cover_image_url values keep their basenames.
// r2Proxy's assertKeyUnder is a single-prefix check (and pulls in sharp), so
// the shape is pinned here.
const PUBLIC_IMAGE_KEY_RE = /^(?:blog|email)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(.*)$/;
function isPublicImageKey(key) {
  const m = PUBLIC_IMAGE_KEY_RE.exec(key);
  if (!m) return false;
  const tail = m[1];
  if (tail === '') return true;
  return tail.startsWith('.') && tail.length <= 33 && !/[/\\\s]/.test(tail) && !tail.includes('..');
}

// Serve blog images via R2 signed URL
router.get('/images/:filename', publicReadLimiter, asyncHandler(async (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!isPublicImageKey(filename)) throw new NotFoundError('Image not found');
  let url;
  try {
    url = await getSignedUrl(filename);
  } catch (err) {
    throw new NotFoundError('Image not found');
  }
  // Proxy the image instead of redirecting to avoid CORS/mixed-content issues
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new ExternalServiceError('r2', err, 'Image temporarily unavailable');
  }
  if (!response.ok) {
    throw new NotFoundError('Image not found');
  }
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
  if (!ALLOWED_IMAGE_TYPES.some(t => contentType.startsWith(t))) {
    return res.status(415).send('Unsupported image type');
  }
  if (contentLength > MAX_IMAGE_BYTES) {
    return res.status(413).send('Image too large');
  }
  res.set('Content-Type', contentType);
  res.set('Cache-Control', 'public, max-age=600');
  const buffer = Buffer.from(await response.arrayBuffer());
  // Double-check actual size after download in case Content-Length was missing/lying
  if (buffer.length > MAX_IMAGE_BYTES) {
    return res.status(413).send('Image too large');
  }
  res.send(buffer);
}));

// ─── Public: single published post by slug ───────────────────────

// Get single post by slug (includes chapter_number)
router.get('/:slug', publicReadLimiter, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT bp.*, cn.chapter_number FROM blog_posts bp
     JOIN (
       SELECT id, ROW_NUMBER() OVER (ORDER BY published_at ASC) as chapter_number
       FROM blog_posts WHERE published = true
     ) cn ON cn.id = bp.id
     WHERE bp.slug = $1 AND bp.published = true`,
    [req.params.slug]
  );
  if (result.rows.length === 0) {
    throw new NotFoundError('Post not found');
  }
  // Public blog posts: cache at CDN edge + browser for 5 min / 10 min on CDN
  res.set('Cache-Control', 'public, max-age=300, s-maxage=600');
  res.json(result.rows[0]);
}));

module.exports = router;
