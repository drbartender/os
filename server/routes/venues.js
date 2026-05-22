'use strict';

const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { venueSearchLimiter, venueSearchGlobalLimiter } = require('../middleware/rateLimiters');
const { searchVenues, getVenueDetails } = require('../utils/googlePlaces');

const router = express.Router();

// Venue-name autocomplete. Public: the quote wizard is unauthenticated and no
// proposal token exists at that stage. Thin proxy to Google Places, exposes
// nothing sensitive. Rate-limited per IP and with a global ceiling. Absence of
// matches is a normal outcome, so this never throws an AppError. Length caps on
// q / placeId / token live in server/utils/googlePlaces.js.
router.get('/search', venueSearchGlobalLimiter, venueSearchLimiter, asyncHandler(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const results = await searchVenues(q, token);
  res.json({ results });
}));

// Resolve a selected suggestion to a structured venue address.
router.get('/details/:placeId', venueSearchGlobalLimiter, venueSearchLimiter, asyncHandler(async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const venue = await getVenueDetails(req.params.placeId, token);
  res.json({ venue });
}));

module.exports = router;
