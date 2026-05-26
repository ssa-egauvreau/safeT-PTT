import { useState } from "react";
import { Topbar } from "../../Topbar";
import { ChannelsPanel } from "./ChannelsPanel";
import { UsersAndAssignmentsPanel } from "./UsersAndAssignmentsPanel";
import { UnitAliasesPanel } from "./UnitAliasesPanel";
import { SoundsPanel } from "./SoundsPanel";
import { ToneOutsPanel } from "./ToneOutsPanel";
import { BrandingPanel } from "./BrandingPanel";
import { AuditPanel } from "./AuditPanel";
import { IntegrationsPanel } from "./IntegrationsPanel";
import { KnowledgeBasePanel } from "./KnowledgeBasePanel";
import { DownloadsPanel } from "./DownloadsPanel";
import { AiTestPanel } from "./AiTestPanel";
import { AudioLabPanel } from "./AudioLabPanel";

type TabId =
  | "users"
  | "channels"
  | "aliases"
  | "integrations"
  | "knowledge"
  | "ai-test"
  | "audio-lab"
  | "downloads"
  | "sounds"
  | "soundboard"
  | "branding"
  | "audit";

const TABS: { id: TabId; label: string }[] = [
  { id: "users", label: "Users" },
  { id: "channels", label: "Channels" },
  { id: "aliases", label: "Unit Aliases" },
  { id: "integrations", label: "Integrations" },
  { id: "knowledge", label: "Knowledge Base" },
  { id: "ai-test", label: "AI Test" },
  { id: "audio-lab", label: "Audio Lab" },
  { id: "downloads", label: "Downloads" },
  { id: "sounds", label: "Sounds" },
  { id: "soundboard", label: "Soundboard" },
  { id: "branding", label: "Branding" },
  { id: "audit", label: "Audit Log" },
];

export function AdminPage() {
  const [tab, setTab] = useState<TabId>("users");

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
          {tab === "users" && <UsersAndAssignmentsPanel />}
          {tab === "channels" && <ChannelsPanel />}
          {tab === "aliases" && <UnitAliasesPanel />}
          {tab === "integrations" && <IntegrationsPanel />}
          {tab === "knowledge" && <KnowledgeBasePanel />}
          {tab === "ai-test" && <AiTestPanel />}
          {tab === "audio-lab" && <AudioLabPanel />}
          {tab === "downloads" && <DownloadsPanel />}
          {tab === "sounds" && <SoundsPanel />}
          {tab === "soundboard" && <ToneOutsPanel />}
          {tab === "branding" && <BrandingPanel />}
          {tab === "audit" && <AuditPanel />}
        </main>
      </div>
    </div>
  );
}
