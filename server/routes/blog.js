const express = require('express');
const path = require('path');
const { pool } = require('../db');
const { getSignedUrl } = require('../utils/storage');

const router = express.Router();

// ─── Public: list published posts ────────────────────────────────

router.get('/', async (req, res) => {
  try {
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
  } catch (err) {
    console.error('Blog list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Public: serve blog images (no auth) ─────────────────────────

router.get('/images/:filename', async (req, res) => {
  const filename = path.basename(req.params.filename);
  try {
    const url = await getSignedUrl(filename);
    // Proxy the image instead of redirecting to avoid CORS/mixed-content issues
    const response = await fetch(url);
    if (!response.ok) throw new Error('R2 fetch failed');
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=600');
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    console.error('Blog image error:', err);
    res.status(404).json({ error: 'Image not found' });
  }
});

// ─── Public: single published post by slug ───────────────────────

router.get('/:slug', async (req, res) => {
  try {
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
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Blog post error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
