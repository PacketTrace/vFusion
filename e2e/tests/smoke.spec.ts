import { expect, test } from "@playwright/test";

import { signIn, watchForFailures } from "../support/app";

/**
 * Every page loads, signed in, without throwing. Cheap and boring, and
 * it catches the class of break that only shows up at runtime: a bad
 * import, a null deref on first render, an endpoint renamed on one side
 * only. None of those fail `tsc`.
 */

const PAGES = [
  ["/inbox", /webhook/i],
  ["/flows", /flows/i],
  ["/runs", /runs/i],
  ["/templates", /templates/i],
  ["/workbench", /workbench/i],
  ["/helix", /helix/i],
  ["/virtual-camera", /camera/i],
  ["/connections", /connections/i],
  ["/stats", /stats/i],
  ["/mcp", /mcp/i],
  ["/settings", /settings/i],
] as const;

for (const [path, heading] of PAGES) {
  test(`${path} loads`, async ({ page }) => {
    const failures = watchForFailures(page);
    await signIn(page);
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible({
      timeout: 30_000,
    });
    // Not a blanket "no 4xx": a fresh install legitimately 404s on
    // things nobody has configured yet. Uncaught exceptions and 5xx are
    // never fine.
    const real = failures
      .excluding("favicon")
      .filter((f) => f.startsWith("uncaught:") || /^5\d\d /.test(f));
    expect(real, `${path} broke at runtime`).toEqual([]);
  });
}
