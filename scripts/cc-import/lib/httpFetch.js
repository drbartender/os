const https = require('https');
const http = require('http');
const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB hard cap (spec §8.0)

// Private / loopback / link-local ranges that must never be reached from a
// Phase 0 fetch (SSRF guard, spec §8.0).
const PRIVATE_RANGES_V4 = [
  { v4: '10.0.0.0', mask: 8 },
  { v4: '172.16.0.0', mask: 12 },
  { v4: '192.168.0.0', mask: 16 },
  { v4: '127.0.0.0', mask: 8 },
  { v4: '169.254.0.0', mask: 16 },
];

const ALLOWED_TYPES = [/^image\//i, /^application\/pdf$/i, /^video\//i];

function ipv4ToInt(addr) {
  const parts = addr.split('.').map(Number);
  // Force unsigned 32-bit so masking arithmetic is correct.
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIp(addr) {
  if (net.isIPv6(addr)) {
    const lower = addr.toLowerCase();
    // IPv6 link-local fe80::/10 (any address whose first 10 bits are 1111111010)
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return true;
    }
    // IPv6 loopback ::1
    if (lower === '::1') return true;
    // IPv4-mapped IPv6 (::ffff:1.2.3.4): re-check the embedded v4
    const mappedMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedMatch) return isPrivateIp(mappedMatch[1]);
    return false;
  }
  if (!net.isIPv4(addr)) return false;
  const ipInt = ipv4ToInt(addr);
  for (const range of PRIVATE_RANGES_V4) {
    const rangeInt = ipv4ToInt(range.v4);
    const mask = range.mask === 0 ? 0 : ((~0) << (32 - range.mask)) >>> 0;
    if ((ipInt & mask) === (rangeInt & mask)) return true;
  }
  return false;
}

async function ssrfCheck(hostname) {
  // Bracketed IPv6 literals come in as `[fe80::1]`; strip brackets before lookup.
  const host = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  // If the hostname is itself a literal IP, lookup will short-circuit but we
  // still want to validate it.
  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      throw new Error(`SSRF guard: refused private/loopback IP ${host}`);
    }
    return;
  }

  const records = await dns.lookup(host, { all: true });
  for (const r of records) {
    if (isPrivateIp(r.address)) {
      throw new Error(`SSRF guard: refused private/loopback IP ${r.address} for ${hostname}`);
    }
  }
}

function isAllowedType(contentType) {
  if (!contentType) return false;
  const head = contentType.split(';')[0].trim().toLowerCase();
  return ALLOWED_TYPES.some(re => re.test(head));
}

function isPermanentFailure(err) {
  const msg = String(err && err.message || err);
  return msg.startsWith('SSRF guard:')
    || msg.startsWith('Size exceeded:')
    || msg.startsWith('Disallowed content-type:');
}

function clientFor(protocol) {
  return protocol === 'https:' ? https : http;
}

function requestPromise(method, urlString) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlString); } catch (e) { return reject(new Error(`Invalid URL: ${urlString}`)); }
    const lib = clientFor(parsed.protocol);
    const req = lib.request(urlString, { method, timeout: 30000 }, (res) => {
      // Follow simple redirects manually so SSRF re-validation runs on the new host.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, urlString).toString();
        return resolve({ redirect: next });
      }
      resolve({ res });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
    req.end();
  });
}

async function followedRequest(method, urlString, maxRedirects = 5) {
  let current = urlString;
  for (let i = 0; i <= maxRedirects; i++) {
    // Re-validate every redirect target — internal links must not bypass SSRF.
    const { hostname } = new URL(current);
    await ssrfCheck(hostname);
    const result = await requestPromise(method, current);
    if (result.redirect) {
      current = result.redirect;
      continue;
    }
    return { res: result.res, finalUrl: current };
  }
  throw new Error(`Too many redirects: ${urlString}`);
}

async function fetchOnce(url) {
  // HEAD-check first when possible.
  try {
    const head = await followedRequest('HEAD', url);
    const status = head.res.statusCode;
    if (status >= 500) {
      head.res.resume();
      throw new Error(`Server error ${status} on HEAD ${url}`);
    }
    if (status < 400) {
      const len = Number(head.res.headers['content-length']);
      const ct = head.res.headers['content-type'];
      head.res.resume();
      if (Number.isFinite(len) && len > MAX_BYTES) {
        throw new Error(`Size exceeded: ${len} > ${MAX_BYTES} (HEAD) for ${url}`);
      }
      if (ct && !isAllowedType(ct)) {
        throw new Error(`Disallowed content-type: ${ct} for ${url}`);
      }
    } else {
      head.res.resume();
      // 4xx on HEAD → some servers don't support HEAD. Fall through to GET.
    }
  } catch (err) {
    // If HEAD already produced a permanent failure (size/type/ssrf), surface it.
    if (isPermanentFailure(err)) throw err;
    // Otherwise the GET below is the source of truth; swallow HEAD-only network errors.
    if (!String(err.message).includes('Server error 5')) {
      // not a 5xx — fall through; GET may still work
    }
  }

  // GET with streaming size + content-type enforcement.
  const { res } = await followedRequest('GET', url);
  const status = res.statusCode;
  if (status >= 500) {
    res.resume();
    throw new Error(`Server error ${status} on GET ${url}`);
  }
  if (status >= 400) {
    res.resume();
    throw new Error(`Client error ${status} on GET ${url}`);
  }
  const contentType = res.headers['content-type'] || '';
  if (!isAllowedType(contentType)) {
    res.resume();
    throw new Error(`Disallowed content-type: ${contentType} for ${url}`);
  }

  return await new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    res.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BYTES) {
        res.destroy();
        reject(new Error(`Size exceeded: streaming past ${MAX_BYTES} for ${url}`));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve({
      buffer: Buffer.concat(chunks),
      contentType: contentType.split(';')[0].trim().toLowerCase(),
      originalUrl: url,
    }));
    res.on('error', reject);
  });
}

async function fetchToBuffer(url) {
  const delays = [1000, 4000, 16000]; // 3 attempts; spec §8.0
  let lastErr;
  for (let i = 0; i < delays.length; i++) {
    try {
      return await fetchOnce(url);
    } catch (err) {
      if (isPermanentFailure(err)) throw err;
      lastErr = err;
      if (i < delays.length - 1) {
        await new Promise((r) => setTimeout(r, delays[i]));
      }
    }
  }
  throw lastErr;
}

module.exports = {
  fetchToBuffer,
  isPrivateIp,
  isAllowedType,
  isPermanentFailure,
  ssrfCheck,
  MAX_BYTES,
};
