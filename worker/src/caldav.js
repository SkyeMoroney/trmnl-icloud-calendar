import { XMLParser } from "fast-xml-parser";

const ROOT = "https://caldav.icloud.com/";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true, // iCloud/CalDAV responses vary in namespace prefixes (D:, C:, etc.)
});

function authHeader(appleId, appPassword) {
  return "Basic " + btoa(`${appleId}:${appPassword}`);
}

async function dav(url, { appleId, appPassword, method = "PROPFIND", depth = "0", body, headers = {} }) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader(appleId, appPassword),
      Depth: depth,
      "Content-Type": "application/xml; charset=utf-8",
      ...headers,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`CalDAV ${method} ${url} failed: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  return parser.parse(xml);
}

// fast-xml-parser gives an array only when there are multiple siblings;
// normalize so callers can always treat it as an array.
function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

async function findCurrentUserPrincipal(appleId, appPassword) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>`;
  const result = await dav(ROOT, { appleId, appPassword, body });
  const href = result?.multistatus?.response?.propstat?.prop?.["current-user-principal"]?.href;
  if (!href) throw new Error("Could not discover iCloud principal — check Apple ID / app-specific password.");
  return new URL(href, ROOT).toString();
}

async function findCalendarHomeSet(principalUrl, appleId, appPassword) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <prop><C:calendar-home-set/></prop>
</propfind>`;
  const result = await dav(principalUrl, { appleId, appPassword, body });
  const href = result?.multistatus?.response?.propstat?.prop?.["calendar-home-set"]?.href;
  if (!href) throw new Error("Could not discover iCloud calendar home set.");
  return new URL(href, ROOT).toString();
}

// Lists the user's calendars: [{ name, href }]. Excludes non-calendar
// collections (task lists, notifications) by checking resourcetype/component set.
export async function discoverCalendars(appleId, appPassword) {
  const principalUrl = await findCurrentUserPrincipal(appleId, appPassword);
  const homeUrl = await findCalendarHomeSet(principalUrl, appleId, appPassword);

  const body = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <prop>
    <displayname/>
    <resourcetype/>
    <C:supported-calendar-component-set/>
  </prop>
</propfind>`;
  const result = await dav(homeUrl, { appleId, appPassword, depth: "1", body });
  const responses = asArray(result?.multistatus?.response);

  const calendars = [];
  for (const r of responses) {
    const prop = r?.propstat?.prop ?? asArray(r?.propstat)[0]?.prop;
    if (!prop) continue;
    const isCalendar = prop.resourcetype && "calendar" in prop.resourcetype;
    if (!isCalendar) continue;

    const comps = asArray(prop["supported-calendar-component-set"]?.comp).map((c) => c?.["@_name"]);
    if (comps.length && !comps.includes("VEVENT")) continue; // skip task/reminder-only lists

    const name = typeof prop.displayname === "string" ? prop.displayname : r?.href;
    calendars.push({ name, href: new URL(r.href, ROOT).toString() });
  }
  return calendars;
}

// Fetches raw VEVENT ICS blobs for one calendar within [rangeStart, rangeEnd).
export async function fetchEvents(appleId, appPassword, calendarHref, rangeStart, rangeEnd) {
  const fmt = (d) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const body = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${fmt(rangeStart)}" end="${fmt(rangeEnd)}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
  const result = await dav(calendarHref, {
    appleId,
    appPassword,
    method: "REPORT",
    depth: "1",
    body,
  });
  const responses = asArray(result?.multistatus?.response);
  return responses
    .map((r) => r?.propstat?.prop?.["calendar-data"])
    .filter((data) => typeof data === "string");
}
