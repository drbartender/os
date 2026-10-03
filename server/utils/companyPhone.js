// server/utils/companyPhone.js
//
// The company numbers a CLIENT may see. Mirrors COMPANY_PHONE and
// COMPANY_TEXT_PHONE in client/src/utils/constants.js; client and server
// bundles are separate, so the two are kept in sync by hand (same arrangement
// as eventTypes.js). Change both together.
//
// Never print an env-configured agent number to a client. ADMIN_PHONE,
// VA_CELL, and the voicemail targets are routing config for calls and alerts
// TO the team; ADMIN_PHONE was Dallas's personal cell when the drink-plan
// nudge printed it as "call or text us at", and clients texted his cell.
//
// No requires: email template modules with require cycles can import this.

// VOICE: the primary business line (+12242221922). The number to CALL.
const COMPANY_PHONE = '(224) 222-1922';

// SMS: still the toll-free 888 until the 224 numbers clear A2P 10DLC
// registration. The number to TEXT.
const COMPANY_TEXT_PHONE = '(888) 231-4320';

module.exports = { COMPANY_PHONE, COMPANY_TEXT_PHONE };
