'use strict';
// The one list of service_extensions statuses that MOVED the proposal's
// duration. serviceExtensionSettle.js writes them; contractDuration.js and
// every re-price that derives the contract's hours read them, so a new settle
// outcome cannot be added in one place and missed in the other. Kept in its
// own module (settle requires the db and the curfew; the pricing readers must
// not).
const SETTLE_OUTCOMES = new Set(['paid', 'overridden']);
// Closed without moving the row: the request never became time.
const CLOSE_OUTCOMES = new Set(['expired', 'cancelled']);

module.exports = { SETTLE_OUTCOMES, CLOSE_OUTCOMES };
