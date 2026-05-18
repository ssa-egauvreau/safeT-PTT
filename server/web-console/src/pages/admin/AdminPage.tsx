import { useState } from "react";
import { Topbar } from "../../Topbar";
import { AccountsPanel } from "./AccountsPanel";
import { ChannelsPanel } from "./ChannelsPanel";
import { AssignmentsPanel } from "./AssignmentsPanel";
import { UnitAliasesPanel } from "./UnitAliasesPanel";
import { SoundsPanel } from "./SoundsPanel";
import { BrandingPanel } from "./BrandingPanel";
import { BridgesPanel } from "./BridgesPanel";
import { AuditPanel } from "./AuditPanel";

type TabId =
  | "accounts"
  | "channels"
  | "assignments"
  | "aliases"
  | "sounds"
  | "branding"
  | "bridges"
  | "audit";

const TABS: { id: TabId; label: string }[] = [
  { id: "accounts", label: "Accounts" },
  { id: "channels", label: "Channels" },
  { id: "assignments", label: "Assignments" },
  { id: "aliases", label: "Unit Aliases" },
  { id: "sounds", label: "Sounds" },
  { id: "branding", label: "Branding" },
  { id: "bridges", label: "Radio Bridges" },
  { id: "audit", label: "Audit Log" },
];

export function AdminPage() {
  const [tab, setTab] = useState<TabId>("accounts");

  return (
    <div className="app-shell">
      <Topbar section="admin" />

      <div className="admin-body">
        <aside className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={t.id === tab ? "tab active" : "tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </aside>
        <main className="panel">
          {tab === "accounts" && <AccountsPanel />}
          {tab === "channels" && <ChannelsPanel />}
          {tab === "assignments" && <AssignmentsPanel />}
          {tab === "aliases" && <UnitAliasesPanel />}
          {tab === "sounds" && <SoundsPanel />}
          {tab === "branding" && <BrandingPanel />}
          {tab === "bridges" && <BridgesPanel />}
          {tab === "audit" && <AuditPanel />}
        </main>
      </div>
    </div>
  );
}
