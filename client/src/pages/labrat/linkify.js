// Auto-link drbartender.com URLs inside mission step text.
// Same-origin URLs (drbartender.com/...) become relative paths so they open
// in the current origin (useful for localhost dev). Subdomain URLs stay absolute.

const URL_RE = /\b((?:[a-z0-9-]+\.)*drbartender\.com(?:\/\S*)?)/gi;
const TRAIL_PUNCT = /[.,);:!?]+$/;

function hrefFor(url) {
  const sub = url.match(/^([a-z0-9-]+)\.drbartender\.com/i);
  if (sub && sub[1] !== 'www') {
    // Cross-subdomain — must be absolute
    return `https://${url}`;
  }
  // drbartender.com or www.drbartender.com — make it relative so the link
  // opens on the current origin (localhost dev or prod).
  return '/' + url.replace(/^(?:www\.)?drbartender\.com\/?/i, '');
}

export function linkify(text) {
  if (!text) return text;
  const parts = [];
  let lastIndex = 0;
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > lastIndex) parts.push(text.slice(lastIndex, m.index));
    let url = m[1];
    const trail = (url.match(TRAIL_PUNCT) || [''])[0];
    if (trail) url = url.slice(0, -trail.length);
    const sameOrigin = !/^([a-z0-9-]+)\.drbartender\.com/i.test(url) || /^www\./i.test(url);
    const href = hrefFor(url);
    parts.push(
      <a
        key={`lr-link-${parts.length}`}
        href={href}
        target={sameOrigin ? '_self' : '_blank'}
        rel="noopener noreferrer"
      >{url}</a>
    );
    if (trail) parts.push(trail);
    lastIndex = m.index + m[1].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length ? parts : text;
}
