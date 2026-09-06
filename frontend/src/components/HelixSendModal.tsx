import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import CameraIdInput from "./CameraIdInput";
import EpochInput from "./EpochInput";
import { apiPost } from "../lib/api";

type SendResult = {
  ok: boolean;
  status_code: number;
  body?: unknown;
  sent: Record<string, unknown>;
  time_ms: number;
};

type FieldProblem = {
  attribute: string;
  expected: string;
  got: string;
  message: string;
};

/** What a value has to look like for the type the schema declares.
 *
 *  Checked as you type rather than only on send. Helix answers a bad
 *  payload with one message about the whole request, so a five-attribute
 *  event with one mistyped value tells you only that something was
 *  wrong — and you find that out after a round trip. */
function localProblem(value: string, type: string): string | null {
  const t = (type || "string").toLowerCase();
  if (!value.trim()) return null; // empty is "not filled", not "wrong"
  if (t === "integer") {
    if (!/^-?\d+$/.test(value.trim())) {
      return Number.isFinite(Number(value))
        ? "whole numbers only — this has a decimal point"
        : "must be a whole number";
    }
    return null;
  }
  if (t === "float") {
    return Number.isFinite(Number(value.trim())) ? null : "must be a number";
  }
  if (value.length > 200) {
    return `Helix truncates at 200 characters — this is ${value.length}`;
  }
  return null;
}

/**
 * Post one event to a Helix type by hand.
 *
 * Everything else that writes to Helix goes through a flow, so the only
 * way to find out whether a type accepts what you think it accepts was
 * to build an automation and wait for it to fire. This is the same POST
 * the ``verkada_helix_event`` action makes, minus the flow.
 *
 * The org API key never reaches here: the backend takes a connection id,
 * exchanges it for a token and sends the request.
 */
