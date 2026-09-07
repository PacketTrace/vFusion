# End-to-end tests

These exist because `tsc` and `vite build` both pass on a build that
renders a dead video player.

The live-camera feature shipped broken twice in ways nothing in CI could
have seen: a playlist URL resolved against the page origin instead of
the API origin, and a cross-origin fetch that never sent the session
cookie. Neither has a compile-time shape. Both are obvious the instant a
real browser talks to a real backend.

So the assertions here are deliberately about behaviour, not presence.
`live-cameras.spec.ts` does not check that a `<video>` exists — that
would have passed on the broken build. It checks that `currentTime` is
advancing, and still advancing six seconds later.

## Running them

Against a stack that is already up:

```sh
cd ~/dockerConfig/vFusion
docker compose --profile test run --rm e2e
```

`E2E_PASSWORD` must be set in the stack's `.env` — the tests sign in
through the form like a person does, because the session cookie is one
of the things being exercised.

One spec, one browser:

```sh
docker compose --profile test run --rm e2e npx playwright test live-cameras
```

Failures leave a trace, a screenshot and a video under `test-results/`,
and an HTML report:

```sh
npx playwright show-report e2e/test-results/report
```

## Two things that will bite

**Chrome, not Chromium.** Playwright's bundled Chromium ships without
H.264 and AAC — the proprietary codecs are stripped. The live view is
H.264 over HLS, so on the bundled build it fails for a reason that has
nothing to do with vFusion. The config pins `channel: "chrome"` and the
image installs real Google Chrome.

**`network_mode: host`.** The app in the browser talks to
`VITE_API_BASE`, which is a hostname the operator picked. Putting the
test container on the compose network would make that name resolve
differently — or not at all — from how it resolves for a real browser.
Sharing the host's network is what makes the address mean the same thing.

## What is not covered

Only the live-camera path and a page-loads smoke sweep. The flow editor,
Helix and the virtual camera all have runtime behaviour worth pinning
down and none of it is tested yet.

Expired-segment 404s are excluded from the failure watcher by shape: a
live HLS window rolls, and a player asking a moment late is told so.
That exclusion is narrow on purpose — it matches segments and never a
playlist, which is where the original bug was.
