import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../utils/api';
import './FeedbackPage.css';

export default function FeedbackPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [stars, setStars] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get(`/public/feedback/${token}`)
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(() => { if (!cancelled) setError('not-found'); });
    return () => { cancelled = true; };
  }, [token]);

  if (error === 'not-found') {
    return (
      <main className="feedback-page">
        <header className="feedback-hero">
          <p className="kicker">Dr. Bartender</p>
          <h1>This feedback page isn't available.</h1>
        </header>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="feedback-page" aria-busy="true">
        <header className="feedback-hero">
          <p className="kicker">Dr. Bartender</p>
          <h1>Loading...</h1>
        </header>
      </main>
    );
  }
  if (data.already_submitted) {
    return (
      <main className="feedback-page">
        <header className="feedback-hero">
          <p className="kicker">Dr. Bartender</p>
          <h1>Thanks again, {data.client_first_name}.</h1>
          <p>We already received your feedback for this event.</p>
        </header>
      </main>
    );
  }
  if (done) {
    return (
      <main className="feedback-page">
        <header className="feedback-hero">
          <p className="kicker">Dr. Bartender</p>
          <h1>Thank you, {data.client_first_name}.</h1>
          <p>Your feedback went straight to Dallas. He'll reach out personally.</p>
        </header>
      </main>
    );
  }

  async function clickStar(n) {
    setStars(n);
    if (n >= 4) {
      // High rating: submit then follow server redirect to Google Reviews.
      setSubmitting(true);
      try {
        const r = await api.post(`/public/feedback/${token}`, { rating: n });
        if (r.data?.redirect_url) {
          window.location.href = r.data.redirect_url;
          return;
        }
        setDone(true);
      } catch (err) {
        // 409 conflict means already submitted, treat as success-like
        if (err?.status === 409) {
          setDone(true);
        } else {
          // eslint-disable-next-line no-alert
          alert('Could not submit feedback. Please try again in a moment.');
          setStars(0);
        }
      } finally {
        setSubmitting(false);
      }
    }
  }

  async function submitLowRating(e) {
    e.preventDefault();
    if (!stars || stars >= 4) return;
    setSubmitting(true);
    try {
      await api.post(`/public/feedback/${token}`, { rating: stars, comment });
      setDone(true);
    } catch (err) {
      if (err?.status === 409) {
        setDone(true);
      } else {
        // eslint-disable-next-line no-alert
        alert('Could not submit feedback. Please try again in a moment.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const showLowForm = stars >= 1 && stars <= 3 && !submitting;

  return (
    <main className="feedback-page">
      <header className="feedback-hero">
        <p className="kicker">Dr. Bartender</p>
        <h1>How was your {data.event_type_label}, {data.client_first_name}?</h1>
        <p className="hero-sub">Tap a star to rate.</p>
      </header>

      <section className="rating-row" aria-label="Rating">
        {[1, 2, 3, 4, 5].map(n => {
          const active = (hovered || stars) >= n;
          return (
            <button
              key={n}
              type="button"
              className={`star-btn ${active ? 'active' : ''}`}
              onMouseEnter={() => setHovered(n)}
              onMouseLeave={() => setHovered(0)}
              onClick={() => clickStar(n)}
              disabled={submitting}
              aria-label={`${n} star${n > 1 ? 's' : ''}`}
            >
              {active ? '★' : '☆'}
            </button>
          );
        })}
      </section>

      {showLowForm && (
        <form className="low-rating-form" onSubmit={submitLowRating}>
          <label htmlFor="comment">What could we have done better?</label>
          <textarea
            id="comment"
            value={comment}
            onChange={e => setComment(e.target.value)}
            maxLength={2000}
            rows={5}
            placeholder="Optional. Anything you want Dallas to know."
          />
          <button type="submit" disabled={submitting}>
            {submitting ? 'Sending...' : 'Send feedback'}
          </button>
        </form>
      )}

      <footer className="feedback-foot">
        <p>Dr. <b>Bartender</b></p>
        <p className="meta">&copy; {new Date().getFullYear()} Dr. Bartender LLC</p>
      </footer>
    </main>
  );
}
