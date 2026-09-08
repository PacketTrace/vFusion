import { useEffect, useMemo, useState } from "react";

/**
 * A QR code that assembles itself, and then is just a QR code.
 *
 * Every module is drawn as its own square so the reveal can be per
 * module: they settle in from the centre outward, the way the atom
 * mark's electrons ride in on their rings, with a single ring sweeping
 * across the grid as it lands. The whole thing takes about a second,
 * runs once, and ends with every module at full opacity on a white
 * field with a proper quiet zone -- the scanner sees a spec-correct
 * code because the animation only ever touched opacity and transform,
 * never the geometry.
 *
 * Under reduced motion there is no animation: the code is simply there.
 */
export default function QrReveal({
  matrix,
  size = 224,
  label = "QR code",
}: {
  matrix: boolean[][];
  size?: number;
  label?: string;
}) {
  const n = matrix.length;
  const quiet = 4; // modules of quiet zone, per the spec
  const total = n + quiet * 2;
  const reduced = usePrefersReducedMotion();
  const [settled, setSettled] = useState(reduced);

  useEffect(() => {
    if (reduced) {
      setSettled(true);
      return;
    }
    setSettled(false);
    const t = window.setTimeout(() => setSettled(true), 1400);
    return () => window.clearTimeout(t);
  }, [matrix, reduced]);

  const modules = useMemo(() => {
    const out: Array<{ x: number; y: number; delay: number }> = [];
    const c = (n - 1) / 2;
    const maxD = Math.hypot(c, c) || 1;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!matrix[y][x]) continue;
        // Radial: distance from the centre sets the delay, with a little
        // jitter so rings do not read as a mechanical wipe.
        const d = Math.hypot(x - c, y - c) / maxD;
        const jitter = ((x * 7 + y * 13) % 5) * 0.012;
        out.push({ x, y, delay: d * 0.7 + jitter });
      }
    }
    return out;
  }, [matrix, n]);

  return (
    <div
      className="qr-reveal relative rounded-xl bg-white shadow-[0_0_40px_rgba(56,189,248,0.25)]"
      style={{ width: size, height: size }}
      data-settled={settled ? "true" : "false"}
      data-testid="qr-reveal"
    >
      <svg
        viewBox={`0 0 ${total} ${total}`}
        width={size}
        height={size}
        role="img"
        aria-label={label}
        shapeRendering="crispEdges"
      >
        <rect x={0} y={0} width={total} height={total} fill="#ffffff" />
        <g>
          {modules.map((m) => (
            <rect
              key={`${m.x}-${m.y}`}
              x={m.x + quiet}
              y={m.y + quiet}
              width={1}
              height={1}
              fill="#0b1220"
              className={reduced || settled ? undefined : "qr-module"}
              style={
                reduced || settled
                  ? undefined
                  : { animationDelay: `${m.delay}s`, transformOrigin: `${m.x + quiet + 0.5}px ${m.y + quiet + 0.5}px` }
              }
            />
          ))}
        </g>
        {!reduced && !settled && (
          // The ring: one tilted ellipse from the atom, sweeping across
          // as the modules land, then gone.
          <ellipse
            className="qr-ring"
            cx={total / 2}
            cy={total / 2}
            rx={total * 0.62}
            ry={total * 0.22}
            fill="none"
            stroke="#38bdf8"
            strokeWidth={0.6}
            style={{ transformOrigin: `${total / 2}px ${total / 2}px` }}
          />
        )}
      </svg>
    </div>
  );
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}
