import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';
import { useToast } from '../../context/ToastContext';

const API_BASE = process.env.REACT_APP_API_URL || '';

function resolveImageUrl(url) {
  if (!url) return url;
  if (url.startsWith('/api/')) return `${API_BASE}${url}`;
  return url;
}

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

export default function Blog() {
  const toast = useToast();
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/api/blog`)
      .then((r) => {
        if (!r.ok) throw new Error('Failed to load');
        return r.json();
      })
      .then((data) => setPosts(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load. Try refreshing.'))
      .finally(() => setLoading(false));
  }, [toast]);

  const featured = posts[0];
  const rest = posts.slice(1);

  return (
    <PublicLayout>
      <section className="ws-press-pagehero">
        <div className="ws-wrap">
          <div className="ornament" aria-hidden="true">⚗</div>
          <div className="ws-press-eyebrow">No. 06 · Lab Notes</div>
          <h1 className="ws-press-pagehero-title">Lab Notes.</h1>
          <p className="ws-press-pagehero-sub">
            Dispatches from behind the stick. Recipes, field reports, and the occasional rant about bad ice.
          </p>
        </div>
      </section>

      {loading && (
        <section className="ws-press-labnotes">
          <div className="ws-wrap">
            <div className="loading" role="status" aria-live="polite">
              <div className="spinner" aria-hidden="true" />Loading the notebook...
            </div>
          </div>
        </section>
      )}

      {!loading && posts.length === 0 && (
        <section className="ws-press-labnotes">
          <div className="ws-wrap">
            <div className="card on-paper" style={{ textAlign: 'center', padding: '40px 24px' }}>
              <p>The lab notebook is empty. Experiments in progress. Check back soon!</p>
            </div>
          </div>
        </section>
      )}

      {!loading && featured && (
        <section className="ws-press-labnotes-featured">
          <div className="ws-wrap">
            <Link to={`/labnotes/${featured.slug}`} className="card ws-labnotes-featured">
              <div className="ws-labnotes-featured-img">
                {featured.cover_image_url ? (
                  // Container CSS already pins dimensions (min-height / breakpoint
                  // aspect-ratio + img width/height/object-fit), so layout shift is
                  // covered; only add lazy/async decoding to defer offscreen loads.
                  <img
                    src={resolveImageUrl(featured.cover_image_url)}
                    alt={featured.title}
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <div className="lab-cover-fallback" style={{ aspectRatio: '4 / 3', height: '100%' }} aria-hidden="true">
                    <span>⚗</span>
                  </div>
                )}
              </div>
              <div className="ws-labnotes-featured-body">
                <div className="kicker no-rule" style={{ color: 'var(--text-muted)' }}>
                  Featured{featured.chapter_number ? ` · No. ${featured.chapter_number}` : ''}
                </div>
                <h2 className="ws-labnotes-featured-title">{featured.title}</h2>
                {featured.excerpt && <p>{featured.excerpt}</p>}
                <div className="ws-labnotes-featured-meta">
                  <span>{formatDate(featured.published_at)}</span>
                </div>
                <span className="btn btn-secondary" style={{ marginTop: 22, alignSelf: 'flex-start' }}>Read the entry →</span>
              </div>
            </Link>
          </div>
        </section>
      )}

      {!loading && rest.length > 0 && (
        <section className="ws-press-labnotes-index">
          <div className="ws-wrap">
            <div className="divider-ornate ws-press-divider"><span>the index</span></div>
            <div className="ws-labnotes-grid">
              {rest.map((post) => (
                <Link key={post.id} to={`/labnotes/${post.slug}`} className="card ws-labnotes-card">
                  <div className="ws-labnotes-card-img">
                    {post.cover_image_url ? (
                      // .ws-labnotes-card-img already sets aspect-ratio: 4/3 on the
                      // container (img fills it), so dimensions are reserved; just
                      // add lazy/async so below-the-fold index cards defer loading.
                      <img
                        src={resolveImageUrl(post.cover_image_url)}
                        alt={post.title}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div className="lab-cover-fallback" style={{ aspectRatio: '4 / 3' }} aria-hidden="true">
                        <span>⚗</span>
                      </div>
                    )}
                  </div>
                  <div className="ws-labnotes-card-body">
                    <div className="ws-labnotes-card-meta">
                      <span>{post.chapter_number ? `No. ${post.chapter_number}` : 'Field Notes'}</span>
                    </div>
                    <h3 className="ws-labnotes-card-title">{post.title}</h3>
                    {post.excerpt && <p className="ws-labnotes-card-excerpt">{post.excerpt}</p>}
                    <div className="ws-labnotes-card-date">{formatDate(post.published_at)}</div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}
    </PublicLayout>
  );
}
