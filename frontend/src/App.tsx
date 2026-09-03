import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { NavLink, Route, Routes, Navigate } from "react-router-dom";

import AuthGate from "./components/AuthGate";
import OnboardingGate from "./components/OnboardingGate";
import { apiPost } from "./lib/api";
import { useBrand } from "./lib/brand";
import WebhookInbox from "./pages/WebhookInbox";
import UnrecognizedEvents from "./pages/UnrecognizedEvents";
import Flows from "./pages/Flows";
import FlowEditor from "./pages/FlowEditor";
import Connections from "./pages/Connections";
import Runs from "./pages/Runs";
import Mcp from "./pages/Mcp";
import Mqtt from "./pages/Mqtt";
import SettingsPage from "./pages/Settings";
import Stats from "./pages/Stats";
import Templates from "./pages/Templates";
import Workbench from "./pages/Workbench";

// Header + nav use a glass aesthetic so the animated Vanta NET
// background renders through the chrome.
const navItem =
  "px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-white/10";
const navActive = "bg-white/15 text-white";
const navInactive = "text-slate-300";

export default function App() {
  return (
    <AuthGate>
      <OnboardingGate>
        <AppShell />
      </OnboardingGate>
    </AuthGate>
  );
}


function LogoutButton() {
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: () => apiPost("/api/auth/logout", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth-status"] }),
  });
  return (
    <button
      onClick={() => logout.mutate()}
      disabled={logout.isPending}
      className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1 rounded hover:bg-white/10 disabled:opacity-50"
      title="Sign out"
    >
      {logout.isPending ? "Signing out…" : "Sign out"}
    </button>
  );
}

function AppShell() {
  const brand = useBrand();
  // Hover speeds the orbit up. Doing this by swapping animation-duration
  // in CSS makes the particles jump: progress is elapsed % duration, so
  // a new duration maps the same elapsed time to a different point on
  // the path. updatePlaybackRate changes speed while keeping the current
  // position, which is the difference between throttling up and
  // restarting.
  const markRef = useRef<HTMLDivElement>(null);
  const setOrbitRate = (rate: number) => {
    markRef.current?.querySelectorAll(".brand-dot").forEach((el) => {
      for (const anim of el.getAnimations()) {
        if (typeof anim.updatePlaybackRate === "function") {
          anim.updatePlaybackRate(rate);
        } else {
          anim.playbackRate = rate;
        }
      }
    });
  };

  // Keep the tab title in sync with the brand. Cheap to run; useEffect
  // only fires when ``brand`` actually changes.
  useEffect(() => {
    document.title = brand;
  }, [brand]);
  return (
    <div className="h-full flex flex-col">
      <header className="border-b border-white/10 bg-black/40 backdrop-blur-md">
        <div className="w-full px-6 h-14 flex items-center gap-6">
          {/* An atom rather than something orbiting the word: rings at
              three tilts turning at different rates, a particle riding
              each, and a lit core. Compact and self-contained, which is
              what every previous attempt was missing — a track drawn
              around the letters is either too big for the header or too
              tight to read. */}
          <div
            ref={markRef}
            onMouseEnter={() => setOrbitRate(2.6)}
            onMouseLeave={() => setOrbitRate(1)}
            className="brand-mark flex items-center gap-1 font-semibold text-white tracking-tight select-none"
          >
            <svg
              viewBox="0 0 40 40"
              className="brand-atom"
              aria-hidden="true"
              focusable="false"
            >
              <g transform="rotate(0 20 20)">
                <g className="atom-ring atom-ring-a">
                  <ellipse cx="20" cy="20" rx="17" ry="6.5" />
                  <circle className="atom-particle" cx="37" cy="20" r="1.5" />
                </g>
              </g>
              <g transform="rotate(60 20 20)">
                <g className="atom-ring atom-ring-b">
                  <ellipse cx="20" cy="20" rx="17" ry="6.5" />
                  <circle className="atom-particle" cx="37" cy="20" r="1.5" />
                </g>
              </g>
              <g transform="rotate(120 20 20)">
                <g className="atom-ring atom-ring-c">
                  <ellipse cx="20" cy="20" rx="17" ry="6.5" />
                  <circle className="atom-particle" cx="37" cy="20" r="1.5" />
                </g>
              </g>
              <circle className="atom-core" cx="20" cy="20" r="2.4" />
            </svg>
            <span>{brand}</span>
          </div>
          <nav className="flex items-center gap-1">
            <NavLink
              to="/inbox"
              className={({ isActive }) =>
                `${navItem} ${isActive ? navActive : navInactive}`
              }
            >
              Webhook Explorer
            </NavLink>
            <NavLink
              to="/flows"
              className={({ isActive }) =>
                `${navItem} ${isActive ? navActive : navInactive}`
              }
            >
              Flows
            </NavLink>
            <NavLink
              to="/workbench"
              className={({ isActive }) =>
                `${navItem} ${isActive ? navActive : navInactive}`
              }
              title="Workbench — one-shot Gemini test runner; iterate on prompts before wiring them into a flow"
            >
              Workbench
            </NavLink>
            <NavLink
              to="/mqtt"
              className={({ isActive }) =>
                `${navItem} ${isActive ? navActive : navInactive}`
              }
              title="Configure cameras to publish object positions, and watch the stream"
            >
              MQTT
            </NavLink>
            <NavLink
              to="/mcp"
              className={({ isActive }) =>
                `${navItem} ${isActive ? navActive : navInactive}`
              }
              title="MCP — browse the tools a Model Context Protocol server exposes"
            >
              MCP
            </NavLink>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `${navItem} ${isActive ? navActive : navInactive}`
              }
            >
              Settings
            </NavLink>
          </nav>
          <div className="ml-auto">
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="flex-1 min-h-0 w-full max-w-[1600px] mx-auto px-6 py-6">
        <Routes>
          <Route path="/" element={<Navigate to="/inbox" replace />} />
          <Route path="/inbox" element={<WebhookInbox />} />
          <Route path="/unrecognized" element={<UnrecognizedEvents />} />
          <Route path="/flows" element={<Flows />} />
          <Route path="/flows/new" element={<FlowEditor />} />
          <Route path="/flows/:id/edit" element={<FlowEditor />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/catalog" element={<Navigate to="/mcp" replace />} />
          <Route path="/templates" element={<Templates />} />
          {/* Keep /byoa as an alias so existing "Run it back" URLs work. */}
          <Route path="/workbench" element={<Workbench />} />
          <Route path="/byoa" element={<Workbench />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/mqtt" element={<Mqtt />} />
          <Route path="/mcp" element={<Mcp />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
