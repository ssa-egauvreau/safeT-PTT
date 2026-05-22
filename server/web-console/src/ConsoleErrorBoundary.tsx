import { Component, type ErrorInfo, type ReactNode } from "react";
import { resetMissionControlSavedData } from "./consoleStore";

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
            If the page works in an incognito window but not here, old saved site data is usually the
            cause. Close other Mission Control tabs, then reset layout below (you stay signed in).
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "0.75rem" }}>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                resetMissionControlSavedData();
                window.location.reload();
              }}
            >
              Reset layout and reload
            </button>
            <button type="button" className="btn sm" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
