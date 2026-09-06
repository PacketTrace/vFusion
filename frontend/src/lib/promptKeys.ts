/**
 * What keys an analyze step will actually put in ``output.json``.
 *
 * The analyze step and the Helix step that follows it are two halves of
 * one idea, and nothing connected them. You would write a prompt asking
 * for {"animal": …, "behavior": …}, pick a Helix type with Animal and
 * Behavior on it, and get two empty boxes — the form had no idea the
 * step above it had just been told to produce exactly those.
 *
 * Two sources, best first:
 *
 *  1. A captured run sample. If the step has been run, its real output
 *     is ground truth and nothing else can beat it.
 *  2. The prompt text. Every prompt that asks for JSON names its keys,
 *     so they can be read back out without running anything.
 */

/** Keys named in a prompt that asks for a JSON response.
 *
 *  Matches `"name":` — a quoted string followed by a colon. Values
 *  don't match: in `{"animal": "deer"}` only `animal` is followed by
 *  one. That keeps this from suggesting the example answers as if they
 *  were fields. */
export function keysFromPrompt(prompt: string): string[] {
  if (!prompt) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /"([^"\n]{1,60})"\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) {
    const key = m[1].trim();
    // A sentence that happens to be quoted is not a field name.
    if (!key || key.length > 40 || /\s{2,}/.test(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.slice(0, 24);
}

/** Keys on a captured run's ``output.json``. */
export function keysFromSample(sample: unknown): string[] {
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) return [];
  const json = (sample as Record<string, unknown>).json;
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  // The canned output_sample carries a placeholder rather than real
  // fields. Suggesting it would wire every Helix attribute to
  // ``example_field``, which looks configured and resolves to nothing.
  const keys = Object.keys(json as Record<string, unknown>);
  if (keys.length === 1 && keys[0] === "example_field") return [];
  return keys;
}

/** Case- and separator-insensitive, so "Payment Method" finds
 *  `payment_method` and "Vision to text" finds `vision_to_text`. */
export const normalizeKey = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Pair each Helix attribute with the upstream key that means the same
 * thing, and return the template refs to fill in.
 *
 * Only exact normalized matches. A fuzzy guess here writes a ref that
 * looks configured and silently resolves to nothing at run time, which
 * is worse than leaving the box empty for someone to fill.
 */
export function autoWireAttributes(
  attributeNames: string[],
  stepName: string,
  availableKeys: string[],
): Record<string, string> {
  const byNorm = new Map<string, string>();
  for (const k of availableKeys) {
    const n = normalizeKey(k);
    // First wins: a prompt naming the same key twice is one field.
    if (!byNorm.has(n)) byNorm.set(n, k);
  }
  const out: Record<string, string> = {};
  for (const attr of attributeNames) {
    const hit = byNorm.get(normalizeKey(attr));
    if (hit) out[attr] = `{{ steps.${stepName}.output.json.${hit} }}`;
  }
  return out;
}
