/**
 * Turning a one-shot analysis into a flow.
 *
 * Two places want this: the Workbench, from whatever is currently in its
 * form, and the Runs page, from a run you are looking at and liked. They
 * assemble the same thing from the same pieces, so it lives here rather
 * than twice — the wiring is the part worth not getting subtly different
 * in two places, because a mismatch shows up as a Helix attribute that
 * silently never fills in.
 *
 * The trigger this produces is a starting point, not an answer. It fires
 * on motion from the one camera, unfiltered, and the editor it opens
 * into asks what it should really be.
 */

export interface AutomateArgs {
  analyticName: string;
  prompt: string;
  model: string;
  mode: "live" | "historical";
  cameraId: string;
  verkadaConnId: string;
  geminiConnId: string;
  /** "" when the analytic does not post to Helix. */
  helixEventTypeUid: string;
  helixMapping: Record<string, string> | null;
  durationSec: number;
}

export function buildFlowBody(a: AutomateArgs): Record<string, unknown> {
  // The camera is written in literally rather than as
  // {{ trigger.data.camera_id }}. The two resolve identically while the
  // trigger is a webhook filtered to this camera — but the setup step
  // can turn it into a schedule, and a schedule has no trigger.data to
  // read a camera out of. A literal id survives that change; a template
  // ref quietly resolves to nothing.
  const analyzeConfig: Record<string, unknown> = {
    connection_id: a.verkadaConnId,
    gemini_connection_id: a.geminiConnId,
    camera_id: a.cameraId,
    model: a.model,
    prompt: a.prompt,
  };
  if (a.mode === "historical") {
    analyzeConfig.start_epoch = "{{ trigger.data.created }}";
    analyzeConfig.duration_sec = String(a.durationSec);
    analyzeConfig.pre_roll_sec = "2";
  }

  const nodes: Record<string, unknown>[] = [
    {
      id: "analyze",
      name: "analyze",
      label: "Analyze the camera",
      kind: "action",
      action_type: "gemini_analyze_camera",
      // No position: the editor computes the layout when one is absent,
      // which is the same thing "Auto arrange" does. Guessing
      // coordinates here put this node on top of the trigger the canvas
      // draws above it.
      config: analyzeConfig,
    },
  ];
  const edges: Record<string, unknown>[] = [];

  if (a.helixEventTypeUid) {
    // Rewrite the template-local {{ output.* }} shorthand to point at the
    // analyze step, which is what the engine resolves.
    const attributes = Object.fromEntries(
      Object.entries(a.helixMapping ?? {}).map(([attr, ref]) => [
        attr,
        ref.replace(/output\./g, "steps.analyze.output."),
      ]),
    );
    nodes.push({
      id: "post_helix",
      name: "post_helix",
      label: "Post to Helix",
      kind: "action",
      action_type: "verkada_helix_event",
      config: {
        connection_id: a.verkadaConnId,
        camera_id: a.cameraId,
        event_type_uid: a.helixEventTypeUid,
        attributes: Object.keys(attributes).length
          ? attributes
          : { Summary: "{{ steps.analyze.output.text }}" },
      },
    });
    edges.push({ id: "e_analyze_helix", source: "analyze", target: "post_helix" });
  }

  return {
    name: `${a.analyticName} — auto`,
    // Off until it is looked at. A flow that starts firing on every
    // motion event the moment a button is pressed is a surprise bill and
    // a surprise write to someone's Helix log.
    enabled: false,
    trigger_type: "verkada_webhook",
    trigger_config: {
      family: "camera",
      notification_type: "alert_rule_motion",
      filters: { camera_id: a.cameraId },
    },
    nodes,
    edges,
  };
}

/** Read the same arguments back out of a Workbench run's stored input. */
export function argsFromRunInput(
  input: Record<string, unknown> | null,
): AutomateArgs | null {
  if (!input || !input.byoa) return null;
  const str = (k: string) =>
    typeof input[k] === "string" ? (input[k] as string) : "";
  if (!str("connection_id") || !str("gemini_connection_id")) return null;
  if (!str("camera_id") || !str("prompt")) return null;
  const mapping =
    input.helix_attribute_mapping &&
    typeof input.helix_attribute_mapping === "object" &&
    !Array.isArray(input.helix_attribute_mapping)
      ? (input.helix_attribute_mapping as Record<string, string>)
      : null;
  return {
    // A run does not record which analytic it came from, so the flow
    // arrives generically named and gets renamed in the editor. Better
    // than inventing one from the first line of a prompt.
    analyticName: "Analytic",
    prompt: str("prompt"),
    model: str("model"),
    mode: input.mode === "historical" ? "historical" : "live",
    cameraId: str("camera_id"),
    verkadaConnId: str("connection_id"),
    geminiConnId: str("gemini_connection_id"),
    helixEventTypeUid: input.post_to_helix ? str("helix_event_type_uid") : "",
    helixMapping: mapping,
    durationSec:
      typeof input.duration_sec === "number" ? input.duration_sec : 10,
  };
}
