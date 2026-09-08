# Explorer

*What is happening in your org, from two directions: what Verkada pushes to you, and what you pull from Verkada.*

**Where:** the first item in the nav. Two tabs: Webhooks, and Audit log with an Events view and an Insights view. Every filter you set lives in the URL, so a view can be bookmarked or pasted to someone else.

## Webhooks

Every request to `https://<your-public-url>/hooks/<anything>` is captured, classified and signature-checked.

- **Classified into a family** — camera, access, LPR, sensor, intercom, credential, alarm — and a notification type, using a built-in taxonomy. Anything it cannot place lands on the **Unrecognized** page, where the shape is one click from an issue you can file so the taxonomy grows.
- **Signature-verified.** With a signing secret on the org's connection, every event is HMAC-checked and shows **✓ verified**. Without one, events still land, marked *unverified*.
- **Searchable by name, not just id.** Type "Front Door" and the search expands to the door's UUID, because the payload only carries the id.
- **Assets are kept.** Person crops, vehicle images and thumbnails referenced in a payload are downloaded before their signed URLs expire, and shown beside the event.
- **First webhook bootstraps the install.** vFusion reads the org id off it and creates the Verkada connection for you.

Deleting an event asks first: payloads are the raw material for trigger filters and test runs.

## Audit log

A local, filterable copy of Command's audit log. Verkada's own audit log page filters by a handful of categories and caps a query at 90 days. Its API accepts only a time range. So vFusion pulls the log **every ten seconds** and stores it, and every question is answered from the local copy.

- **Seven days back on first run**, then everything from that point on. *Pull older history* reaches back 30, 90 or 365 days more.
- **Filter by anything on a row**: category (Verkada's own groupings: Admin, User management, Cameras, Access control, Sensors, Alarms…), event, actor (signed-in user, API key, Verkada Support, system), user or key, device, device type, site, IP address, API key name, HTTP method, status code, and free text across the details.
- **Counts before you click.** The rail shows how many rows each value has in the current slice.
- **API requests are hidden by default.** They are most of a working org's log (vFusion's own polling included) and rarely the question. One toggle shows them, with the count of what it was hiding.
- **Where an address is.** Each IP shows a city and region, with proxy and hosting-provider flags in the detail view. See [geolocation](#geolocation).
- **Detail view** shows who, from where, to what, the key's owner when a key did it, Verkada's raw details, and *show more from* links: this user, this key, this IP, this device, this event type, this endpoint.
- **Automate this.** One button on any entry opens the flow editor with an Audit log trigger already set to that event, narrowed to its device when it has one. The next time it happens, the flow runs.
- **Export CSV** for any slice, up to 50,000 rows.
- **Retention** defaults to keep everything (Settings → Retention).

The status pill says what the poller is doing: *Live · every 10s*, *Backfilling 42%*, or why it has stopped.

### Audit-log triggers

Any audit-log entry can start a flow, the way a webhook does. In the flow editor, pick the **Audit log** trigger, then a category, an event, who did it, and optional field filters (`user_email`, `data.device_name`, `data.url`, `status_code`…). The flow runs within ten seconds of the entry appearing in Command. History that arrives through a backfill never fires a flow. Full detail in [Automate → triggers](automate.md#triggers).

### Geolocation

Lookups go to ip-api.com in batches, only for addresses on screen, and results are cached for 30 days. Private and loopback addresses are labelled locally and never sent anywhere. `GEOIP_PROVIDER=off` in `.env` disables lookups entirely.

## Insights

The Insights view of the Audit log tab: the same slice as the Events view, same filters, drawn.

Clicking any mark narrows the filters and **stays on Insights**, so one question leads to the next without leaving the picture. Switch to Events for the rows whenever you want them; the filters describe both views, so nothing is lost either way.

- **Activity over time**, stacked by category. Click a column to see that window.
- **Who is active** and what each person or key spends their time doing.
- **What is happening** — events by type.
- **Devices** most touched, **IP addresses** with location and how many actors used each.
- **API endpoints** with request and error counts, **API keys**, **status codes** (when API requests are shown).
- **Streaming** — how cameras are being watched. Sessions, time streamed, average and longest, then a **swimlane per camera** with every viewing session drawn where it happened (history views as spans, live views as marks), the most-streamed cameras, and the top streamers. Built from the log's *Video History Streamed* and *Live Stream Started* entries.

## How it is built

- `backend/app/audit/ingest.py` — the poller. Forward cursor on Verkada's *processed* timestamp so late-processed entries are not missed; anything a capped tick leaves behind becomes a backlog window, not a gap.
- `backend/app/audit/taxonomy.py` — event → category, from Verkada's help-centre reference.
- `backend/app/api/audit_events.py` — list, facets, stats, export, status.
- Table `audit_events` (migration 0021). Rows are deduplicated on a fingerprint because Verkada publishes no event id.
