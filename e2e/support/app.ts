import { expect, Page, Response } from "@playwright/test";

/** Shared plumbing: getting signed in, and noticing when the app breaks. */

export async function signIn(page: Page): Promise<void> {
  const secret = process.env.E2E_PASSWORD;
  if (!secret) {
    throw new Error(
      "E2E_PASSWORD is not set. Put the vFusion admin password in the " +
        "stack's .env as E2E_PASSWORD — the tests sign in like a person does.",
    );
  }
  await page.goto("/");

  // The gate asks /api/auth/status before it decides what to render, so
  // wait for one of the three outcomes rather than assuming the login form.
  const password = page.locator('input[type="password"]').first();
  const nav = page.getByRole("navigation");
  await expect(password.or(nav)).toBeVisible({ timeout: 30_000 });

  if (await password.isVisible()) {
    await password.fill(secret);
    await page.getByRole("button", { name: /sign in/i }).click();
  }
  await expect(nav).toBeVisible({ timeout: 30_000 });
}

/**
 * Collects failures the page would otherwise swallow.
 *
 * A live HLS stream 404s on purpose: segments roll out of the window
 * and a player that asks a moment late gets told so. Flagging those
 * would make the suite flaky for the one thing that is working
 * correctly, so they are excluded by shape -- a segment, specifically,
 * and never a playlist.
 */
export function watchForFailures(page: Page) {
  const failures: string[] = [];
  const expiredSegment = /\/api\/live\/[0-9a-f]+\/seg\d+\.ts$/;

  page.on("response", (res: Response) => {
    const url = res.url();
    if (res.status() < 400) return;
    if (res.status() === 404 && expiredSegment.test(url)) return;
    failures.push(`${res.status()} ${res.request().method()} ${url}`);
  });
  page.on("pageerror", (err) => failures.push(`uncaught: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") failures.push(`console: ${msg.text()}`);
  });

  return {
    list: () => failures,
    /** Everything except a set of substrings known to be noise. */
    excluding: (...ignore: string[]) =>
      failures.filter((f) => !ignore.some((i) => f.includes(i))),
  };
}

/** How far the <video> has actually played, in seconds. */
export function playedSeconds(page: Page): Promise<number> {
  return page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>(
      '[data-testid="live-video"]',
    );
    return v ? v.currentTime : 0;
  });
}
