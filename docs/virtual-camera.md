# Virtual camera

*Serve your own footage to Verkada's Command Connector as a third-party camera.*

**Where:** the **Virtual camera** item in the nav. Two tabs: Camera and Queue.
**Compose profile:** `docker compose --profile rtsp up -d` (adds the `rtsp-server` container).

A Command Connector adds a third-party camera by URL and expects that URL to keep answering. A stream that stops between clips gets the camera marked offline, and a camera that flaps is worse than one never added. So the virtual camera holds **one unbroken stream open for as long as the switch is on**, and changes what is inside it. Clip boundaries are invisible to the Connector.

## Camera tab

**1 · Where the Connector will find it.** The RTSP URL, and the ONVIF address if you use that mode. Two accounts, deliberately: the *read* credential you paste into Verkada can only read, and the *publish* credential never leaves the compose network.

**2 · Turn it on.** Pick a mode:

- **ONVIF** (recommended). vFusion answers enough of ONVIF Profile S for the Connector to discover the streams and describe them, which is what unlocks Verkada's Advanced Analytics on the camera. Add it in Command as an IP camera at `http://<host>:8090`.
- **Plain RTSP.** Just the stream URL. Switching a paired ONVIF camera to plain RTSP takes it offline in Command, and the page warns before it does.

The status strip shows ON AIR, how long the stream has been up, whether the encoder is keeping up, and the viewer count. Click the count to see who is connected.

**What it plays.** Standby footage when the queue is empty; otherwise the queue, in order.

## Queue tab

- **Upload** a clip (up to 1 GB, streamed to disk), or **fetch one from a URL** — a direct `.mp4`, an `.m3u8`, or a page that contains a video, resolved by yt-dlp. Downloads are kept as files so a signed URL cannot expire mid-loop.
- **Live source.** Point the camera at a live URL instead of files: an RTSP or RTMP source, an HLS manifest, or a YouTube live page.
- **Loop** keeps the queue going round instead of dropping to standby.
- **Skip** what is on air. **Set aside** takes an item out of the running order without deleting it.
- Played items are kept, so "it played and you missed it" and "it never played" stay distinguishable.

Every clip is scaled and padded to one fixed geometry before it reaches the encoder, because that geometry is baked into what the Connector negotiated. Changing it means re-adding the camera in Command.

## Ports

| Port | Purpose | Change with |
|---|---|---|
| `8554` | RTSP, the URL the Connector dials | `RTSP_PUBLIC_PORT` in `.env` |
| `8090` | ONVIF, the address an ONVIF client is told | `ONVIF_PUBLIC_PORT` in `.env` |

8554 is often already taken on a host that runs another MediaMTX or an NVR bridge; moving it here moves the URL vFusion hands out.

## With the video library and Helix demos

Clips generated or uploaded in [Workbench → Video library](workbench.md#video-library) can be added to the queue with one click. The **live demo sequencer** goes further: an ambient clip holds the stream, event clips jump the queue on a schedule, and a matching Helix event is posted stamped inside the clip's window, so the timeline in Command shows footage that matches the event. See [Helix](helix.md#demo-data).

## How it is built

- `backend/app/rtsp/pump.py` — one long-lived encoder; sources are piped into it and normalised first. The bytes never enter Python.
- `backend/app/rtsp/mediamtx.py` — the RTSP server's config is rendered from stored state and validated before it is written.
- `backend/app/onvif/` — the SOAP responses a Connector actually calls, as XML templates.
- State is a file on the assets volume; nothing here needs a migration.
