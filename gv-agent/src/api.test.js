// The box's HTTP client for the os API (review fix 6): the secret header, a
// parsed body, and no redirect ever followed. A loopback server only; no
// outside network. Run: `node --test src/api.test.js`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApi } = require('./api');

async function serve(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, secret: req.headers['x-gv-agent-secret'], raw });
      handler(req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

test('a redirect is refused, never followed with the secret', async (t) => {
  const { base, seen } = await serve(t, (req, res) => {
    if (req.url === '/elsewhere') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }
    res.writeHead(302, { Location: '/elsewhere' });
    res.end();
  });
  const api = createApi({ base, secret: 'test-secret' });
  await assert.rejects(api('GET', '/api/gv-agent/pending'));
  await assert.rejects(api('POST', '/api/gv-agent/report', { id: 41, outcome: 'sent' }));
  assert.deepEqual(seen.map((s) => s.url), ['/api/gv-agent/pending', '/api/gv-agent/report'],
    'the redirect target is never asked');
});

test('an answer comes back as status and parsed body, with the secret sent', async (t) => {
  const { base, seen } = await serve(t, (req, res) => {
    if (req.url === '/api/gv-agent/report') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(500);
    res.end('not json');
  });
  const api = createApi({ base, secret: 'test-secret' });
  assert.deepEqual(await api('POST', '/api/gv-agent/report', { id: 41, outcome: 'sent' }), { status: 200, body: { ok: true } });
  assert.deepEqual(await api('GET', '/api/gv-agent/pending'), { status: 500, body: null });
  assert.deepEqual(seen[0], {
    method: 'POST', url: '/api/gv-agent/report', secret: 'test-secret', raw: '{"id":41,"outcome":"sent"}',
  });
  assert.equal(seen[1].raw, '', 'a GET carries no body');
});

test('an unset or empty secret sends nothing', async (t) => {
  const { base, seen } = await serve(t, (_req, res) => { res.writeHead(200); res.end('[]'); });
  for (const secret of [undefined, '']) {
    const api = createApi({ base, secret });
    await assert.rejects(api('GET', '/api/gv-agent/pending'), /GV_AGENT_SECRET is not set/);
  }
  assert.equal(seen.length, 0, 'no request reached the server');
});
