/**
 * Reading and writing ``{{ … }}`` references the way a person would.
 *
 * ``{{ steps.inspect.output.json.obstructed }}`` is exact and unreadable.
 * The same reference, described, is "Inspect the door › obstructed",
 * and that is what fields and pickers show. The raw form stays the
 * stored form; nothing here changes what the engine sees.
 */

export interface StepLabel {
  name: string;
  label?: string;
}

export interface RefInfo {
  /** The bare path inside the braces. */
  path: string;
  /** Where it comes from. */
  source: "trigger" | "step" | "unknown";
  /** Step name, for step refs. */
  step?: string;
  /** "Inspect the door" / "This event". */
  origin: string;
  /** "obstructed" / "camera id". */
  field: string;
}

export const REF_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

const NOISE = new Set(["output", "json", "data", "text"]);

export function describeRef(path: string, steps: StepLabel[] = []): RefInfo {
  const parts = path.split(".").filter(Boolean);
  if (parts[0] === "trigger") {
    const rest = parts.slice(1);
    return {
      path,
      source: "trigger",
      origin: "This event",
      field: humanField(rest),
    };
  }
  if (parts[0] === "steps" && parts.length >= 2) {
    const name = parts[1];
    const step = steps.find((s) => s.name === name);
    const rest = parts.slice(2);
    // "output.text" is the whole answer; "output.json.obstructed" is one
    // field of it; "output" alone is everything the step produced.
    const field =
      rest.length === 0
        ? "everything it produced"
        : rest.join(".") === "output.text"
          ? "the answer"
          : rest.join(".") === "output.json"
            ? "the JSON answer"
            : humanField(rest);
    return { path, source: "step", step: name, origin: step?.label || name, field };
  }
  return { path, source: "unknown", origin: "", field: path };
}

function humanField(parts: string[]): string {
  const kept = parts.filter((p, i) => !(NOISE.has(p) && i < parts.length - 1));
  const last = kept.length ? kept : parts;
  return last
    .map((p) => (/^\d+$/.test(p) ? `#${Number(p) + 1}` : p.replace(/_/g, " ")))
    .join(" › ");
}

/** Every reference in a value, in order. */
export function refsIn(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(REF_RE)) out.push(m[1].trim());
  return out;
}

/** True when the value is exactly one reference and nothing else. */
export function isWholeRef(value: string): boolean {
  const t = value.trim();
  const m = t.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
  return !!m;
}

/** Split a value into literal text and references, for rendering. */
export function segments(value: string): Array<{ kind: "text"; text: string } | { kind: "ref"; path: string }> {
  const out: Array<{ kind: "text"; text: string } | { kind: "ref"; path: string }> = [];
  let last = 0;
  for (const m of value.matchAll(REF_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ kind: "text", text: value.slice(last, idx) });
    out.push({ kind: "ref", path: m[1].trim() });
    last = idx + m[0].length;
  }
  if (last < value.length) out.push({ kind: "text", text: value.slice(last) });
  return out;
}

/** Resolve a path against a sample object, for previews. */
export function sampleFor(path: string, triggerSample: Record<string, unknown> | null, steps: Array<StepLabel & { output_sample?: unknown }>): unknown {
  const parts = path.split(".").filter(Boolean);
  let cur: unknown;
  let rest: string[];
  if (parts[0] === "trigger") {
    cur = triggerSample;
    rest = parts.slice(1);
  } else if (parts[0] === "steps" && parts.length >= 3 && parts[2] === "output") {
    cur = steps.find((s) => s.name === parts[1])?.output_sample;
    rest = parts.slice(3);
  } else {
    return undefined;
  }
  for (const key of rest) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[key];
    else return undefined;
  }
  return cur;
}

export function formatSample(v: unknown): string {
  if (v === undefined) return "";
  if (v === null) return "null";
  if (typeof v === "string") return v.length > 60 ? `"${v.slice(0, 57)}…"` : `"${v}"`;
  if (typeof v === "object") {
    const j = JSON.stringify(v);
    return j.length > 60 ? j.slice(0, 57) + "…" : j;
  }
  return String(v);
}
