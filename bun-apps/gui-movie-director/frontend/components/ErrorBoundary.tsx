import React from "react";

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * React Error Boundary — catches rendering errors in the child tree and
 * displays a fallback UI instead of crashing the entire app.
 *
 * Usage:
 *   <ErrorBoundary>
 *     <MyComponent />
 *   </ErrorBoundary>
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] Caught error:", error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "60px 24px",
          gap: 16,
          textAlign: "center",
          minHeight: "60vh",
        }}>
          <div style={{ fontSize: 40, lineHeight: 1 }}>💥</div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--error)" }}>
            Something went wrong
          </h2>
          <p style={{
            margin: 0,
            fontSize: 13,
            color: "var(--text-dim)",
            maxWidth: 480,
            wordBreak: "break-word",
          }}>
            {this.state.error?.message || "An unexpected error occurred in this view."}
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              className="btn btn-primary"
              onClick={() => window.location.reload()}
            >
              Reload App
            </button>
            <button
              className="btn"
              onClick={this.handleReset}
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
