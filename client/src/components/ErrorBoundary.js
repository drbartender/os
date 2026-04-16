import React from 'react';
import * as Sentry from '@sentry/react';

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
    if (process.env.REACT_APP_SENTRY_DSN_CLIENT) {
      Sentry.captureException(error, { extra: errorInfo });
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
