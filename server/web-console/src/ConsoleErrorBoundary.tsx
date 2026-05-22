import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/** Catches render errors so Mission Control shows a message instead of a blank page. */
export class ConsoleErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Console render error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="banner error" style={{ margin: "1rem" }}>
          <strong>Mission Control could not load.</strong>
          <p style={{ margin: "0.5rem 0 0" }}>{this.state.error.message}</p>
          <p className="muted" style={{ margin: "0.5rem 0 0" }}>
            Try a hard refresh (Ctrl+Shift+R or Cmd+Shift+R). If this keeps happening, clear site
            data for this site or open the page in a private window, then sign in again.
          </p>
          <button
            type="button"
            className="btn sm"
            style={{ marginTop: "0.75rem" }}
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