export default function HelixSendModal({
  connId,
  eventTypeUid,
  typeName,
  schema,
  onClose,
}: {
  connId: string;
  eventTypeUid: string;
  typeName: string;
  schema: Record<string, string>;
  onClose: () => void;
}) {
  const attrs = useMemo(() => Object.entries(schema), [schema]);
  const [cameraId, setCameraId] = useState("");
  // Milliseconds: the field is time_ms, and getting that wrong is a
  // thousandfold error that lands the event in 1970.
  const [epochMs, setEpochMs] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<SendResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [serverProblems, setServerProblems] = useState<FieldProblem[]>([]);

  const problems = attrs
    .map(([key, type]) => ({ key, msg: localProblem(values[key] ?? "", type) }))
    .filter((p) => p.msg);

  const send = useMutation({
    mutationFn: () =>
      apiPost<SendResult>("/api/helix-send", {
        connection_id: connId,
        event_type_uid: eventTypeUid,
        camera_id: cameraId,
        time_ms: epochMs.trim() ? Number(epochMs) : null,
        attributes: Object.fromEntries(
          attrs.map(([k]) => [k, values[k] ?? ""]),
        ),
      }),
    onSuccess: (res) => {
      setErr(null);
      setServerProblems([]);
      setResult(res);
    },
    onError: (e: Error) => {
      setResult(null);
      // The 422 carries per-field detail. Surfacing only e.message here
      // would throw away the part that says which attribute.
      try {
        const parsed = JSON.parse(e.message);
        if (parsed?.fields) {
          setServerProblems(parsed.fields as FieldProblem[]);
          setErr(parsed.message ?? "Some attributes do not match the type.");
          return;
        }
      } catch {
        /* not JSON — fall through to the plain message */
      }
      setServerProblems([]);
      setErr(e.message);
    },
  });

  const serverFor = (key: string) =>
    serverProblems.find((p) => p.attribute === key)?.message;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-12 px-4"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-white/15 rounded-xl w-full max-w-xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Send an event</h2>
            <div className="text-xs text-slate-500 mt-0.5">{typeName}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-2 py-1 rounded text-slate-400 hover:text-slate-200"
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          <div>
            <div className="text-xs font-medium text-slate-300 mb-1">
              Camera <span className="text-rose-400">*</span>
            </div>
            <CameraIdInput value={cameraId} onChange={setCameraId} />
            <div className="text-[11px] text-slate-500 mt-1">
              The event lands on this camera's timeline in Command.
            </div>
          </div>

          <div>
            <div className="text-xs font-medium text-slate-300 mb-1">
              Event time
            </div>
            <EpochInput value={epochMs} onChange={setEpochMs} milliseconds />
            <div className="text-[11px] text-slate-500 mt-1">
              Leave blank for now. Pick a time the camera has footage for, or
              the event lands on an empty stretch of timeline.
            </div>
          </div>

          <div>
            <div className="text-xs font-medium text-slate-300 mb-2">
              Attributes
            </div>
            {attrs.length === 0 && (
              <div className="text-[11px] text-slate-500">
                This type has no attributes — the event will carry only a
                camera and a time.
              </div>
            )}
            <div className="space-y-2.5">
              {attrs.map(([key, type]) => {
                const local = localProblem(values[key] ?? "", type);
                const server = serverFor(key);
                const bad = local ?? server;
                return (
                  <div key={key}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[11px] font-mono text-slate-300">
                        {key}
                      </span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded border ${
                          type === "string"
                            ? "border-white/15 text-slate-400"
                            : "border-sky-500/30 text-sky-300 bg-sky-500/10"
                        }`}
                      >
                        {type}
                      </span>
                    </div>
                    <input
                      value={values[key] ?? ""}
                      onChange={(e) => {
                        setValues((v) => ({ ...v, [key]: e.target.value }));
                        // The server's complaint is about what was
                        // sent, so it stops applying the moment the
                        // field is edited.
                        if (server)
                          setServerProblems((p) =>
                            p.filter((x) => x.attribute !== key),
                          );
                      }}
                      placeholder={
                        type === "integer"
                          ? "e.g. 42"
                          : type === "float"
                            ? "e.g. 64.5"
                            : "text"
                      }
                      className={`w-full px-2.5 py-1.5 rounded bg-white/5 border text-sm ${
                        bad
                          ? "border-amber-500/60 focus:border-amber-400"
                          : "border-white/15 focus:border-sky-600"
                      } focus:outline-none`}
                    />
                    {bad && (
                      <div className="text-[11px] text-amber-300 mt-1">
                        {bad}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="text-[11px] text-slate-500 mt-2">
              Blank attributes are left out of the request rather than sent
              empty, so an unfilled field can't fail validation.
            </div>
          </div>

          {err && (
            <div className="text-sm text-rose-300 bg-rose-950/50 border border-rose-900 rounded px-3 py-2">
              {err}
            </div>
          )}

          {result && (
            <div
              className={`rounded px-3 py-2 text-sm border ${
                result.ok
                  ? "text-emerald-200 bg-emerald-950/40 border-emerald-900"
                  : "text-rose-200 bg-rose-950/50 border-rose-900"
              }`}
            >
              <div className="font-medium">
                {result.ok
                  ? `Posted · HTTP ${result.status_code}`
                  : `Helix refused it · HTTP ${result.status_code}`}
              </div>
              {/* What actually went over the wire, after coercion. A
                  float field typed as "12" is sent as the number 12,
                  and seeing that is most of the value of sending by
                  hand. */}
              <pre className="mt-1.5 text-[11px] font-mono text-slate-300 whitespace-pre-wrap break-all">
                {JSON.stringify(result.sent, null, 2)}
              </pre>
              {!result.ok && (
                <pre className="mt-1.5 text-[11px] font-mono whitespace-pre-wrap break-all">
                  {JSON.stringify(result.body, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-white/10 flex items-center gap-2">
          <button
            type="button"
            disabled={!cameraId || problems.length > 0 || send.isPending}
            onClick={() => send.mutate()}
            className="text-sm px-3 py-1.5 rounded-md bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40"
          >
            {send.isPending ? "Sending…" : "Send event"}
          </button>
          {problems.length > 0 && (
            <span className="text-[11px] text-amber-300">
              {problems.length} attribute{problems.length === 1 ? "" : "s"} need
              fixing first
            </span>
          )}
          {!cameraId && problems.length === 0 && (
            <span className="text-[11px] text-slate-500">Pick a camera.</span>
          )}
        </div>
      </div>
    </div>
  );
}
