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
  return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

export default function Blog() {
  const toast = useToast();
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/api/blog`)
      .then(r => {
        if (!r.ok) throw new Error('Failed to load');
        return r.json();
      })
      .then(data => setPosts(data))
      .catch(() => toast.error('Failed to load. Try refreshing.'))
      .finally(() => setLoading(false));
  }, [toast]);

  return (
    <PublicLayout>
      <section className="ws-section lab-index-section">
        <div className="lab-index-header">
          <span className="lab-index-kicker">Field Notes &amp; Findings</span>
          <h1 className="lab-index-title">Lab Notes</h1>
          <p className="lab-index-subtitle">
            Experiments, observations, and dispatches from behind the bar.
          </p>
        </div>

        {loading ? (
          <div className="loading"><div className="spinner" />Loading...</div>
        ) : posts.length === 0 ? (
          <div className="lab-index-empty">
            <p>The lab notebook is empty — experiments in progress. Check back soon!</p>
          </div>
        ) : (
          <div className="lab-index-grid">
            {posts.map(post => (
              <Link to={`/labnotes/${post.slug}`} key={post.id} className="lab-card">
                <div className="lab-card-image-wrap">
                  {post.cover_image_url ? (
                    <img src={resolveImageUrl(post.cover_image_url)} alt={post.title} className="lab-card-image" />
                  ) : (
                    <div className="lab-card-placeholder">
                      <span>Dr. B</span>
                    </div>
                  )}
                </div>
                <div className="lab-card-body">
                  {post.chapter_number && (
                    <span className="lab-card-chapter">No. {post.chapter_number}</span>
                  )}
                  <h3 className="lab-card-title">{post.title}</h3>
                  {post.excerpt && <p className="lab-card-excerpt">{post.excerpt}</p>}
                  <span className="lab-card-date">{formatDate(post.published_at)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </PublicLayout>
  );
}
