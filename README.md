# iCloud Multi-Calendar (TRMNL plugin recipe)

Merges up to 5 iCloud (or any CalDAV-shared) calendars into one week grid on
a TRMNL device. Every installer deploys their own backend and supplies their
own Apple ID — nothing here is tied to whoever publishes the recipe.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/SkyeMoroney/trmnl-icloud-calendar/tree/main/worker)

## How it works

- **`worker/`** — a stateless backend (plain Node.js, no cloud-specific
  runtime, deployable to Cloudflare Workers via the button above). It speaks
  CalDAV directly to `caldav.icloud.com`, so nothing is stored server-side:
  Apple ID and app-specific password arrive fresh on every request as TRMNL
  plugin custom field values.
  - `POST /calendars` — lists the account's calendars as `{"name": "url", ...}`.
    TRMNL has no reliable way to turn this into a live dropdown in the plugin
    form (an `xhrSelect` field was tried and didn't populate in practice), so
    this is a manual lookup: run it with `curl` once, copy the calendar URLs
    you want into the plugin's Calendar 1–5 fields.
  - `GET /trmnl` — the polling endpoint. Fetches events for the selected
    calendars, expands recurrences, and returns the week-grid JSON TRMNL
    renders.
- **`settings.yml`** — the TRMNL private plugin manifest: a `worker_url`
  field (each installer's own deployed backend), Apple ID, app-specific
  password, time zone, and 5 calendar URL fields (pasted manually).
- **`templates/`** — Liquid markup for all four TRMNL layout sizes
  (`full` = week grid, others = compact upcoming-events list).

## Backend: two different audiences

**Installers** never touch code — they click the Deploy button above, which
forks this repo into their own GitHub account and deploys the worker into
their own Cloudflare account (free tier), then paste the resulting
`*.workers.dev` URL into the plugin's "Your Backend URL" field.

**You (developing/testing this recipe)** can run it locally instead, without
Cloudflare at all:

```bash
cd worker
npm install
npm start        # listens on http://localhost:8787 (set PORT to change it)
```

`worker/src/index.js` exports a plain `fetch(request)` handler (Web standard
`Request`/`Response`); `worker/server.js` is a ~20-line adapter that runs it
under plain Node. `worker/wrangler.toml` exists solely so the Deploy button
can provision a Worker — you never need to run `wrangler` yourself either way.

## Create the TRMNL plugin

TRMNL's private plugin import takes a **flat ZIP** (`settings.yml` +
`*.liquid` files, no subfolders) — build one from this repo:

```bash
cd /tmp && mkdir -p plugin-zip && cp /path/to/repo/settings.yml /path/to/repo/templates/*.liquid plugin-zip/
cd plugin-zip && zip -j ../trmnl-icloud-calendar-plugin.zip *
```

1. Go to [Private Plugin settings](https://usetrmnl.com/plugin_settings?keyname=private_plugin)
   → **Import new** → select that ZIP. TRMNL creates the plugin and adds it
   to your playlist.
2. Look up your calendar URLs once:
   ```bash
   curl -X POST YOUR_BACKEND_URL/calendars \
     -H "Content-Type: application/json" \
     -d '{"apple_id":"you@icloud.com","app_password":"your-app-password"}'
   ```
   Returns `{"Home": "https://caldav.icloud.com/.../home/", ...}` — a URL per
   calendar.
3. Open the new plugin instance and fill in **Backend URL**, **Apple ID**,
   **App-Specific Password** (generate one at appleid.apple.com → Sign-In
   and Security → App-Specific Passwords — never your real Apple ID
   password), and paste up to 5 of the URLs from step 2 into **Calendar 1–5
   URL**. Save.

## Publish as a community recipe

Once it's working for you, TRMNL's private plugin settings page has a
**"Publish as a Recipe"** button that runs their `Chef` linter and submits it
for review — that's the path to get this listed for other users.

## Display

The `full` layout shows the current Mon–Sun week (today highlighted), with
multi-day and all-day events pulled into a banner row across the top —
same convention as iCal/Google Calendar week view. Half/quadrant layouts
show a compact upcoming-events list instead. Time zone defaults to
`Australia/Perth` if the installer leaves that field blank.

TRMNL screens render 16 real grayscale levels, not just 1-bit dithering, so
each calendar (up to 5) is told apart by a distinct shade — via the
TRMNL framework's `text--gray-*` utility classes (`worker/src/grid.js`'s
`shadeFor`) — instead of a "[1]"/"[2]" text prefix on every event.

## Known simplifications

- `/trmnl` re-runs calendar discovery on every poll to resolve calendar
  names for the legend — simplest correct option since nothing is cached;
  revisit if iCloud rate limits become an issue at a 60-minute refresh
  interval.
- Recurring events cap at 500 expanded occurrences per event as a CPU guard.

## Tests

```bash
cd worker
npm test
```

Covers CalDAV XML parsing/filtering, ICS recurrence expansion, timezone-correct
day placement, and week-grid/agenda assembly — all against fixture data, no
live iCloud account needed.
