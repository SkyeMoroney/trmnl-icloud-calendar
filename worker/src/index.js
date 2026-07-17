import { discoverCalendars, fetchEvents } from "./caldav.js";
import { extractEvents, buildPayload, weekInstantRange, zonedParts } from "./grid.js";

// /calendars is meant for a manual curl lookup (see README), but CORS costs
// nothing to leave on in case it's ever called from a browser too.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function withCors(response) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) response.headers.set(key, value);
  return response;
}

async function handleCalendars(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    // empty/non-JSON body falls through to the missing-credentials response below
  }
  const appleId = body?.apple_id;
  const appPassword = body?.app_password;
  if (!appleId || !appPassword) {
    return Response.json([{ "Enter Apple ID + app-specific password above first": "" }]);
  }
  try {
    const calendars = await discoverCalendars(appleId, appPassword);
    if (calendars.length === 0) {
      return Response.json([{ "No calendars found for this account": "" }]);
    }
    return Response.json(calendars.map((c) => ({ [c.name]: c.href })));
  } catch (err) {
    return Response.json([{ [`Error: ${err.message || err}`]: "" }]);
  }
}

// A real CalDAV href only ever has "http" once, right at the start. If a
// Calendar N field has two URLs pasted into it with no separator (an easy
// mistake copying out of the /calendars curl output), this catches it
// before it becomes an opaque CalDAV 400.
function looksLikeMultipleUrls(href) {
  return href.indexOf("http", 4) !== -1;
}

async function handleTrmnl(request) {
  const url = new URL(request.url);
  const appleId = request.headers.get("X-Apple-Id");
  const appPassword = request.headers.get("X-App-Password");
  const tz = url.searchParams.get("tz") || "Australia/Perth";
  const slots = ["cal1", "cal2", "cal3", "cal4", "cal5"]
    .map((k, i) => ({ slot: i + 1, href: url.searchParams.get(k) }))
    .filter((s) => s.href && s.href.trim());

  if (!appleId || !appPassword || slots.length === 0) {
    return Response.json({
      has_data: false,
      error: "Missing Apple ID, app-specific password, or no calendar selected.",
    });
  }

  const bad = slots.find((s) => looksLikeMultipleUrls(s.href));
  if (bad) {
    return Response.json({
      has_data: false,
      error: `Calendar ${bad.slot} URL looks like it has two URLs pasted together with no separator. Reopen the plugin instance and check that field holds exactly one calendar URL.`,
    });
  }
  const selectedHrefs = slots.map((s) => s.href);

  try {
    const known = await discoverCalendars(appleId, appPassword);
    const byHref = new Map(known.map((c) => [c.href, c.name]));
    const calendars = selectedHrefs.map((href, i) => ({
      index: i + 1,
      name: byHref.get(href) || `Calendar ${i + 1}`,
      href,
    }));

    const today = zonedParts(new Date(), tz);
    const { start, end } = weekInstantRange(today.year, today.month0, today.day);

    const allEvents = [];
    for (const cal of calendars) {
      const icsBlobs = await fetchEvents(appleId, appPassword, cal.href, start, end);
      allEvents.push(...extractEvents(icsBlobs, start, end, cal.index, tz));
    }

    const payload = buildPayload({
      year: today.year,
      month0: today.month0,
      day: today.day,
      events: allEvents,
      calendars: calendars.map(({ index, name }) => ({ index, name })),
      todayParts: today,
      tz,
    });
    return Response.json(payload);
  } catch (err) {
    return Response.json({ has_data: false, error: String(err.message || err) });
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/calendars" && request.method === "POST") {
      return withCors(await handleCalendars(request));
    }
    if (url.pathname === "/trmnl" && request.method === "GET") {
      return handleTrmnl(request); // polled server-to-server by TRMNL, not a browser request — no CORS needed
    }
    return new Response("Not found", { status: 404 });
  },
};
