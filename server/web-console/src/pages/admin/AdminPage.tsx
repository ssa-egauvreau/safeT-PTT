import { useState } from "react";
import { Topbar } from "../../Topbar";
import { AccountsPanel } from "./AccountsPanel";
import { ChannelsPanel } from "./ChannelsPanel";
import { AssignmentsPanel } from "./AssignmentsPanel";
import { UnitAliasesPanel } from "./UnitAliasesPanel";
import { AuditPanel } from "./AuditPanel";

type TabId = "accounts" | "channels" | "assignments" | "aliases" | "audit";

const TABS: { id: TabId; label: string }[] = [
  { id: "accounts", label: "Accounts" },
  { id: "channels", label: "Channels" },
  { id: "assignments", label: "Assignments" },
  { id: "aliases", label: "Unit Aliases" },
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
          {tab === "audit" && <AuditPanel />}
        </main>
      </div>
    </div>
  );
}
