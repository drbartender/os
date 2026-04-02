import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';

const API_BASE = process.env.REACT_APP_API_URL || '';

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

export default function Blog() {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/api/blog`)
      .then(r => r.json())
      .then(data => setPosts(data))
      .catch(err => console.error(err))
      .finally(() => setLoading(false));
  }, []);

  return (
    <PublicLayout>
      <section className="ws-section blog-index-section">
        <div className="ws-section-heading">
          <p className="ws-kicker">Blog</p>
          <h1>From the Lab</h1>
        </div>

        {loading ? (
          <div className="loading"><div className="spinner" />Loading...</div>
        ) : posts.length === 0 ? (
          <div className="blog-empty">
            <p>No posts yet — check back soon!</p>
          </div>
        ) : (
          <div className="blog-grid">
            {posts.map(post => (
              <Link to={`/labnotes/${post.slug}`} key={post.id} className="blog-card">
                {post.cover_image_url ? (
                  <div className="blog-card-image">
                    <img src={post.cover_image_url} alt={post.title} />
                  </div>
                ) : (
                  <div className="blog-card-image blog-card-placeholder">
                    <span>Dr. B</span>
                  </div>
                )}
                <div className="blog-card-body">
                  <h3>{post.title}</h3>
                  {post.excerpt && <p>{post.excerpt}</p>}
                  <span className="blog-card-meta">{formatDate(post.published_at)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </PublicLayout>
  );
}
