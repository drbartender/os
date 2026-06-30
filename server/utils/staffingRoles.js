'use strict';

// Canonical staffing role vocabulary. The exact label `Bartender` (any case)
// is load-bearing for payroll: the gratuity/tip split keys on
// LOWER(position) = 'bartender'. All role comparisons elsewhere are
// case-insensitive and route through canonicalizeRole.

const ROLES = {
  BARTENDER: 'Bartender',
  BANQUET_SERVER: 'Banquet Server',
  BARBACK: 'Barback',
};

const CANONICAL_LABELS = [ROLES.BARTENDER, ROLES.BANQUET_SERVER, ROLES.BARBACK];

// Map any historical / case variant to the canonical label, or null if unknown.
// Legacy 'Server' (the old admin dropdown value) maps to 'Banquet Server'.
function canonicalizeRole(value) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim().toLowerCase();
  if (v === 'bartender') return ROLES.BARTENDER;
  if (v === 'banquet server' || v === 'server') return ROLES.BANQUET_SERVER;
  if (v === 'barback') return ROLES.BARBACK;
  return null;
}

function isBartender(position) {
  return typeof position === 'string' && position.trim().toLowerCase() === 'bartender';
}

module.exports = { ROLES, CANONICAL_LABELS, canonicalizeRole, isBartender };
