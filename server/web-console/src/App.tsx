import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { LandingPage } from "./pages/LandingPage";
import { LoginPage } from "./pages/LoginPage";
import { ConsolePage } from "./pages/ConsolePage";
import {
  ChannelsWindowPage,
  OnAirWindowPage,
  AlertsWindowPage,
} from "./pages/ConsoleWindows";

/*
 * Heavy / rarely-accessed pages get pulled in lazily so the initial dispatch bundle stays slim.
 * Vite splits each into its own chunk; the chunk is fetched the first time the route is visited
 * and cached by the browser thereafter. A regular dispatcher who never opens Control / Platform /
 * Map / Bridges / Legal pays for none of that JS on first paint.
 */
const MapWindowPage = lazy(() =>
  import("./pages/MapWindowPage").then((m) => ({ default: m.MapWindowPage })),
);
const BridgeRunnerPage = lazy(() =>
  import("./pages/BridgeRunnerPage").then((m) => ({ default: m.BridgeRunnerPage })),
);
const AdminPage = lazy(() =>
  import("./pages/admin/AdminPage").then((m) => ({ default: m.AdminPage })),
);
const OwnerPage = lazy(() =>
  import("./pages/owner/OwnerPage").then((m) => ({ default: m.OwnerPage })),
);
const LegalPage = lazy(() =>
  import("./pages/legal/LegalPage").then((m) => ({ default: m.LegalPage })),
);

export function App() {
  const { ready, user } = useAuth();

  if (!ready) {
    return <div className="boot">Loading…</div>;
  }

  // Where a signed-in account lands — platform owners have no agency, so the
  // radio console is not their home.
  const home = user?.role === "owner" ? "/owner" : "/console";

  return (
    <Suspense fallback={<div className="boot">Loading…</div>}>
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={user ? <Navigate to={home} replace /> : <LoginPage />} />
      <Route
        path="/console"
        element={
          !user ? (
            <Navigate to="/login" replace />
          ) : user.role === "owner" ? (
            <Navigate to="/owner" replace />
          ) : (
            <ConsolePage />
          )
        }
      />
      <Route
        path="/console/map"
        element={
          !user ? (
            <Navigate to="/login" replace />
          ) : user.role === "owner" ? (
            <Navigate to="/owner" replace />
          ) : (
            <MapWindowPage />
          )
        }
      />
      <Route
        path="/console/channels"
        element={
          !user ? (
            <Navigate to="/login" replace />
          ) : user.role === "owner" ? (
            <Navigate to="/owner" replace />
          ) : (
            <ChannelsWindowPage />
          )
        }
      />
      <Route
        path="/console/onair"
        element={
          !user ? (
            <Navigate to="/login" replace />
          ) : user.role === "owner" ? (
            <Navigate to="/owner" replace />
          ) : (
            <OnAirWindowPage />
          )
        }
      />
      <Route
        path="/console/alerts"
        element={
          !user ? (
            <Navigate to="/login" replace />
          ) : user.role === "owner" ? (
            <Navigate to="/owner" replace />
          ) : (
            <AlertsWindowPage />
          )
        }
      />
      <Route
        path="/bridges"
        element={
          !user ? (
            <Navigate to="/login" replace />
          ) : user.role === "owner" ? (
            <Navigate to="/owner" replace />
          ) : (
            <BridgeRunnerPage />
          )
        }
      />
      <Route
        path="/owner/*"
        element={
          !user ? (
            <Navigate to="/login" replace />
          ) : user.role === "owner" ? (
            <OwnerPage />
          ) : (
            <Navigate to="/console" replace />
          )
        }
      />
      <Route
        path="/admin/*"
        element={
          !user ? (
            <Navigate to="/login" replace />
          ) : user.role === "admin" ? (
            <AdminPage />
          ) : (
            <Navigate to="/console" replace />
          )
        }
      />
      <Route path="/legal/terms" element={<LegalPage doc="terms" />} />
      <Route path="/legal/privacy" element={<LegalPage doc="privacy" />} />
      <Route path="/legal/eula" element={<LegalPage doc="eula" />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}
