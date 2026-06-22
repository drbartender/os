import React, { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import DOMPurify from 'dompurify';
import PublicLayout from '../../components/PublicLayout';

const API_BASE = process.env.REACT_APP_API_URL || '';

function resolveImageUrl(url) {
  if (!url) return url;
  if (url.startsWith('/api/')) return `${API_BASE}${url}`;
  return url;
}

function resolveBodyImageUrls(html) {
  if (!html || !API_BASE) return html;
  return html.replace(/src="(\/api\/[^"]+)"/g, `src="${API_BASE}$1"`);
}

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

export default function BlogPost() {
  const { slug } = useParams();
  const [post, setPost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/api/blog/${slug}`)
      .then(r => {
        if (!r.ok) throw new Error('Not found');
        return r.json();
      })
      .then(data => setPost(data))
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [slug]);

  // Sanitize the post body once per body change, not on every render. DOMPurify
  // walks the full HTML tree, so re-running it each render is wasted work.
  // resolveBodyImageUrls + API_BASE are module-scope constants, so the raw body
  // is the only input. Placed above the early returns to keep hook order stable.
  const sanitizedBody = useMemo(
    () => DOMPurify.sanitize(resolveBodyImageUrls(post?.body)),
    [post?.body]
  );

  if (loading) {
    return (
      <PublicLayout>
        <div className="loading" style={{ padding: '4rem 0' }}><div className="spinner" />Loading...</div>
      </PublicLayout>
    );
  }

  if (notFound || !post) {
    return (
      <PublicLayout>
        <div className="public-error">
          <span className="public-error-eyebrow">Lab Notes</span>
          <h1>We couldn't find that lab note.</h1>
          <p className="public-error-body">
            The link may have been mistyped, or the post might have been moved or removed.
            Try the index — there's plenty more in the archive.
          </p>
          <div className="public-error-actions">
            <Link to="/labnotes" className="btn btn-primary">Browse all Lab Notes</Link>
            <Link to="/" className="public-error-link">Back to drbartender.com</Link>
          </div>
        </div>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout>
      <article className="lab-notebook">
        {post.cover_image_url && (
          <div className="lab-notebook-cover">
            {/* Article hero / LCP image — intentionally NOT lazy (lazy-loading the
                LCP element hurts it); only hint async decoding. */}
            <img src={resolveImageUrl(post.cover_image_url)} alt={post.title} decoding="async" />
          </div>
        )}
        <div className="lab-notebook-header">
          <Link to="/labnotes" className="lab-notebook-back">&larr; Back to Lab Notes</Link>
          {post.chapter_number && (
            <span className="lab-notebook-chapter">Lab Notes No. {post.chapter_number}</span>
          )}
          <h1 className="lab-notebook-title">{post.title}</h1>
          <div className="lab-notebook-meta">
            <span>{formatDate(post.published_at)}</span>
            <span className="lab-notebook-meta-sep">&middot;</span>
            <span>Dr. Bartender</span>
          </div>
        </div>
        <div
          className="lab-notebook-body"
          dangerouslySetInnerHTML={{ __html: sanitizedBody }}
        />
        <div className="lab-notebook-footer">
          <Link to="/labnotes" className="lab-notebook-back">&larr; Back to Lab Notes</Link>
        </div>
      </article>
    </PublicLayout>
  );
}
