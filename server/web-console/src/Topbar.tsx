import { Link } from "react-router-dom";
import { useAuth } from "./auth";
import { ThemeToggle } from "./ThemeToggle";
import { IconRadio, IconShield, IconLogOut, SafetMark } from "./icons";

/** Shared top menu bar with Command / Control navigation tabs. */
export function Topbar({ section }: { section: "console" | "admin" }) {
  const { user, logout } = useAuth();
  return (
    <header className="topbar">
      <div className="brand">
        <SafetMark size={26} />
        <span className="brand-word">
          safe<b>T</b>
        </span>
        <span className="brand-section">{section === "admin" ? "Control" : "Command"}</span>
      </div>
      <nav className="topnav">
        <Link className={section === "console" ? "nav-tab active" : "nav-tab"} to="/console">
          <IconRadio size={15} /> Command
        </Link>
        {user?.role === "admin" && (
          <Link className={section === "admin" ? "nav-tab active" : "nav-tab"} to="/admin">
            <IconShield size={15} /> Control
          </Link>
        )}
      </nav>
      <div className="who">
        <span className="role-chip">{user?.role}</span>
        <span className="who-name">{user?.displayName}</span>
        <ThemeToggle />
        <button className="btn sm icon-btn" onClick={logout}>
          <IconLogOut size={14} /> Sign out
        </button>
      </div>
    </header>
  );
}
