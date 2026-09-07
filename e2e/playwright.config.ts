import { defineConfig } from "@playwright/test";

/**
 * These tests exist because `tsc` and `vite build` both pass on a build
 * that renders a dead player. The bugs this suite is here to catch --
 * a URL resolved against the wrong origin, a cookie that never travels,
 * a codec the browser will not decode -- have no compile-time shape at
 * all. They only exist once a real browser talks to a real backend.
 */

const baseURL = process.env.E2E_BASE_URL || "http://localhost:15173";

export default defineConfig({
  testDir: "./tests",
  // Setup problems are one problem, not one per test.
  globalSetup: "./support/preflight.ts",
  // Live video is genuinely slow to start: the encoder has to produce a
  // couple of segments before anything can play.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // These run against one shared backend with a cap on concurrent
  // transcodes. Racing them would make the cap the thing under test.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "test-results/report" }]],
  outputDir: "test-results/artifacts",
  use: {
    baseURL,
    // Playwright's bundled Chromium ships without H.264/AAC -- the
    // proprietary codecs are stripped. The live view is H.264 over HLS,
    // so on the bundled build it would fail for a reason that has
    // nothing to do with vFusion. Real Chrome has the decoders.
    channel: "chrome",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: [
        // No camera or microphone in the container; without this the
        // media stack refuses to initialise in some configurations.
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
});
