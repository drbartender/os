import React from 'react';

// Module-scoped lazy ref to the Sentry SDK. Kept in sync with the lazy init
// in index.js so the class component below can call captureException without
// a static import pulling the SDK into the main bundle. Errors during the
// brief init window simply aren't reported — acceptable because this only
// fires on unhandled render errors, which are rare.
let sentryRef = null;
if (process.env.REACT_APP_SENTRY_DSN_CLIENT) {
  import('@sentry/react').then((m) => { sentryRef = m; });
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    if (sentryRef) {
      sentryRef.captureException(error, { extra: errorInfo });
    }
  }

  handleRefresh = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary-fallback">
          <h2>Something went wrong</h2>
          <p>An unexpected error occurred. Please refresh the page to try again.</p>
          <button type="button" onClick={this.handleRefresh}>Refresh page</button>
          {process.env.NODE_ENV === 'development' && this.state.error && (
            <pre className="error-boundary-stack">
              {this.state.error.toString()}
              {'\n'}
              {this.state.error.stack}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
