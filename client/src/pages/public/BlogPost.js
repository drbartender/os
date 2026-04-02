import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';

const API_BASE = process.env.REACT_APP_API_URL || '';

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function renderBlocks(bodyStr) {
  let blocks;
  try {
    blocks = JSON.parse(bodyStr);
    if (!Array.isArray(blocks)) throw new Error('not array');
  } catch {
    // Fallback: treat as plain text/HTML
    return <div className="blog-post-body" dangerouslySetInnerHTML={{ __html: bodyStr }} />;
  }

  return (
    <div className="blog-post-body">
      {blocks.map((block, i) => {
        if (block.type === 'image') {
          return (
            <figure key={i} className="blog-post-figure">
              <img src={block.url} alt={block.caption || ''} />
              {block.caption && <figcaption>{block.caption}</figcaption>}
            </figure>
          );
        }
        // Text block — split on double newlines for paragraphs
        const paragraphs = (block.content || '').split(/\n\n+/);
        return (
          <div key={i} className="blog-post-text-block">
            {paragraphs.map((p, j) => {
              // Single newlines become <br>
              const parts = p.split('\n');
              return (
                <p key={j}>
                  {parts.map((line, k) => (
                    <React.Fragment key={k}>
                      {k > 0 && <br />}
                      {line}
                    </React.Fragment>
                  ))}
                </p>
              );
            })}
          </div>
        );
      })}
    </div>
  );
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
        <section className="ws-section blog-post-section">
          <div className="blog-post-not-found">
            <h1>Post Not Found</h1>
            <p>The post you're looking for doesn't exist or has been removed.</p>
            <Link to="/blog" className="btn btn-primary">Back to Blog</Link>
          </div>
        </section>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout>
      <article className="blog-post-section">
        {post.cover_image_url && (
          <div className="blog-post-cover">
            <img src={post.cover_image_url} alt={post.title} />
          </div>
        )}
        <div className="blog-post-content">
          <Link to="/blog" className="blog-back-link">&larr; Back to Blog</Link>
          <h1>{post.title}</h1>
          <p className="blog-post-date">{formatDate(post.published_at)}</p>
          {renderBlocks(post.body)}
        </div>
      </article>
    </PublicLayout>
  );
}
