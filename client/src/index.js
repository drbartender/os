import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import './index.css';
import App from './App';

if (process.env.REACT_APP_SENTRY_DSN_CLIENT) {
  Sentry.init({
    dsn: process.env.REACT_APP_SENTRY_DSN_CLIENT,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.1,
  });
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<React.StrictMode><App /></React.StrictMode>);
