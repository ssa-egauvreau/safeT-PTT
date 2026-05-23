import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { AuthProvider } from "./auth";
import { applyTheme, getTheme } from "./theme";
import "react-grid-layout/css/styles.css";
import "./styles.css";

function showBootFatal(message: string): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "boot-fatal";
  const h1 = document.createElement("h1");
  h1.textContent = "safeT PTT could not start";
  const p1 = document.createElement("p");
  p1.textContent = message;
  const p2 = document.createElement("p");
  p2.className = "muted";
  p2.textContent = "Try opening /console?console_reset=1 or use an incognito window.";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn";
  btn.textContent = "Clear saved data and reload";
  btn.onclick = () => {
    window.location.href = "/console?console_reset=1";
  };
  wrap.append(h1, p1, p2, btn);
  root.append(wrap);
}

applyTheme(getTheme());

try {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AppErrorBoundary>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </AppErrorBoundary>
    </React.StrictMode>,
  );
} catch (err) {
  const msg = err instanceof Error ? err.message : "Unknown startup error";
  showBootFatal(msg);
  console.error(err);
}

window.addEventListener("error", (event) => {
  if (event.message && document.getElementById("root")?.childElementCount === 0) {
    showBootFatal(event.message);
  }
});
