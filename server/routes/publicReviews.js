const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');

const router = express.Router();

router.use(rateLimit({ windowMs: 60 * 1000, max: 120, message: { error: 'Too many requests' } }));

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key, value) {
  cache.set(key, { value, storedAt: Date.now() });
}

function shortenReviewer(name) {
  if (!name) return 'Thumbtack Customer';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const lastInitial = parts[parts.length - 1].charAt(0).toUpperCase();
  return `${first} ${lastInitial}.`;
}

function truncateText(text, max = 400) {
  if (!text) return '';
  const s = String(text);
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

router.get('/', async (req, res) => {
  const rawLimit = parseInt(req.query.limit, 10);
  const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 9 : rawLimit, 1), 20);

  const cached = getCached(limit);
  if (cached) return res.json(cached);

  try {
    const [reviewsResult, aggregateResult] = await Promise.all([
      pool.query(
        `SELECT id, rating, review_text, reviewer_name, created_at
         FROM thumbtack_reviews
         WHERE rating IS NOT NULL AND rating >= 4
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count, AVG(rating)::float AS avg_rating
         FROM thumbtack_reviews
         WHERE rating IS NOT NULL`
      ),
    ]);

    const reviews = reviewsResult.rows.map((row) => ({
      id: row.id,
      rating: Number(row.rating),
      text: truncateText(row.review_text),
      reviewerName: shortenReviewer(row.reviewer_name),
      createdAt: row.created_at,
    }));

    const { count, avg_rating } = aggregateResult.rows[0] || { count: 0, avg_rating: null };
    const averageRating = avg_rating === null ? null : Math.round(avg_rating * 10) / 10;

    const body = { count, averageRating, reviews };
    setCached(limit, body);
    res.json(body);
  } catch (err) {
    console.error('Public reviews query failed:', err);
    res.status(500).json({ count: 0, averageRating: null, reviews: [] });
  }
});

module.exports = router;
