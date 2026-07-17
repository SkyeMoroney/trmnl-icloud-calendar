import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverCalendars, fetchEvents } from "../src/caldav.js";

const PRINCIPAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/1234567/principal/</href>
    <propstat><prop><current-user-principal><href>/1234567/principal/</href></current-user-principal></prop>
    <status>HTTP/1.1 200 OK</status></propstat>
  </response>
</multistatus>`;

const HOME_SET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/1234567/principal/</href>
    <propstat><prop><C:calendar-home-set><href>/1234567/calendars/</href></C:calendar-home-set></prop>
    <status>HTTP/1.1 200 OK</status></propstat>
  </response>
</multistatus>`;

const CALENDAR_LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/1234567/calendars/</href>
    <propstat><prop><resourcetype><collection/></resourcetype></prop>
    <status>HTTP/1.1 200 OK</status></propstat>
  </response>
  <response>
    <href>/1234567/calendars/home/</href>
    <propstat><prop>
      <displayname>Home</displayname>
      <resourcetype><collection/><C:calendar/></resourcetype>
      <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
    </prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
  <response>
    <href>/1234567/calendars/reminders/</href>
    <propstat><prop>
      <displayname>Reminders</displayname>
      <resourcetype><collection/><C:calendar/></resourcetype>
      <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
    </prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
</multistatus>`;

const REPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/1234567/calendars/home/event1.ics</href>
    <propstat><prop><getetag>"abc"</getetag><C:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:1
DTSTART:20260715T140000Z
SUMMARY:Dentist
END:VEVENT
END:VCALENDAR</C:calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
</multistatus>`;

function mockFetch(responsesByMethod) {
  return async (url, opts) => {
    const key = opts.method;
    const xml = responsesByMethod[key];
    if (!xml) throw new Error(`Unexpected method ${key} in mock`);
    return { ok: true, status: 207, statusText: "Multi-Status", text: async () => xml };
  };
}

test("discoverCalendars filters to VEVENT-capable calendars only", async () => {
  let call = 0;
  const propfindResponses = [PRINCIPAL_XML, HOME_SET_XML, CALENDAR_LIST_XML];
  globalThis.fetch = async (url, opts) => {
    const xml = propfindResponses[call++];
    return { ok: true, status: 207, statusText: "Multi-Status", text: async () => xml };
  };

  const calendars = await discoverCalendars("user@icloud.com", "app-specific-pw");
  assert.equal(calendars.length, 1);
  assert.equal(calendars[0].name, "Home");
  assert.ok(calendars[0].href.endsWith("/1234567/calendars/home/"));
});

test("fetchEvents extracts raw calendar-data blobs from a REPORT response", async () => {
  globalThis.fetch = mockFetch({ REPORT: REPORT_XML });
  const blobs = await fetchEvents(
    "user@icloud.com",
    "app-specific-pw",
    "https://caldav.icloud.com/1234567/calendars/home/",
    new Date("2026-07-01T00:00:00Z"),
    new Date("2026-08-01T00:00:00Z")
  );
  assert.equal(blobs.length, 1);
  assert.match(blobs[0], /SUMMARY:Dentist/);
});
