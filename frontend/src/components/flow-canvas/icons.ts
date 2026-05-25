/**
 * Per-action / per-trigger icons used on the canvas.
 *
 * Kept as a small static map here rather than asking the backend to
 * declare an icon on each ActionSpec — emoji ship instantly, are
 * consistent across platforms, and we don't need server validation for
 * a cosmetic field. Add new entries when new actions are introduced;
 * the unknown-action fallback (✨) is intentionally generic so a new
 * action without an entry still renders cleanly.
 */

export function actionIcon(actionType: string | null | undefined): string {
  if (!actionType) return "•";
  // Gemini-family analyses share the sparkle — easy mental shortcut
  // for "AI happens here".
  if (actionType.startsWith("gemini_")) return "✨";
  // Verkada actions: split by what they actually do, since the user
  // cares about the verb more than the vendor.
  if (actionType === "verkada_unlock_door") return "🔓";
  if (actionType === "verkada_helix_event") return "📝";
  if (actionType === "verkada_grab_clip") return "🎞️";
  if (actionType === "verkada_grab_still") return "📷";
  if (actionType === "verkada_activate_scenario") return "🚨";
  if (actionType === "verkada_release_scenario") return "✅";
  if (actionType === "verkada_api_call") return "🛰️";
  if (actionType.startsWith("verkada_")) return "📹";
  // Generic catch-all so future actions still render something.
  return "⚙️";
}

export function triggerIcon(triggerType: string | null | undefined): string {
  if (triggerType === "schedule") return "⏰";
  // Verkada webhook is the default — camera icon reads as "real-time
  // physical event".
  return "📡";
}

export function conditionIcon(): string {
  return "🔀";
}
