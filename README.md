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
  - `POST /calendars` — lists the account's calendars (used by the `xhrSelect`
    dropdowns in the plugin form).
  - `GET /trmnl` — the polling endpoint. Fetches events for the selected
    calendars, expands recurrences, and returns the week-grid JSON TRMNL
    renders.
- **`settings.yml`** — the TRMNL private plugin manifest: a `worker_url`
  field (each installer's own deployed backend), Apple ID, app-specific
  password, time zone, and 5 calendar pickers.
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

1. TRMNL dashboard → Plugins → Private Plugin → New.
2. Under **Import/Export**, paste in the contents of `settings.yml`, or
   manually recreate the strategy/custom fields/polling settings it
   describes.
3. Paste each file in `templates/` into the matching layout tab
   (Full, Half horizontal, Half vertical, Quadrant) in the Markup editor.
4. Add a plugin instance: paste your deployed backend URL into "Your Backend
   URL", enter your Apple ID + an app-specific password (generate one at
   appleid.apple.com → Sign-In and Security → App-Specific Passwords — never
   your real Apple ID password), then use the Calendar 1–5 dropdowns to pick
   which calendars to show.

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
