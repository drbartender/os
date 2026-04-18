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
    });
  });
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<React.StrictMode><App /></React.StrictMode>);
