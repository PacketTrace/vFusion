import { expect, test } from "@playwright/test";

import { playedSeconds, signIn, watchForFailures } from "../support/app";

/**
 * The regression this file exists for: the player mounted, the session
 * opened, the backend produced segments, and nothing played -- because
 * the playlist URL was root-relative and the API is a different origin,
 * so the browser fetched it from the dev server.
 *
 * "A <video> is on the page" would have passed on that build. Only
 * "the video is advancing" fails on it, which is why that is the
 * assertion and not a proxy for it.
 */

test.describe("Workbench → Live cameras", () => {
  test("plays live video from an online camera", async ({ page }) => {
    const failures = watchForFailures(page);
    await signIn(page);
    await page.goto("/workbench?tab=live");

    const online = page.locator('[data-testid="camera-item"][data-online="true"]');
    await expect(online.first()).toBeVisible({ timeout: 30_000 });

    const name = (await online.first().innerText()).split("\n")[0];
    await online.first().click();
    test.info().annotations.push({ type: "camera", description: name });

    const player = page.getByTestId("live-player");

    // Starting is expected to take a while and failing is not the same
    // as being slow, so surface the real error rather than letting this
    // time out on a message the backend already worked out.
    await expect
      .poll(async () => (await player.getAttribute("data-phase")) ?? "", {
        timeout: 90_000,
        intervals: [1000],
        message: "the player never reached a terminal state",
      })
      .not.toBe("starting");

    if ((await player.getAttribute("data-phase")) === "error") {
      throw new Error(
        `stream failed for "${name}": ${await page.getByTestId("live-error").innerText()}`,
      );
    }

    // The actual test. Not "is there a player" — is it moving.
    await expect
      .poll(() => playedSeconds(page), {
        timeout: 60_000,
        intervals: [1000],
        message: `video never advanced for "${name}" — the player is mounted but nothing is decoding`,
      })
      .toBeGreaterThan(0.5);

    // ...and still moving a few seconds later, which is what separates
    // "it played one segment" from "it is streaming".
    const first = await playedSeconds(page);
    await page.waitForTimeout(6000);
    expect(await playedSeconds(page), "playback stalled after starting").toBeGreaterThan(
      first + 1,
    );

    expect(failures.excluding("favicon")).toEqual([]);
  });

  test("stops a stream on request and frees its slot", async ({ page }) => {
    await signIn(page);
    await page.goto("/workbench?tab=live");

    const online = page.locator('[data-testid="camera-item"][data-online="true"]');
    await expect(online.first()).toBeVisible({ timeout: 30_000 });
    await online.first().click();

    const sessions = page.getByTestId("live-session");
    await expect(sessions.first()).toBeVisible({ timeout: 60_000 });
    const before = await sessions.count();

    await sessions.first().getByRole("button", { name: /stop/i }).click();
    await expect
      .poll(() => sessions.count(), { timeout: 20_000, intervals: [1000] })
      .toBeLessThan(before);
  });

  test("reports a real reason when a camera cannot stream", async ({ page }) => {
    await signIn(page);
    await page.goto("/workbench?tab=live");

    // An offline camera has nothing to serve. The point is not that it
    // fails -- it is that it says so, rather than showing an empty frame
    // forever, which is exactly what the retry loop used to do.
    const offline = page.locator('[data-testid="camera-item"][data-online="false"]');
    if ((await offline.count()) === 0) {
      test.skip(true, "every camera is online — nothing to fail with");
    }
    await offline.first().click();

    const player = page.getByTestId("live-player");
    await expect
      .poll(async () => (await player.getAttribute("data-phase")) ?? "", {
        timeout: 90_000,
        intervals: [2000],
        message: "an offline camera left the player stuck on 'starting'",
      })
      .toBe("error");
    await expect(page.getByTestId("live-error")).not.toBeEmpty();
  });
});
