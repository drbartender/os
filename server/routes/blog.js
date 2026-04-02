const express = require('express');
const path = require('path');
const { pool } = require('../db');
const { getSignedUrl } = require('../utils/storage');

const router = express.Router();

// ─── Public: list published posts ────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, slug, title, excerpt, cover_image_url, published_at
      FROM blog_posts
      WHERE published = true
      ORDER BY published_at DESC
    `);
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
    res.redirect(url);
  } catch (err) {
    console.error('Blog image error:', err);
    res.status(404).json({ error: 'Image not found' });
  }
});

// ─── Public: single published post by slug ───────────────────────

router.get('/:slug', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, slug, title, excerpt, body, cover_image_url, published_at
       FROM blog_posts
       WHERE slug = $1 AND published = true`,
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
