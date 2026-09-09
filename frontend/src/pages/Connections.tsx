import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  Connection,
  ConnectionFieldSpec,
  ConnectionTypeSpec,
} from "../lib/api";
import { useBrand } from "../lib/brand";
import { copyToClipboard } from "../lib/clipboard";
import { PENDING_SIGNING_SECRET_KEY } from "../components/OnboardingGate";

type FormMode =
  | { kind: "create"; type: string }
  | { kind: "finish"; connection: Connection }
  | { kind: "edit"; connection: Connection };

export default function Connections() {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormMode | null>(null);

  const types = useQuery({
    queryKey: ["connection-types"],
    queryFn: () => apiGet<Record<string, ConnectionTypeSpec>>("/api/connections/types"),
  });
  const conns = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiGet<Connection[]>("/api/connections"),
    refetchInterval: 5000,
  });
  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/connections/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connections"] }),
  });

  // Auto-open finish-setup when a pending connection first appears.
  const pending = (conns.data ?? []).filter((c) => !c.setup_complete);
  useEffect(() => {
    if (!form && pending.length > 0) {
      setForm({ kind: "finish", connection: pending[0] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.length]);

  const verkadaConns = (conns.data ?? []).filter((c) => c.type === "verkada");
  const thirdPartyConns = (conns.data ?? []).filter((c) => c.type !== "verkada");
  const verkadaTypeKey = "verkada";
  const thirdPartyTypeKeys = Object.keys(types.data ?? {}).filter(
    (k) => k !== "verkada",
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Connections</h1>
        <p className="text-slate-400 text-sm mt-1">
          Store API keys and webhook signing secrets. Secrets are encrypted at rest with
          your <code className="bg-white/10 px-1 rounded">FERNET_KEY</code> and never
          returned through the API after creation.
        </p>
      </div>

      {/* ---- Verkada orgs ---- */}
      <section className="space-y-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-xs uppercase tracking-wider text-slate-400">
            Verkada orgs
          </h2>
          {types.data?.[verkadaTypeKey] && (
            <button
              onClick={() => setForm({ kind: "create", type: verkadaTypeKey })}
              className="text-xs px-2 py-1 rounded border border-white/15 hover:border-sky-500 hover:bg-white/5 text-slate-200"
            >
              + Add Verkada org
            </button>
          )}
        </div>

        {conns.isLoading ? (
          <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-6 text-sm text-slate-400">
            Loading…
          </div>
        ) : verkadaConns.length === 0 ? (
          <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg">
            <FirstRunState />
          </div>
        ) : (
          <div className="space-y-4">
            {verkadaConns.map((c) => (
              <VerkadaOrgCard
                key={c.id}
                c={c}
                onFinish={() => setForm({ kind: "finish", connection: c })}
                onEdit={() => setForm({ kind: "edit", connection: c })}
                onDelete={() => {
                  if (confirm(`Delete "${c.name}"? This can't be undone.`)) {
                    del.mutate(c.id);
                  }
                }}
              />
            ))}
          </div>
        )}
      </section>

      {/* ---- 3rd-party API keys ---- */}
      <section className="space-y-3">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h2 className="text-xs uppercase tracking-wider text-slate-400">
            3rd-party API keys
          </h2>
          {types.data &&
            thirdPartyTypeKeys.map((k) => (
              <button
                key={k}
                onClick={() => setForm({ kind: "create", type: k })}
                className="text-xs px-2 py-1 rounded border border-white/15 hover:border-sky-500 hover:bg-white/5 text-slate-200"
              >
                + Add {types.data![k].label}
              </button>
            ))}
        </div>

        <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg">
          {thirdPartyConns.length === 0 ? (
            <div className="p-6 text-sm text-slate-400">
              No 3rd-party API keys yet. Add a Gemini key to enable AI analysis actions.
            </div>
          ) : (
            /* No min-width. Three short columns were being held open to
               64rem, so a two-row list scrolled sideways on a screen with
               room to spare. */
            <table className="w-full text-sm">
              <thead className="text-slate-400 text-xs uppercase tracking-wider">
                <tr>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Type</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {thirdPartyConns.map((c) => (
                  <tr key={c.id} className={!c.setup_complete ? "bg-amber-950/30" : ""}>
                    <td className="px-3 py-2 font-medium text-slate-100 whitespace-nowrap">
        {c.name}
      </td>
                    <td className="px-3 py-2">
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-900/60 text-sky-200">
                        {c.type}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge ready={c.setup_complete} />
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {!c.setup_complete && (
                        <button
                          onClick={() => setForm({ kind: "finish", connection: c })}
                          className="text-xs px-2 py-1 rounded bg-sky-700 hover:bg-sky-600 text-white mr-2"
                        >
                          Finish setup
                        </button>
                      )}
                      {c.setup_complete && (c.type === "slack" || c.type === "discord") && (
                        <TestMessageBtn conn={c} />
                      )}
                      <button
                        onClick={() => {
                          if (confirm(`Delete "${c.name}"? This can't be undone.`)) {
                            del.mutate(c.id);
                          }
                        }}
                        className="text-xs px-2 py-1 rounded border border-white/15 text-slate-300 hover:text-rose-300 hover:border-rose-700"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {form && types.data && (
        <ConnectionFormModal
          mode={form}
          spec={
            form.kind === "create"
              ? types.data[form.type]
              : types.data[form.connection.type]
          }
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            qc.invalidateQueries({ queryKey: ["connections"] });
          }}
        />
      )}
    </div>
  );
}


/**
 * One Verkada org, as a card rather than a table row.
 *
 * It was a row, and the row needed 64rem to fit: nine columns and six
 * buttons, so the actions ran off the right edge and had to be scrolled
 * to while three quarters of the page sat empty. Scrolling sideways
 * past a screenful of nothing is the tell that the form is wrong, not
 * the width.
 *
 * A table exists to compare rows. Almost nobody has two Verkada orgs,
 * and the columns here are not being compared against anything — they
 * are the attributes of a single thing. So this is a card, and the
 * layout can follow the shape of the content instead of a grid built
 * for a list that does not exist.
 *
 * The change that matters most is not the width. Each sync button now
 * sits inside the tile showing the count it changes, so "95 cameras,
 * synced an hour ago, sync again" reads as one statement. Before, six
 * identically-styled buttons sat in a row far from the four numbers
 * they affected, and which button moved which number was something you
 * had to already know. Results and failures land in the same tile for
 * the same reason.
 */
function VerkadaOrgCard({
  c,
  onFinish,
  onEdit,
  onDelete,
}: {
  c: Connection;
  onFinish: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const qc = useQueryClient();

  // Per-resource rather than one shared line, so a doors failure cannot
  // appear to be about cameras.
  const [status, setStatus] = useState<
    Record<string, { kind: "ok" | "err"; msg: string } | undefined>
  >({});
  const [poiCount, setPoiCount] = useState<number | null>(null);

  // Strip the api wrapper's `METHOD /path → STATUS:` prefix so what is
  // surfaced is the server's actual reason.
  const cleanErr = (e: Error): string => {
    const m = e.message.match(/→\s*\d+\s*:\s*(.+)$/);
    return m ? m[1] : e.message;
  };
  const set = (key: string, kind: "ok" | "err", msg: string) =>
    setStatus((s) => ({ ...s, [key]: { kind, msg } }));
  const clear = (key: string) =>
    setStatus((s) => ({ ...s, [key]: undefined }));

  // The per-door "Door Management via API" toggle is a second gotcha,
  // separate from listing the doors at all. People hit the first and
  // forget the second, so it rides along with every doors result.
  const DOOR_NOTE =
    'Each door also needs "Door Management via API" enabled in its ' +
    "Command settings before it can be unlocked.";

  const syncCameras = useMutation({
    mutationFn: () =>
      apiPost<{ count: number }>(`/api/connections/${c.id}/sync-cameras`, {}),
    onMutate: () => clear("cameras"),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["connections"] });
      qc.invalidateQueries({ queryKey: ["verkada-cameras"] });
      set("cameras", "ok", `${d.count} synced`);
    },
    onError: (e: Error) => set("cameras", "err", cleanErr(e)),
  });
  const syncDoors = useMutation({
    mutationFn: () =>
      apiPost<{ count: number }>(`/api/connections/${c.id}/sync-doors`, {}),
    onMutate: () => clear("doors"),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["connections"] });
      qc.invalidateQueries({ queryKey: ["verkada-doors"] });
      set("doors", "ok", `${d.count} synced. ${DOOR_NOTE}`);
    },
    onError: (e: Error) => set("doors", "err", `${cleanErr(e)} ${DOOR_NOTE}`),
  });
  const syncHelix = useMutation({
    mutationFn: () =>
      apiPost<{ count: number }>(`/api/connections/${c.id}/sync-helix`, {}),
    onMutate: () => clear("helix"),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["connections"] });
      qc.invalidateQueries({ queryKey: ["helix-event-types"] });
      set("helix", "ok", `${d.count} synced`);
    },
    onError: (e: Error) => set("helix", "err", cleanErr(e)),
  });
  const syncScenarios = useMutation({
    mutationFn: () =>
      apiPost<{ count: number }>(`/api/connections/${c.id}/sync-scenarios`, {}),
    onMutate: () => clear("scenarios"),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["connections"] });
      qc.invalidateQueries({ queryKey: ["verkada-scenarios"] });
      set("scenarios", "ok", `${d.count} synced`);
    },
    onError: (e: Error) => set("scenarios", "err", cleanErr(e)),
  });
  // People of interest live in a JSON cache rather than a table, so
  // there is no column for them and the count only exists after a sync.
  const syncPoi = useMutation({
    mutationFn: () =>
      apiPost<{ count: number }>(`/api/connections/${c.id}/sync-poi`, {}),
    onMutate: () => clear("poi"),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["filter-fields"] });
      setPoiCount(d.count);
      set("poi", "ok", `${d.count} synced`);
    },
    onError: (e: Error) => set("poi", "err", cleanErr(e)),
  });

  // A probe, not a sync: it pulls a real live frame and a real historical
  // clip from an online camera and reports which streaming tier the key
  // actually has. Offline cameras fail for reasons that have nothing to
  // do with the key, so the backend only picks from ones Verkada reports
  // as online.
  const [streaming, setStreaming] = useState<{
    camera_id: string;
    camera_name: string | null;
    camera_status: string | null;
    live: { ok: boolean; error?: string };
    historical: { ok: boolean; error?: string };
    tier: string;
  } | null>(null);
  const testStreaming = useMutation({
    mutationFn: () =>
      apiPost<NonNullable<typeof streaming>>(
        `/api/connections/${c.id}/test-streaming`,
        {},
      ),
    onMutate: () => {
      clear("streaming");
      setStreaming(null);
    },
    onSuccess: (d) => setStreaming(d),
    onError: (e: Error) => set("streaming", "err", cleanErr(e)),
  });

  const resources = [
    {
      key: "cameras",
      label: "Cameras",
      count: c.camera_count,
      ts: c.cameras_last_synced_at,
      pending: syncCameras.isPending,
      run: () => syncCameras.mutate(),
      title: "Pull camera names from the Verkada API",
    },
    {
      key: "doors",
      label: "Doors",
      count: c.door_count,
      ts: c.doors_last_synced_at,
      pending: syncDoors.isPending,
      run: () => syncDoors.mutate(),
      title: "Pull door names from /access/v1/doors",
    },
    {
      key: "helix",
      label: "Helix events",
      count: c.helix_event_count,
      ts: c.helix_events_last_synced_at,
      pending: syncHelix.isPending,
      run: () => syncHelix.mutate(),
      title: "Pull Helix event types from /cameras/v1/video_tagging/event_type",
    },
    {
      key: "scenarios",
      label: "Scenarios",
      count: c.scenario_count,
      ts: c.scenarios_last_synced_at,
      pending: syncScenarios.isPending,
      run: () => syncScenarios.mutate(),
      title: "Pull Access scenarios from /access/v1/scenarios",
    },
    {
      key: "poi",
      label: "People of interest",
      count: poiCount,
      ts: null,
      pending: syncPoi.isPending,
      run: () => syncPoi.mutate(),
      title:
        "Pull people of interest so they can be picked as trigger filters before they are ever seen on camera",
    },
  ];

  return (
    <div
      className={`backdrop-blur-sm border rounded-lg overflow-hidden ${
        c.setup_complete
          ? "bg-white/5 border-white/15"
          : "bg-amber-950/30 border-amber-800/50"
      }`}
    >
      {/* Identity */}
      <div className="flex items-start gap-4 flex-wrap p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-white truncate">
              {c.name}
            </h3>
            <StatusBadge ready={c.setup_complete} />
          </div>
          <div className="flex items-center gap-x-4 gap-y-1 flex-wrap mt-1.5 text-xs text-slate-500">
            <span className="font-mono" title="Verkada organization ID">
              {c.external_id ?? "no org id yet"}
            </span>
            <span
              className="font-mono"
              title="Last characters of the stored key — enough to tell which key a 403 belongs to, not enough to use"
            >
              key {c.api_key_hint ?? "—"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!c.setup_complete && (
            <button
              onClick={onFinish}
              className="text-xs px-2.5 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white transition-colors"
            >
              Finish setup
            </button>
          )}
          <button
            onClick={onEdit}
            className="text-xs px-2.5 py-1.5 rounded border border-white/15 text-slate-300 hover:text-white hover:border-white/30 transition-colors"
            title="Edit name, API key, or signing secret"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            className="text-xs px-2.5 py-1.5 rounded border border-white/15 text-slate-300 hover:text-rose-300 hover:border-rose-700 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>

      {c.setup_complete && (
        <>
          {/* What has been pulled from Command, and the button that pulls it */}
          <div className="border-t border-white/10 p-4">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-3">
              Synced from Command
            </div>
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
              {resources.map((r) => (
                <ResourceTile
                  key={r.key}
                  label={r.label}
                  count={r.count}
                  ts={r.ts}
                  pending={r.pending}
                  onSync={r.run}
                  title={r.title}
                  status={status[r.key]}
                />
              ))}
            </div>
          </div>

          {/* The streaming probe: not a sync, so not in the grid */}
          <div className="border-t border-white/10 p-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wider text-slate-500">
                  Streaming permissions
                </div>
                <p className="text-xs text-slate-400 mt-1 max-w-prose">
                  Pulls a real live frame and a real historical clip from an
                  online camera, so the answer is what your key can actually
                  do rather than what the scope list claims.
                </p>
              </div>
              <SyncBtn
                label="Test streaming"
                pending={testStreaming.isPending}
                onClick={() => testStreaming.mutate()}
                title="Probe Streaming - Live and Streaming - Live/Historical via a real HLS pull"
              />
            </div>

            {status.streaming?.kind === "err" && (
              <div className="text-[11px] text-rose-300 mt-2 break-words">
                ✗ {status.streaming.msg}
              </div>
            )}
            {streaming && (
              <div className="text-[11px] mt-2 space-y-0.5 break-words">
                <div
                  className={
                    streaming.tier === "None"
                      ? "text-rose-300"
                      : "text-emerald-300"
                  }
                >
                  {streaming.tier === "None" ? "✗" : "✓"} {streaming.tier}
                  {streaming.camera_name && (
                    <span className="text-slate-500">
                      {" "}· tested via {streaming.camera_name}
                      {streaming.camera_status
                        ? ` (${streaming.camera_status})`
                        : ""}
                    </span>
                  )}
                </div>
                {!streaming.live.ok && streaming.live.error && (
                  <div className="text-rose-300/90">
                    Live: {streaming.live.error}
                  </div>
                )}
                {!streaming.historical.ok && streaming.historical.error && (
                  <div className="text-rose-300/90">
                    Historical: {streaming.historical.error}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}


/** How long ago, in the resolution a person would say it in. */
function since(ts: string | null): string {
  if (!ts) return "never synced";
  const secs = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (secs < 90) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}


/**
 * One count, when it was last pulled, and the button that pulls it.
 *
 * Keeping those three together is the entire point of the rewrite. A
 * count with no action beside it is trivia, and an action with no count
 * beside it is a guess about what it will do.
 */
function ResourceTile({
  label,
  count,
  ts,
  pending,
  onSync,
  title,
  status,
}: {
  label: string;
  count: number | null;
  ts: string | null;
  pending: boolean;
  onSync: () => void;
  title?: string;
  status?: { kind: "ok" | "err"; msg: string };
}) {
  return (
    <div className="bg-black/20 border border-white/10 rounded-md p-3 flex flex-col gap-2">
      <div>
        <div className="text-xl font-semibold text-white tabular-nums leading-none">
          {count === null ? (
            <span className="text-slate-600">—</span>
          ) : count === 0 ? (
            <span className="text-slate-600">0</span>
          ) : (
            count
          )}
        </div>
        <div className="text-xs text-slate-300 mt-1.5">{label}</div>
        <div className="text-[10px] text-slate-500 mt-0.5">{since(ts)}</div>
      </div>
      <button
        type="button"
        onClick={onSync}
        disabled={pending}
        title={title}
        className="mt-auto text-[11px] px-2 py-1 rounded border border-white/15 text-slate-300 hover:text-white hover:border-sky-500 hover:bg-white/5 disabled:opacity-50 transition-colors"
      >
        {pending ? "Syncing…" : "Sync"}
      </button>
      {status && (
        <div
          className={`text-[10px] leading-snug break-words ${
            status.kind === "err" ? "text-rose-300" : "text-emerald-300"
          }`}
          title={status.msg}
        >
          {status.kind === "err" ? "✗ " : "✓ "}
          {status.msg}
        </div>
      )}
    </div>
  );
}


function SyncBtn({
  label,
  pending,
  onClick,
  title,
}: {
  label: string;
  pending: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      title={title}
      className="text-xs px-2 py-1 rounded border border-white/15 hover:border-sky-500 hover:bg-white/5 disabled:opacity-50"
    >
      {pending ? "Syncing…" : label}
    </button>
  );
}


function StatusBadge({ ready }: { ready: boolean }) {
  return ready ? (
    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-200">
      ready
    </span>
  ) : (
    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-200">
      needs api key
    </span>
  );
}


function FirstRunState() {
  const brand = useBrand();
  return (
    <div className="p-6 text-sm text-slate-300 space-y-2">
      <p className="font-medium text-slate-100">No Verkada orgs connected yet.</p>
      <p>
        Point a Verkada webhook at this server (
        <code className="bg-white/10 px-1 rounded text-xs">/hooks/&lt;anything&gt;</code>
        ) and {brand} will auto-detect your org and prompt you to finish setup
        with just an API key.
      </p>
      <p>
        Or click <strong className="text-slate-100">+ Add Verkada org</strong> above to
        enter everything manually.
      </p>
    </div>
  );
}


function ConnectionFormModal({
  mode,
  spec,
  onClose,
  onSaved,
}: {
  mode: FormMode;
  spec: ConnectionTypeSpec;
  onClose: () => void;
  onSaved: () => void;
}) {
  const brand = useBrand();
  // "finish" = auto-detected stub from an inbound webhook, user fills
  //   in API key / signing secret.
  // "edit"   = existing complete connection, user updates fields.
  // Both PUT to the same endpoint and treat blank secret fields as
  // "keep existing" so users can re-open without re-entering keys.
  const isExisting = mode.kind === "finish" || mode.kind === "edit";
  const isFinish = mode.kind === "finish";
  const isEdit = mode.kind === "edit";
  const conn = isExisting ? mode.connection : null;

  const [name, setName] = useState(conn?.name ?? "");
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    if (conn?.external_id && spec.external_id_field) {
      initial[spec.external_id_field] = conn.external_id;
    }
    // If the user generated a signing secret during onboarding, the
    // OnboardingGate stashed it here. Prefill so they don't have to
    // re-generate / re-paste — the value they pasted into Verkada
    // Command's Shared secret is the same one we'll store. Only seed
    // when we're finishing an auto-detected connection (the canonical
    // post-onboarding moment); ignore for create / edit flows where
    // the user is being intentional about field contents.
    if (isFinish && spec.fields.some((f) => f.name === "webhook_signing_secret")) {
      const stored = window.localStorage.getItem(PENDING_SIGNING_SECRET_KEY);
      if (stored) initial.webhook_signing_secret = stored;
    }
    return initial;
  });
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      if (isExisting && conn) {
        const secret: Record<string, string> = {};
        for (const [k, v] of Object.entries(values)) {
          if (v) secret[k] = v;
        }
        return apiPut<Connection>(`/api/connections/${conn.id}`, {
          name,
          secret,
        });
      }
      return apiPost<Connection>("/api/connections", {
        type: mode.kind === "create" ? mode.type : "verkada",
        name,
        secret: values,
      });
    },
    onSuccess: () => {
      // Whichever path saved a signing secret, the onboarding stash
      // has served its purpose. Clear it so a future fresh-install
      // user doesn't inherit it.
      window.localStorage.removeItem(PENDING_SIGNING_SECRET_KEY);
      onSaved();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const title = isFinish
    ? `Finish setting up ${spec.label}`
    : isEdit
      ? `Edit ${spec.label}`
      : `Add ${spec.label}`;
  const description = isFinish
    ? `${brand} detected a new Verkada org from an incoming webhook. Add your API key to enable flow actions. Everything else is optional.`
    : isEdit
      ? "Update any field below. Secret fields left blank keep their existing value — only fill them if you're rotating the API key or signing secret."
      : spec.description;

  // In finish mode the external_id is locked (auto-filled from the
  // webhook). In edit mode it's also locked — you can't repoint an
  // existing connection at a different org without recreating. In
  // create mode the user types it.
  const visibleFields = spec.fields.filter(
    (f) => !isExisting || f.name !== spec.external_id_field,
  );

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
      <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-lg w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div>
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <p className="text-sm text-slate-300 mt-1">{description}</p>
        </div>

        {isExisting && conn?.external_id && (
          <Field label="Verkada Org ID" help={isFinish ? "Detected from your incoming webhook." : "Org ID can't be changed once a connection exists — delete and recreate to repoint."}>
            <input
              value={conn.external_id}
              readOnly
              className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/10 text-slate-400 text-sm font-mono cursor-not-allowed"
            />
          </Field>
        )}

        <Field
          label="Friendly name"
          help="How this connection shows up in the UI."
          required
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 focus:outline-none focus:border-sky-500 text-sm"
            placeholder="e.g. Home org"
          />
        </Field>

        {visibleFields.map((f) => (
          <Field key={f.name} label={f.label} help={f.help} required={f.required}>
            {f.type === "select" ? (
              <SelectInput
                spec={f}
                value={values[f.name] ?? ""}
                onChange={(next) =>
                  setValues((v) => ({ ...v, [f.name]: next }))
                }
              />
            ) : (
              <SecretInput
                spec={f}
                value={values[f.name] ?? ""}
                onChange={(next) =>
                  setValues((v) => ({ ...v, [f.name]: next }))
                }
                isFinish={isExisting}
              />
            )}
          </Field>
        ))}

        {err && (
          <div className="text-sm text-rose-300 bg-rose-950/50 border border-rose-900 rounded px-3 py-2">
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md border border-white/15 text-sm text-slate-200"
          >
            {isFinish ? "Later" : "Cancel"}
          </button>
          <button
            onClick={() => {
              setErr(null);
              if (!name.trim()) {
                setErr("Friendly name is required.");
                return;
              }
              // Don't enforce required_for_setup at the form level —
              // the backend leaves setup_complete=false when the key
              // is missing, which keeps the pending-setup banner up
              // as a reminder. Users can save partial state (e.g. the
              // signing secret first, API key later).
              save.mutate();
            }}
            disabled={save.isPending}
            className="px-3 py-1.5 rounded-md bg-sky-700 hover:bg-sky-600 text-sm disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : isEdit ? "Save changes" : isFinish ? "Save" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}


/**
 * Renders any connection field (text / secret) plus, when the spec
 * carries ``generate: true``, an inline pair of buttons:
 *
 *   - **Generate** — fills the field with 48 random bytes encoded as
 *     URL-safe base64 (~64 chars). Cryptographically secure via
 *     ``crypto.getRandomValues``.
 *   - **Copy** — shows up only once the field has a value, since the
 *     whole point is to paste the same string into Verkada Command.
 *
 * The field briefly switches from password mask to plain text right
 * after generation so the user can see what they're about to copy. It
 * masks again as soon as they click away.
 */
function SecretInput({
  spec,
  value,
  onChange,
  isFinish,
}: {
  spec: ConnectionFieldSpec;
  value: string;
  onChange: (next: string) => void;
  isFinish: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const generate = () => {
    const bytes = new Uint8Array(48);
    crypto.getRandomValues(bytes);
    // URL-safe base64 without padding: matches token_urlsafe-style.
    let b64 = btoa(String.fromCharCode(...bytes));
    b64 = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    onChange(b64);
    setRevealed(true);
  };

  const copy = async () => {
    await copyToClipboard(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const isSecret = spec.type === "secret";
  const inputType = isSecret && !revealed ? "password" : "text";

  return (
    <div className="flex items-center gap-2">
      <input
        type={inputType}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setRevealed(false)}
        className="flex-1 px-2 py-1.5 rounded bg-white/5 border border-white/15 focus:outline-none focus:border-sky-500 text-sm font-mono"
        autoComplete={isSecret ? "new-password" : "off"}
        // Tell password managers not to treat this as a login form —
        // the secret field flips between password / text on reveal, and
        // 1Password / LastPass otherwise interpret a subsequent button
        // click (e.g. "Sync cameras") as a credential save event and
        // pop their "Save login?" prompt.
        data-1p-ignore="true"
        data-lpignore="true"
        data-form-type="other"
        placeholder={isFinish && isSecret ? "leave blank to keep existing" : undefined}
      />
      {spec.generate && (
        <>
          <button
            type="button"
            onClick={generate}
            className="shrink-0 text-xs px-2 py-1.5 rounded border border-white/15 text-slate-200 hover:bg-white/10"
            title="Generate a new random secret"
          >
            Generate
          </button>
          {value && (
            <button
              type="button"
              onClick={copy}
              className="shrink-0 text-xs px-2 py-1.5 rounded border border-white/15 text-slate-200 hover:bg-white/10"
              title="Copy to clipboard so you can paste into Verkada Command"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </>
      )}
    </div>
  );
}


/**
 * Dropdown rendering for `select`-type connection fields. The current
 * (and only) consumer is Verkada's region field, but the component is
 * generic so future enum-y fields can reuse it.
 *
 * Legacy-value handling: pre-dropdown installs let users type any
 * hostname into the region field (e.g. ``api.eu.verkada.com`` without
 * the scheme). If the stored value doesn't match any canonical option
 * exactly, we prepend it as an extra "Custom (legacy): <value>" option
 * so we don't silently drop the stored setting on first form load —
 * the user can re-pick a canonical region from the dropdown if they
 * want to migrate, but their existing config keeps working until they
 * do. ``normalize_base_url()`` in the backend client handles the bare-
 * hostname case at runtime, so even legacy values still route
 * correctly while showing in the form.
 */
function SelectInput({
  spec,
  value,
  onChange,
}: {
  spec: ConnectionFieldSpec;
  value: string;
  onChange: (next: string) => void;
}) {
  const options = spec.options ?? [];
  const matchesCanonical = options.some((o) => o.value === value);
  const showLegacy = !!value && !matchesCanonical;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 focus:outline-none focus:border-sky-500 text-sm"
    >
      {showLegacy && (
        <option value={value}>{`Custom (legacy): ${value}`}</option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}


function Field({
  label,
  help,
  required,
  children,
}: {
  label: string;
  help?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-slate-300 mb-1">
        {label}
        {required && <span className="text-rose-400 ml-1">*</span>}
      </div>
      {children}
      {help && (
        <div className="text-xs text-slate-500 mt-1">{renderHelpWithLinks(help)}</div>
      )}
    </label>
  );
}


// Auto-linkify ``https://...`` URLs in field help text so the
// OpenWeatherMap / Gemini AI Studio sign-up links the connection
// specs reference are clickable. Anything that isn't a URL renders as
// plain text — kept inside the same parent so styling cascades cleanly.
const URL_RE = /(https?:\/\/[^\s]+)/g;

function renderHelpWithLinks(text: string): React.ReactNode {
  const parts = text.split(URL_RE);
  return parts.map((part, i) => {
    if (URL_RE.test(part)) {
      // .test() leaves lastIndex on the regex; reset so subsequent
      // .test() / .split() calls behave predictably.
      URL_RE.lastIndex = 0;
      // Drop a trailing punctuation char (period, comma, paren, etc.)
      // that the URL_RE greedy match likely swallowed.
      const trailing = part.match(/[.,;:!?)\]]+$/);
      const url = trailing ? part.slice(0, part.length - trailing[0].length) : part;
      const tail = trailing ? trailing[0] : "";
      return (
        <span key={i}>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-sky-400 hover:underline"
          >
            {url}
          </a>
          {tail}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}


/**
 * Post one message to a chat webhook, from the row that holds it.
 *
 * A webhook URL that has been revoked and one with a typo in it are the
 * same string of characters to look at, and both fail identically: the
 * flow runs, reports success at every step it can see, and nothing
 * arrives. Sending a real message is the only way to know, and the
 * moment it is pasted is the cheapest time to find out.
 */
function TestMessageBtn({ conn }: { conn: Connection }) {
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const send = useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>(`/api/connections/${conn.id}/test-message`, {}),
    onSuccess: () => {
      setResult({ ok: true, msg: "sent — check the channel" });
      window.setTimeout(() => setResult(null), 6000);
    },
    onError: (e: Error) => setResult({ ok: false, msg: e.message }),
  });
  return (
    <>
      {result && (
        <span
          className={`mr-2 text-[11px] ${result.ok ? "text-emerald-300" : "text-rose-300"}`}
          title={result.msg}
        >
          {result.ok ? "✓ " : "✗ "}
          {result.msg.length > 70 ? result.msg.slice(0, 67) + "…" : result.msg}
        </span>
      )}
      <button
        onClick={() => {
          setResult(null);
          send.mutate();
        }}
        disabled={send.isPending}
        className="text-xs px-2 py-1 rounded border border-white/15 text-slate-300 hover:text-sky-200 hover:border-sky-700 mr-2 disabled:opacity-50"
        title="Post a short message to the channel this webhook points at"
      >
        {send.isPending ? "Sending…" : "Send test"}
      </button>
    </>
  );
}
