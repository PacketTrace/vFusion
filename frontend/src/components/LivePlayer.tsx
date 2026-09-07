import { useEffect, useRef, useState } from "react";
import type HlsType from "hls.js";

import { API_BASE, apiGet, apiPost } from "../lib/api";

/**
 * Live video from one Verkada camera.
 *
 * The backend does not proxy Verkada's stream, it re-encodes it, so
 * what this plays is ordinary same-origin HLS — no token in the page,
 * no HEVC to negotiate, and the session cookie is the only credential
 * involved.
 *
 * Deliberately no teardown call on unmount. Sessions are shared: two
 * people watching the front door share one transcode, so a viewer
 * closing their tab must not be able to stop everyone else's video.
 * The backend stops a stream when nobody is fetching from it, which is
 * the same condition expressed without the race.
 */

type Session = {
  session_id: string;
  camera_id: string;
  name: string;
  ready: boolean;
  error: string | null;
  playlist_url: string;
};

type Phase = "idle" | "starting" | "playing" | "error";

export default function LivePlayer({
  cameraId,
  connectionId,
  className = "",
}: {
  cameraId: string;
  connectionId?: string | null;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<HlsType | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string>("");
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (!cameraId) {
      setPhase("idle");
      return;
    }
    let cancelled = false;
    setPhase("starting");
    setError("");
    setSession(null);

    const fail = (message: string) => {
      if (cancelled) return;
      setError(message);
      setPhase("error");
    };

    (async () => {
      let s: Session;
      try {
        s = await apiPost<Session>("/api/live", {
          camera_id: cameraId,
          connection_id: connectionId ?? null,
        });
      } catch (e) {
        fail(e instanceof Error ? e.message : "Could not open the stream.");
        return;
      }
      if (cancelled) return;
      setSession(s);

      // Wait for the first segments rather than pointing the player at a
      // playlist that does not exist yet. hls.js would retry and
      // eventually give up with a network error that says nothing about
      // the actual state, which is "the encoder is still spinning up".
      let current = s;
      for (let i = 0; i < 40 && !current.ready; i++) {
        await new Promise((r) => setTimeout(r, 750));
        if (cancelled) return;
        try {
          current = await apiGet<Session>(`/api/live/${s.session_id}`);
        } catch (e) {
          fail(e instanceof Error ? e.message : "Lost the stream while starting.");
          return;
        }
        if (current.error) {
          fail(current.error);
          return;
        }
      }
      if (cancelled) return;
      if (!current.ready) {
        fail("The camera did not start streaming in time.");
        return;
      }

      const video = videoRef.current;
      if (!video) return;
      // The API is a different origin from the page (Vite serves the app
      // on its own port and there is no proxy), so a root-relative
      // playlist would be fetched from the dev server instead of the
      // backend. Everything else goes through apiGet, which prepends
      // this for us; the player does its own fetching and does not.
      const url = `${API_BASE}${current.playlist_url}`;

      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        // Safari plays HLS natively and does it better than we can.
        // Cross-origin means the session cookie only travels if we ask
        // for it, and without the cookie every fetch is a 401.
        video.crossOrigin = "use-credentials";
        video.src = url;
        video.play().catch(() => undefined);
        setPhase("playing");
        return;
      }
      // Loaded on demand: hls.js is a third of the app bundle and only
      // this tab has any use for it.
      const Hls = (await import("hls.js")).default;
      if (cancelled) return;
      if (!Hls.isSupported()) {
        fail("This browser cannot play HLS video.");
        return;
      }
      const hls = new Hls({
        // Live: start at the edge and stay near it rather than drifting
        // back through the whole window after a stall.
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        lowLatencyMode: false,
        // Same-origin is the default, and this is not same-origin. Every
        // playlist and segment fetch needs the session cookie.
        xhrSetup: (xhr) => {
          xhr.withCredentials = true;
        },
      });
      hlsRef.current = hls;
      let recoveries = 0;
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        // A live stream restarts on the server every time the stream key
        // is renewed, so recovering is the expected case rather than the
        // exceptional one -- but only for a while. Retrying forever
        // leaves a dead player looking like a camera pointed at a dark
        // room, which is the one outcome worse than an error message.
        if (recoveries >= 6) {
          fail(
            `${data.details || "Playback failed"} — the stream stopped ` +
              "responding. Pick the camera again to restart it.",
          );
          hls.destroy();
          return;
        }
        recoveries += 1;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else fail(data.details || "Playback failed.");
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => undefined);
        if (!cancelled) setPhase("playing");
      });
    })();

    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [cameraId, connectionId]);

  return (
    <div
      data-testid="live-player"
      data-phase={phase}
      className={`relative overflow-hidden rounded-lg border border-white/10 bg-black ${className}`}
    >
      <video
        ref={videoRef}
        data-testid="live-video"
        muted
        playsInline
        controls
        className="w-full aspect-video bg-black"
      />
      {phase !== "playing" && (
        <div className="absolute inset-0 grid place-items-center bg-black/70 p-6 text-center">
          {phase === "idle" && (
            <p className="text-sm text-slate-500">Pick a camera to watch.</p>
          )}
          {phase === "starting" && (
            <div className="space-y-1">
              <p className="text-sm text-slate-300">Connecting to the camera…</p>
              <p className="text-[11px] text-slate-500">
                The first few seconds of video have to be encoded before they
                can play.
              </p>
            </div>
          )}
          {phase === "error" && (
            <div className="max-w-md space-y-1">
              <p data-testid="live-error" className="text-sm text-rose-300">
                {error}
              </p>
              <p className="text-[11px] text-slate-500">
                {session?.name ? `${session.name} · ` : ""}
                {cameraId.slice(0, 8)}…
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
