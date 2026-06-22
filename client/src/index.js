import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

// Lazy-load Sentry only when DSN is configured — keeps ~50-80KB out of the
// main bundle for dev builds and any env that hasn't opted in.
if (process.env.REACT_APP_SENTRY_DSN_CLIENT) {
  import('@sentry/react').then((Sentry) => {
    Sentry.init({
      dsn: process.env.REACT_APP_SENTRY_DSN_CLIENT,
      environment: process.env.NODE_ENV,
      tracesSampleRate: 0.1,
      // Drop noise that is not our code or already self-heals (triaged 2026-06-22):
      //  - stale code-split chunk after a deploy: the SPA rewrite serves
      //    index.html for a missing hashed chunk, so the dynamic import parses
      //    HTML and throws; App.js already self-heals with a one-time reload.
      //  - browser-extension injected WebExtension messaging, never our code.
      ignoreErrors: [
        /Unexpected token '<'/,
        /ChunkLoadError/,
        /Loading chunk \d+ failed/,
        /runtime\.sendMessage/,
        'Tab not found',
      ],
    });
  });
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<React.StrictMode><App /></React.StrictMode>);
