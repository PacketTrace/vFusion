/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  future: {
    // Gates every hover: and group-hover: variant behind
    // `@media (hover: hover) and (pointer: fine)`. On touch, a tap fires a
    // false hover and leaves the hovered state stuck until you tap
    // elsewhere — this fixes that app-wide rather than per call site.
    hoverOnlyWhenSupported: true,
  },
  theme: {
    extend: {
      transitionTimingFunction: {
        // Tailwind's default curve is a symmetric ease-in-out, which is
        // wrong for entering and exiting — the two things UI does most.
        // A strong ease-out starts fast, so the interface answers the
        // instant you act. Named so nobody hand-types a bezier again.
        "out-strong": "cubic-bezier(0.23, 1, 0.32, 1)",
        "in-out-strong": "cubic-bezier(0.77, 0, 0.175, 1)",
      },
    },
  },
  plugins: [],
};
