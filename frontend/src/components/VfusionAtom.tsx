/**
 * The brand mark: a lit nucleus, tilted rings, an electron riding each.
 *
 * Ported from the standalone `vfusion-atom.html`, and deliberately kept
 * in that file's shape -- every visual property is one value in CONFIG
 * and nothing below it needs editing. The stylesheet is generated from
 * CONFIG rather than living in index.css for the same reason: colour and
 * glow appear in both the markup and the CSS, and splitting them across
 * two files is exactly how they drift apart.
 *
 * Geometry sits in a 200x200 viewBox, which is what keeps this usable at
 * header size: a CSS filter on an SVG child is measured in user units,
 * so a 30px glow is 30/200 of the mark's width and scales with it rather
 * than swamping a 24px glyph.
 *
 * Decorative -- aria-hidden, and static under reduced motion, where it
 * still reads as an atom rather than as something that failed to load.
 */

/* ============================================================
   vFusion atom — CONFIG
   All values are plain numbers/strings. Edit these, nothing else.
   ============================================================ */
const CONFIG = {
  // ---- ORBITS (the rings / lines) ----
  orbits: 3, // how many rings. 1–6 looks good. Spread evenly around 180°.
  orbitRx: 88, // ring width  (half-width, in a 200x200 box). Max ~95.
  orbitRy: 34, // ring height (half-height). Smaller = flatter/more tilted.
  orbitStroke: 1.6, // line thickness of each ring
  orbitOpacity: 0.85, // 0–1

  // ---- SPIN ----
  spinSeconds: 4.2, // seconds for one rotation of the FIRST ring. Lower = faster.
  spinStep: 1.4, // each further ring is this many seconds slower
  alternateDirection: true, // every other ring spins the opposite way

  // ---- ELECTRONS (the dots) ----
  electronsPerOrbit: 1, // dots on each ring. 1–3 looks good.
  electronRadius: 5, // dot size

  // ---- NUCLEUS (center) ----
  nucleusRadius: 11,
  nucleusPulse: true, // gently grows/shrinks
  pulseSeconds: 2.4,

  // ---- COLORS ----
  orbitColor: "#ff3b1f", // ring line colour + ring glow
  electronColor: "#ffffff", // dot core
  electronGlow: "#ff3b1f", // dot glow
  nucleusColor: "#ffd9d4", // center core
  nucleusGlow: "#ff1a1a", // center glow
  glow: 1, // glow strength multiplier. 0 = none, 2 = very hot.

  // ---- INTRO ----
  fadeIn: true, // fade + scale in on mount
  fadeInSeconds: 1.2,
};

/* ============================================================
   RENDERER — no need to edit below this line
   ============================================================ */

const g = CONFIG.glow;
const ds = (col: string, a: number, b: number) =>
  `drop-shadow(0 0 ${a * g}px ${col}) drop-shadow(0 0 ${b * g}px ${col})`;

const CSS = `
  .vfa{width:100%;height:100%;display:block;overflow:visible}
  .vfa .orbit{fill:none;stroke:${CONFIG.orbitColor};stroke-width:${CONFIG.orbitStroke};opacity:${CONFIG.orbitOpacity};
    filter:${ds(CONFIG.orbitColor, 3, 10)}}
  .vfa .ring{transform-origin:100px 100px;animation:vfa-spin var(--dur) linear infinite var(--dir)}
  .vfa .e{fill:${CONFIG.electronColor};filter:${ds(CONFIG.electronGlow, 4, 12)}}
  .vfa .nucleus{fill:${CONFIG.nucleusColor};
    filter:drop-shadow(0 0 ${4 * g}px #fff) ${ds(CONFIG.nucleusGlow, 12, 30)};
    ${CONFIG.nucleusPulse ? `animation:vfa-pulse ${CONFIG.pulseSeconds}s ease-in-out infinite;` : ``}}
  @keyframes vfa-spin{to{transform:rotate(360deg)}}
  @keyframes vfa-pulse{0%,100%{r:${CONFIG.nucleusRadius}}50%{r:${CONFIG.nucleusRadius * 1.18}}}
  ${
    CONFIG.fadeIn
      ? `
  .vfa{opacity:0;animation:vfa-in ${CONFIG.fadeInSeconds}s ease-out forwards}
  @keyframes vfa-in{0%{opacity:0;transform:scale(.7)}60%{opacity:.5}100%{opacity:1;transform:scale(1)}}`
      : ``
  }
  @media (prefers-reduced-motion:reduce){.vfa .ring,.vfa .nucleus{animation-iteration-count:1}}
`;

interface Ring {
  dur: string;
  dir: string;
  angle: number;
  dots: { cx: number; cy: number }[];
}

// Computed once at module load: CONFIG never changes at runtime, so
// there is nothing here for a render to redo.
const RINGS: Ring[] = Array.from({ length: CONFIG.orbits }, (_, i) => {
  const angle = (180 / CONFIG.orbits) * i;
  const a = (angle * Math.PI) / 180;
  return {
    dur: `${CONFIG.spinSeconds + CONFIG.spinStep * i}s`,
    dir: CONFIG.alternateDirection && i % 2 === 1 ? "reverse" : "normal",
    angle,
    dots: Array.from({ length: CONFIG.electronsPerOrbit }, (_, k) => {
      // Evenly around the ellipse...
      const t = ((2 * Math.PI) / CONFIG.electronsPerOrbit) * k;
      const x = 100 + CONFIG.orbitRx * Math.cos(t);
      const y = 100 + CONFIG.orbitRy * Math.sin(t);
      // ...then rotated by the ring's tilt, so it sits ON the ring
      // rather than on an untilted copy of it.
      return {
        cx: 100 + (x - 100) * Math.cos(a) - (y - 100) * Math.sin(a),
        cy: 100 + (x - 100) * Math.sin(a) + (y - 100) * Math.cos(a),
      };
    }),
  };
});

export default function VfusionAtom() {
  return (
    <span className="brand-atom">
      <style>{CSS}</style>
      <svg className="vfa" viewBox="0 0 200 200" aria-hidden="true">
        {RINGS.map((ring, i) => (
          <g
            key={i}
            className="ring"
            style={
              { "--dur": ring.dur, "--dir": ring.dir } as React.CSSProperties
            }
          >
            <ellipse
              className="orbit"
              cx="100"
              cy="100"
              rx={CONFIG.orbitRx}
              ry={CONFIG.orbitRy}
              transform={`rotate(${ring.angle} 100 100)`}
            />
            {ring.dots.map((d, k) => (
              <circle
                key={k}
                className="e"
                cx={d.cx.toFixed(2)}
                cy={d.cy.toFixed(2)}
                r={CONFIG.electronRadius}
              />
            ))}
          </g>
        ))}
        <circle
          className="nucleus"
          cx="100"
          cy="100"
          r={CONFIG.nucleusRadius}
        />
      </svg>
    </span>
  );
}
