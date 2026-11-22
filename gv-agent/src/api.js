// The box's one HTTP client for the os API (plan Task 7): the secret header, a
// 15 s timeout, and redirects refused. fetch would carry x-gv-agent-secret to
// wherever a redirect points, so a 3xx is an error here, never followed.
const API_TIMEOUT_MS = 15000;

// Returns api(method, route, body) -> { status, body }, body parsed as JSON or
// null. A network failure, a timeout or a redirect throws.
function createApi({ base, secret, timeoutMs = API_TIMEOUT_MS, fetchImpl = fetch }) {
  return async function api(method, route, body) {
    // Fail closed: no request goes out without the secret (startup refuses first).
    if (typeof secret !== 'string' || secret === '') throw new Error('GV_AGENT_SECRET is not set; no request sent');
    const res = await fetchImpl(`${base}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-gv-agent-secret': secret },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    // static-checks: allow swallowed-catch, a body that is not JSON is null; the status still answers
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, body: json };
  };
}

module.exports = { createApi, API_TIMEOUT_MS };
