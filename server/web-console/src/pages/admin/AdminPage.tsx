import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
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
import { Ten8ApiTestPanel } from "./Ten8ApiTestPanel";
import { AudioLabPanel } from "./AudioLabPanel";
import { VoiceLinkPanel } from "./VoiceLinkPanel";
import { BillingPanel } from "./BillingPanel";

type TabId =
  | "billing"
  | "users"
  | "channels"
  | "aliases"
  | "integrations"
  | "knowledge"
  | "ai-test"
  | "audio-lab"
  | "link-health"
  | "downloads"
  | "sounds"
  | "soundboard"
  | "branding"
  | "audit";

const TABS: { id: TabId; label: string }[] = [
  { id: "billing", label: "Billing" },
  { id: "users", label: "Users" },
  { id: "channels", label: "Channels" },
  { id: "aliases", label: "Unit Aliases" },
  { id: "integrations", label: "Integrations" },
  { id: "knowledge", label: "Knowledge Base" },
  { id: "ai-test", label: "AI Test" },
  { id: "audio-lab", label: "Audio Lab" },
  { id: "link-health", label: "Link Health" },
  { id: "downloads", label: "Downloads" },
  { id: "sounds", label: "Sounds" },
  { id: "soundboard", label: "Soundboard" },
  { id: "branding", label: "Branding" },
  { id: "audit", label: "Audit Log" },
];

export function AdminPage() {
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<TabId>("users");

  useEffect(() => {
    if (searchParams.get("billing")) {
      setTab("billing");
    }
  }, [searchParams]);

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
          {tab === "billing" && <BillingPanel />}
          {tab === "users" && <UsersAndAssignmentsPanel />}
          {tab === "channels" && <ChannelsPanel />}
          {tab === "aliases" && <UnitAliasesPanel />}
          {tab === "integrations" && <IntegrationsPanel />}
          {tab === "knowledge" && <KnowledgeBasePanel />}
          {tab === "ai-test" && (
            <>
              <AiTestPanel />
              <Ten8ApiTestPanel />
            </>
          )}
          {tab === "audio-lab" && <AudioLabPanel />}
          {tab === "link-health" && <VoiceLinkPanel />}
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
