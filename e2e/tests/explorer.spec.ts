import { expect, test } from "@playwright/test";

import { signIn, watchForFailures } from "../support/app";

/**
 * Explorer: the webhook inbox moved under a tab, and two audit-log tabs
 * joined it. These are smoke tests for the seams that a build can break
 * silently -- the old /inbox links, the poller's status, and the
 * Insights drill-down landing on the list with the filter applied.
 */

test.describe("Explorer", () => {
  test("old /inbox links land on the Webhooks tab with their filters", async ({ page }) => {
    const failures = watchForFailures(page);
    await signIn(page);
    await page.goto("/inbox?family=camera");
    await expect(page).toHaveURL(/\/explorer\?/);
    await expect(page.getByTestId("explorer-tab-webhooks")).toHaveClass(/border-sky-500/);
    // The family filter survived the redirect.
    await expect(page.locator("select").first()).toHaveValue("camera");
    expect(failures.list()).toEqual([]);
  });

  test("audit log tab polls and reports a live state", async ({ page }) => {
    const failures = watchForFailures(page);
    await signIn(page);
    await page.goto("/explorer?tab=audit");
    const pill = page.getByTestId("audit-poll-status");
    await expect(pill).toBeVisible({ timeout: 30_000 });
    // "unconfigured" means no Verkada connection; "error" means the poll
    // is failing. Either is a real finding, so the test says which.
    await expect
      .poll(async () => (await pill.getAttribute("data-phase")) ?? "", {
        timeout: 90_000,
        intervals: [2000],
        message: "the poller never reached live/backfilling",
      })
      .toMatch(/live|backfilling/);
    await expect(page.getByTestId("audit-search")).toBeVisible();
    expect(failures.list()).toEqual([]);
  });

  test("filtering from Insights narrows the chart instead of navigating away", async ({ page }) => {
    // The regression: clicking a mark applied the filter and dropped you
    // into the Events list, ending whatever exploration you were in the
    // middle of. Filtering must never change which view you are in.
    const failures = watchForFailures(page);
    await signIn(page);
    // Own API calls included, so a quiet org still has something to draw.
    await page.goto("/explorer?tab=audit&view=insights&range=7d&api=1");
    const insights = page.getByTestId("audit-view-insights");
    await expect(insights).toHaveAttribute("aria-pressed", "true");

    const api = page.getByRole("button", { name: /API requests/ });
    await expect(api).toBeVisible({ timeout: 60_000 });
    await api.click();

    await expect(page).toHaveURL(/category=api/);
    await expect(page).toHaveURL(/view=insights/);
    await expect(insights).toHaveAttribute("aria-pressed", "true");
    // Still the charts, not the row list.
    await expect(page.getByTestId("audit-list")).toHaveCount(0);

    // And the filter survives the trip to the rows, which is the thing
    // that makes staying put acceptable.
    await page.getByTestId("audit-view-events").click();
    await expect(page).toHaveURL(/category=api/);
    await expect(page.getByTestId("audit-list").or(page.getByText("Nothing matches."))).toBeVisible({
      timeout: 30_000,
    });
    expect(failures.list()).toEqual([]);
  });
});
