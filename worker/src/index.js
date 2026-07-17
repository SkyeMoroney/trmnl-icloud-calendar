import { discoverCalendars, fetchEvents } from "./caldav.js";
import { extractEvents, buildPayload, weekInstantRange, zonedParts } from "./grid.js";

// TRMNL's exact xhrSelect POST shape isn't pinned down in public docs, so we
// check a few plausible shapes rather than assume one.
function pickField(body, keyname) {
  return (
    body?.[keyname] ??
    body?.[`settings_custom_fields_values_${keyname}`] ??
    body?.settings_custom_fields_values?.[keyname] ??
    body?.custom_fields_values?.[keyname] ??
    undefined
  );
}

async function handleCalendars(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    // empty/non-JSON body falls through to the missing-credentials response below
  }
  const appleId = pickField(body, "apple_id");
  const appPassword = pickField(body, "app_password");
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

async function handleTrmnl(request) {
  const url = new URL(request.url);
  const appleId = request.headers.get("X-Apple-Id");
  const appPassword = request.headers.get("X-App-Password");
  const tz = url.searchParams.get("tz") || "Australia/Perth";
  const selectedHrefs = ["cal1", "cal2", "cal3", "cal4", "cal5"]
    .map((k) => url.searchParams.get(k))
    .filter((v) => v && v.trim());

  if (!appleId || !appPassword || selectedHrefs.length === 0) {
    return Response.json({
      has_data: false,
      error: "Missing Apple ID, app-specific password, or no calendar selected.",
    });
  }

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
    });
    return Response.json(payload);
  } catch (err) {
    return Response.json({ has_data: false, error: String(err.message || err) });
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/calendars" && request.method === "POST") {
      return handleCalendars(request);
    }
    if (url.pathname === "/trmnl" && request.method === "GET") {
      return handleTrmnl(request);
    }
    return new Response("Not found", { status: 404 });
  },
};
