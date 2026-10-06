/*
 * Dev-only gate shared by the scripts that mint dev JWTs against the dev
 * branch (scripts/dev-signin.js, scripts/mobile-capture.js). Call it BEFORE any
 * DB connection or token minting; `die` prints and exits.
 *
 * The URL's host alone is not enough: pg connects to a ?host= (or ?hostaddr=)
 * query parameter over the URL's own host, and a non-postgres scheme such as
 * socket:// skips the network entirely. A URL that will not parse is refused
 * without echoing it, because Node's ERR_INVALID_URL prints the input,
 * password included (security review, 2026-10-06).
 */
const DEV_DB_HOSTS = ['ep-old-feather-adoh3rf3-pooler.c-2.us-east-1.aws.neon.tech'];

function assertDevDatabase(die) {
  if (process.env.NODE_ENV === 'production') die('refusing to run: NODE_ENV=production');
  if (!process.env.DATABASE_URL) die('DATABASE_URL missing');
  let url;
  try {
    url = new URL(process.env.DATABASE_URL);
  } catch (e) {
    die('refusing to run: DATABASE_URL is not a parseable URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) die('refusing to run: DATABASE_URL is not postgres://');
  if (url.searchParams.has('host') || url.searchParams.has('hostaddr')) {
    die('refusing to run: DATABASE_URL overrides its host in the query string');
  }
  if (!DEV_DB_HOSTS.includes(url.hostname)) die(`refusing to run: DATABASE_URL host "${url.hostname}" is not the dev branch`);
}

module.exports = { assertDevDatabase, DEV_DB_HOSTS };
