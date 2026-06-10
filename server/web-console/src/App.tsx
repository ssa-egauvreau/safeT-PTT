import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { LandingPage } from "./pages/LandingPage";
import { LoginPage } from "./pages/LoginPage";
import { ConsolePage } from "./pages/ConsolePage";
import { ChannelsWindowPage, AlertsWindowPage } from "./pages/ConsoleWindows";

/*
 * Heavy / rarely-accessed pages get pulled in lazily so the initial dispatch bundle stays slim.
 * Vite splits each into its own chunk; the chunk is fetched the first time the route is visited
 * and cached by the browser thereafter. A regular dispatcher who never opens Control / Platform /
 * Map / Bridges / Legal pays for none of that JS on first paint.
 */
const MapWindowPage = lazy(() =>
  import("./pages/MapWindowPage").then((m) => ({ default: m.MapWindowPage })),
);
const BridgesPage = lazy(() =>
  import("./pages/BridgesPage").then((m) => ({ default: m.BridgesPage })),
);
const RadioPortal = lazy(() =>
  import("./pages/RadioPortal").then((m) => ({ default: m.RadioPortal })),
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
const UpdatesPage = lazy(() =>
  import("./pages/UpdatesPage").then((m) => ({ default: m.UpdatesPage })),
);
const SignupPage = lazy(() =>
  import("./pages/SignupPage").then((m) => ({ default: m.SignupPage })),
);
const PricingPage = lazy(() =>
  import("./pages/marketing/PricingPage").then((m) => ({ default: m.PricingPage })),
);
const FaqPage = lazy(() =>
  import("./pages/marketing/FaqPage").then((m) => ({ default: m.FaqPage })),
);
const SetupPage = lazy(() =>
  import("./pages/marketing/SetupPage").then((m) => ({ default: m.SetupPage })),
);
const SupportPage = lazy(() =>
  import("./pages/marketing/SupportPage").then((m) => ({ default: m.SupportPage })),
);
const SecurityPage = lazy(() =>
  import("./pages/marketing/SecurityPage").then((m) => ({ default: m.SecurityPage })),
);
const MobilePage = lazy(() =>
  import("./pages/marketing/MobilePage").then((m) => ({ default: m.MobilePage })),
);
const CommandPage = lazy(() =>
  import("./pages/marketing/CommandPage").then((m) => ({ default: m.CommandPage })),
);
const ControlPage = lazy(() =>
  import("./pages/marketing/ControlPage").then((m) => ({ default: m.ControlPage })),
);
const DevicesPage = lazy(() =>
  import("./pages/marketing/DevicesPage").then((m) => ({ default: m.DevicesPage })),
);
const NotFoundPage = lazy(() =>
  import("./pages/marketing/NotFoundPage").then((m) => ({ default: m.NotFoundPage })),
);
const AiActivityPage = lazy(() =>
  import("./pages/AiActivityPage").then((m) => ({ default: m.AiActivityPage })),
);
const DashboardPage = lazy(() =>
  import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage })),
);
const AnalyticsPage = lazy(() =>
  import("./pages/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })),
);
const LiveControlPage = lazy(() =>
  import("./pages/LiveControlPage").then((m) => ({ default: m.LiveControlPage })),
);

export function App() {
  const { ready, user } = useAuth();

  if (!ready) {
    return <div className="boot">Loading…</div>;
  }

  // Where a signed-in account lands. Platform owners have no agency. Radio-role
  // accounts get the mobile-friendly radio portal as their home instead of the
  // dispatch console; dispatch/admin still land on the console.
  const home =
    user?.role === "owner"
      ? "/owner"
      : user?.role === "radio"
        ? "/radio"
        : "/console";

  return (
    <Suspense fallback={<div className="boot">Loading…</div>}>
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/signup" element={user ? <Navigate to={home} replace /> : <SignupPage />} />
      <Route path="/pricing" element={<PricingPage />} />
      <Route path="/faq" element={<FaqPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/support" element={<SupportPage />} />
      <Route path="/security" element={<SecurityPage />} />
      <Route path="/mobile" element={<MobilePage />} />
      <Route path="/command" element={<CommandPage />} />
      <Route path="/control" element={<ControlPage />} />
      <Route path="/devices" element={<DevicesPage />} />
      <Route path="/login" element={user ? <Navigate to={home} replace /> : <LoginPage />} />
      <Route
        path="/console"
        element={
          !user ? (
            <Navigate to="/login" replace />
          ) : user.role === "owner" ? (
            <Navigate to="/owner" replace />
          ) : user.role === "radio" ? (
            <Navigate to="/radio" replace />
          ) : (
            <ConsolePage />
          )
        }
      />
      <Route
        path="/radio"
        element={
          !user ? (
            <Navigate to="/login" replace />
          ) : user.role === "owner" ? (
            <Navigate to="/owner" replace />
          ) : (
            <RadioPortal />
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
          ) : user.role === "radio" ? (
            <Navigate to="/radio" replace />
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
          ) : user.role === "radio" ? (
            <Navigate to="/radio" replace />
          ) : (
            <ChannelsWindowPage />
          )
        }
      />
      <Route
        path="/console/ai-activity"
        element={
          !user ? (
            <Navigate to="/login" replace />
          ) : user.role === "owner" ? (
            <Navigate to="/owner" replace />
          ) : user.role === "radio" ? (
            <Navigate to="/radio" replace />
          ) : (
            <AiActivityPage />
          )
        }
      />
      <Route
        path="/console/dashboard"
        element={
          !user ? (
            <Navigate to="/login" replace />
          ) : user.role === "owner" ? (
            <Navigate to="/owner" replace />
          ) : user.role === "radio" ? (
            <Navigate to="/radio" replace />
          ) : (
            <DashboardPage />
          )
        }
      />
      <Route
        path="/console/analytics"
        element={
          !user ? (
            <Navigate to="/login" replace />
          ) : user.role === "owner" ? (
            <Navigate to="/owner" replace />
          ) : user.role === "radio" ? (
            <Navigate to="/radio" replace />
          ) : (
            <AnalyticsPage />
          )
        }
      />
      <Route
        path="/console/control"
        element={
          !user ? (
            <Navigate to="/login" replace />
          ) : user.role === "owner" ? (
            <Navigate to="/owner" replace />
          ) : user.role === "radio" ? (
            <Navigate to="/radio" replace />
          ) : (
            <LiveControlPage />
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
          ) : user.role === "radio" ? (
            <Navigate to="/radio" replace />
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
          ) : user.role === "radio" ? (
            <Navigate to="/radio" replace />
          ) : (
            <BridgesPage />
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
          ) : user.role === "radio" ? (
            <Navigate to="/radio" replace />
          ) : (
            <Navigate to="/console" replace />
          )
        }
      />
      <Route path="/updates" element={<UpdatesPage />} />
      <Route path="/legal/terms" element={<LegalPage doc="terms" />} />
      <Route path="/legal/privacy" element={<LegalPage doc="privacy" />} />
      <Route path="/legal/eula" element={<LegalPage doc="eula" />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
    </Suspense>
  );
}
