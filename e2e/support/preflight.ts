import type { FullConfig } from "@playwright/test";

/**
 * Check the things that are the same for every test, once.
 *
 * A missing password is not fourteen test failures, it is one setup
 * problem — but without this it arrives as fourteen stack traces, each
 * with a screenshot, a video and a trace attached, and the actual
 * sentence buried in the middle. Whoever reads that has to work out
 * that all fourteen say the same thing before they can act on it.
 */
export default async function preflight(config: FullConfig): Promise<void> {
  const problems: string[] = [];

  if (!process.env.E2E_PASSWORD) {
    problems.push(
      "E2E_PASSWORD is not set — the tests sign in like a person does.\n" +
        "  Add it to the stack's .env (which is gitignored), then run again:\n" +
        '    echo "E2E_PASSWORD=your-admin-password" >> .env',
    );
  }

  const baseURL = config.projects[0]?.use?.baseURL;
  if (baseURL) {
    try {
      await fetch(baseURL, { signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      problems.push(
        `Could not reach vFusion at ${baseURL} — is the stack up?\n` +
          `  ${e instanceof Error ? e.message : String(e)}\n` +
          "  Set E2E_BASE_URL in .env if it is served somewhere else.",
      );
    }
  }

  if (problems.length) {
    throw new Error(
      `\n\nCannot run the tests yet:\n\n${problems.map((p) => `• ${p}`).join("\n\n")}\n`,
    );
  }
}
