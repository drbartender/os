import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';

const API_BASE = process.env.REACT_APP_API_URL || '';

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
        <section className="ws-section lab-notebook">
          <div className="blog-post-not-found">
            <h1>Post Not Found</h1>
            <p>The post you're looking for doesn't exist or has been removed.</p>
            <Link to="/labnotes" className="btn btn-primary">Back to Lab Notes</Link>
          </div>
        </section>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout>
      <article className="lab-notebook">
        {post.cover_image_url && (
          <div className="lab-notebook-cover">
            <img src={post.cover_image_url} alt={post.title} />
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
          dangerouslySetInnerHTML={{ __html: post.body }}
        />
        <div className="lab-notebook-footer">
          <Link to="/labnotes" className="lab-notebook-back">&larr; Back to Lab Notes</Link>
        </div>
      </article>
    </PublicLayout>
  );
}
