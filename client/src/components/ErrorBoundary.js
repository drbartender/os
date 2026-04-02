import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
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
            {this.state.error && (
              <pre style={{ textAlign: 'left', fontSize: '0.75rem', background: '#f5f5f5', padding: '1rem', borderRadius: 8, overflow: 'auto', maxHeight: 200, marginBottom: '1rem' }}>
                {this.state.error.toString()}
                {'\n'}
                {this.state.error.stack}
              </pre>
            )}
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
