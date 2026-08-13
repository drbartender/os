/**
 * Helpers shared by more than one emailMarketing sub-router.
 *
 * compileEmailDesign lives here because campaigns.js (create and update) and
 * designer.js (preview) both compile a design, and a second copy of the
 * baseUrl binding is how a designed email starts rendering different image
 * URLs depending on which route touched it last.
 */
const { compileDesign } = require('../../utils/emailDesign');
const { API_URL } = require('../../utils/urls');

const compileEmailDesign = (design) => compileDesign(design, { baseUrl: API_URL });

module.exports = { compileEmailDesign };
