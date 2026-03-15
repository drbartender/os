import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="page-container" style={{ padding: '3rem 1rem', textAlign: 'center' }}>
          <div className="card" style={{ maxWidth: 480, margin: '0 auto' }}>
            <h2 style={{ marginBottom: '0.75rem' }}>Something went wrong</h2>
            <p className="text-muted" style={{ marginBottom: '1.5rem' }}>
              We hit an unexpected error. You can try reloading the page.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
