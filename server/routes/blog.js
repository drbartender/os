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
  // published_at is a calendar day, so two posts can share it: id breaks the tie
  // the same way here and in the single-post read below, so a post's number
  // matches on its index card and its own page.
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  const result = await pool.query(`
    SELECT id, slug, title, excerpt, cover_image_url, published_at,
           ROW_NUMBER() OVER (ORDER BY published_at ASC, id ASC) as chapter_number
    FROM blog_posts
    WHERE published = true
    ORDER BY published_at DESC, id DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  res.json(result.rows);
}));

// ─── Public: serve blog images (no auth) ─────────────────────────

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

// The public images this unauthenticated route serves are keyed at the bucket
// root by prefix: `blog_` (admin/blog.js and the archived importer write
// `blog_<uuid v4><ext>`, and the live Lab Notes covers and inline images were
// uploaded by hand as `blog_p8-cover.webp`, `blog_<uuid>-opt.webp` and the
// like), `email_` (emailMarketing/designer.js) and `manual-art-` (the /vibes
// team manual's art, client/public/vibes/index.html). The prefix is the
// security (audit 2026-11-05 AUTH-06): every private object at the root
// starts with its owner's user id (`<userId>_headshot_`, `_w9_`, `_alcohol_`,
// `_resume_`, `_app_resume_`, `_basset_`), and every other private object
// sits in a folder, which path.basename has already stripped, so any key
// without one of the three prefixes is a 404 before any signing. The rest of
// the key is loose on purpose (the hand-uploaded names carry no uuid, and
// admin/blog.js stored path.extname(file.name) unsanitized until 2026-11-05):
// 1 to 200 characters with no slash, backslash, whitespace or parent step.
// Nothing is moved: every stored key keeps its basename. r2Proxy's
// assertKeyUnder is a single-prefix check (and pulls in sharp), so the rule
// is pinned here.
const PUBLIC_IMAGE_PREFIXES = ['blog_', 'email_', 'manual-art-'];
function isPublicImageKey(key) {
  const prefix = PUBLIC_IMAGE_PREFIXES.find((p) => key.startsWith(p));
  if (!prefix) return false;
  const rest = key.slice(prefix.length);
  return rest.length >= 1 && rest.length <= 200 && !/[/\\\s]/.test(rest) && !rest.includes('..');
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
       SELECT id, ROW_NUMBER() OVER (ORDER BY published_at ASC, id ASC) as chapter_number
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
