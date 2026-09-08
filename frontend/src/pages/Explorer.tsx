import { useSearchParams } from "react-router-dom";

import WebhookInbox from "./WebhookInbox";
import AuditLog from "./AuditLog";

const TABS = [
  { key: "webhooks", label: "Webhooks" },
  { key: "audit", label: "Audit log" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const BLURB: Record<TabKey, string> = {
  webhooks:
    "Every webhook Verkada sends this install, captured, classified and signature-checked.",
  audit:
    "Every action in your Verkada org, from Command's audit log, pulled every ten seconds and filterable by anything on it. Insights draws the same slice as a picture.",
};

/**
 * Explorer: what is happening in the org, from two sources. Webhooks
 * are what Verkada pushes; the audit log is what we pull. Both tabs
 * keep their state in the URL so a view can be shared.
 */
export default function Explorer() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  // ?tab=insights predates Insights moving under the Audit log tab.
  const tab: TabKey = TABS.some((t) => t.key === requested)
    ? (requested as TabKey)
    : requested === "insights"
      ? "audit"
      : "webhooks";

  const setTab = (next: TabKey) => {
    const p = new URLSearchParams(searchParams);
    p.set("tab", next);
    // A selected row belongs to one tab.
    p.delete("event");
    setSearchParams(p, { replace: true });
  };

  return (
    <div className="h-full flex flex-col gap-4 min-h-0">
      <div>
        <h1 className="text-2xl font-semibold text-white">Explorer</h1>
        <p className="text-slate-400 text-sm mt-1 max-w-3xl">{BLURB[tab]}</p>
        <div className="mt-4 flex items-center gap-1 border-b border-white/10">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                tab === t.key
                  ? "border-sky-500 text-white"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
              data-testid={`explorer-tab-${t.key}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {tab === "webhooks" && <WebhookInbox />}
        {tab === "audit" && <AuditLog />}
      </div>
    </div>
  );
}
