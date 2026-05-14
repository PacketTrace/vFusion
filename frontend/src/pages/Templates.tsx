import { useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  PromptTemplate,
} from "../lib/api";


interface BuiltinTemplate {
  name: string;
  value: string;
}


type EditingState =
  | PromptTemplate
  | { kind: "new"; seedName?: string; seedValue?: string }
  | null;


export default function Templates() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<EditingState>(null);

  const list = useQuery({
    queryKey: ["prompt-templates"],
    queryFn: () => apiGet<PromptTemplate[]>("/api/prompt-templates"),
  });
  const builtins = useQuery({
    queryKey: ["prompt-templates-builtins"],
    queryFn: () => apiGet<BuiltinTemplate[]>("/api/prompt-templates/builtins"),
    staleTime: 60_000,
  });
  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/prompt-templates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["prompt-templates"] }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Prompt templates</h1>
          <p className="text-slate-300 text-sm mt-1">
            Save prompts you reuse across Gemini analyze actions. They show up
            in the action editor's template dropdown alongside the built-ins.
          </p>
        </div>
        <button
          onClick={() => setEditing({ kind: "new" })}
          className="text-sm px-3 py-1.5 rounded-md bg-sky-700 hover:bg-sky-600 text-white whitespace-nowrap"
        >
          + New template
        </button>
      </div>

      {/* User-saved templates */}
      <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg overflow-hidden">
        <div className="px-4 py-2 border-b border-white/10 text-xs uppercase tracking-wider text-slate-400">
          Your templates
        </div>
        {list.isLoading ? (
          <div className="p-6 text-sm text-slate-400">Loading…</div>
        ) : !list.data || list.data.length === 0 ? (
          <div className="p-6 text-sm text-slate-400">
            No saved templates yet. Click <strong className="text-slate-100">+ New template</strong> or
            duplicate one of the defaults below as a starting point.
          </div>
        ) : (
          <ul className="divide-y divide-white/5">
            {list.data.map((t) => (
              <li key={t.id} className="p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-sm font-medium text-slate-100 truncate">
                    {t.name}
                  </div>
                  <div className="text-[10px] text-slate-500 whitespace-nowrap">
                    edited {new Date(t.updated_at).toLocaleString()}
                  </div>
                </div>
                <pre className="mt-2 text-xs text-slate-300 whitespace-pre-wrap line-clamp-4 font-sans">
                  {t.value}
                </pre>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => setEditing(t)}
                    className="text-xs px-2 py-1 rounded border border-white/15 hover:border-sky-500 hover:bg-white/5 text-slate-200"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete template "${t.name}"?`)) del.mutate(t.id);
                    }}
                    className="text-xs px-2 py-1 rounded border border-white/15 text-slate-300 hover:text-rose-300 hover:border-rose-700"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Built-in (default) templates — read-only, duplicate to edit. */}
      {builtins.data && builtins.data.length > 0 && (
        <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b border-white/10 text-xs uppercase tracking-wider text-slate-400">
            Defaults (read-only)
          </div>
          <ul className="divide-y divide-white/5">
            {builtins.data.map((t) => (
              <li key={t.name} className="p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-sm font-medium text-slate-100 truncate flex items-center gap-2">
                    <span>{t.name}</span>
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-sky-900/60 text-sky-200">
                      default
                    </span>
                  </div>
                </div>
                <pre className="mt-2 text-xs text-slate-300 whitespace-pre-wrap line-clamp-4 font-sans">
                  {t.value}
                </pre>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() =>
                      setEditing({
                        kind: "new",
                        seedName: `${t.name} (copy)`,
                        seedValue: t.value,
                      })
                    }
                    className="text-xs px-2 py-1 rounded border border-white/15 hover:border-sky-500 hover:bg-white/5 text-slate-200"
                  >
                    Duplicate to edit
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {editing && (
        <EditorModal
          state={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["prompt-templates"] });
          }}
        />
      )}
    </div>
  );
}


function EditorModal({
  state,
  onClose,
  onSaved,
}: {
  state: Exclude<EditingState, null>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = "id" in state ? state : null;
  const seed = !existing && "kind" in state ? state : null;
  const [name, setName] = useState(existing?.name ?? seed?.seedName ?? "");
  const [value, setValue] = useState(existing?.value ?? seed?.seedValue ?? "");
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      if (existing) {
        return apiPut<PromptTemplate>(
          `/api/prompt-templates/${existing.id}`,
          { name, value },
        );
      }
      return apiPost<PromptTemplate>("/api/prompt-templates", { name, value });
    },
    onSuccess: onSaved,
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
      <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-lg w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-white">
          {existing ? "Edit template" : "New template"}
        </h2>
        <label className="block">
          <div className="text-xs font-medium text-slate-300 mb-1">
            Name <span className="text-rose-400">*</span>
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 focus:outline-none focus:border-sky-500 text-sm"
            placeholder="e.g. Detect packages on porch"
          />
        </label>
        <label className="block">
          <div className="text-xs font-medium text-slate-300 mb-1">
            Prompt <span className="text-rose-400">*</span>
          </div>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={10}
            spellCheck={false}
            className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 focus:outline-none focus:border-sky-500 text-sm"
            placeholder="Describe what Gemini should look for…"
          />
        </label>
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
            Cancel
          </button>
          <button
            onClick={() => {
              setErr(null);
              if (!name.trim()) return setErr("Name is required.");
              if (!value.trim()) return setErr("Prompt is required.");
              save.mutate();
            }}
            disabled={save.isPending}
            className="px-3 py-1.5 rounded-md bg-sky-700 hover:bg-sky-600 text-sm disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
