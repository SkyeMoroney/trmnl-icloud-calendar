import { test } from "node:test";
import assert from "node:assert/strict";
import { extractEvents, buildPayload, weekInstantRange, zonedParts, shadeFor } from "../src/grid.js";

function ics(vevents) {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${vevents}\r\nEND:VCALENDAR\r\n`;
}

// Wed 2026-07-15 is inside the Mon 2026-07-13 - Sun 2026-07-19 week.
const WEEK_RANGE = { start: new Date("2026-07-01T00:00:00Z"), end: new Date("2026-08-01T00:00:00Z") };

test("extractEvents places a plain event on the right zoned day and time", () => {
  const blob = ics(
    "BEGIN:VEVENT\r\nUID:1\r\nDTSTART:20260715T230000Z\r\nDTEND:20260716T000000Z\r\nSUMMARY:Late call\r\nEND:VEVENT"
  );
  const utcEvents = extractEvents([blob], WEEK_RANGE.start, WEEK_RANGE.end, 1, "UTC");
  assert.equal(utcEvents.length, 1);
  assert.equal(utcEvents[0].dayKey, "2026-07-15");
  assert.equal(utcEvents[0].isBanner, false);

  // 23:00 UTC on Jul 15 is 19:00 (7pm) US/Eastern the same day, not the 16th.
  const nyEvents = extractEvents([blob], WEEK_RANGE.start, WEEK_RANGE.end, 1, "America/New_York");
  assert.equal(nyEvents[0].dayKey, "2026-07-15");
  assert.equal(nyEvents[0].timeLabel, "7:00 PM");
});

test("extractEvents expands a recurring event within range and stops outside it", () => {
  const blob = ics(
    "BEGIN:VEVENT\r\nUID:2\r\nDTSTART:20260701T090000Z\r\nDTEND:20260701T093000Z\r\nRRULE:FREQ=DAILY;COUNT=10\r\nSUMMARY:Standup\r\nEND:VEVENT"
  );
  const range = { start: new Date("2026-07-05T00:00:00Z"), end: new Date("2026-07-08T00:00:00Z") };
  const events = extractEvents([blob], range.start, range.end, 1, "UTC");
  assert.equal(events.length, 3); // Jul 5, 6, 7 fall inside [Jul 5, Jul 8)
  assert.deepEqual(events.map((e) => e.dayKey), ["2026-07-05", "2026-07-06", "2026-07-07"]);
});

test("extractEvents flags a 3-day all-day event as a banner spanning start to inclusive end", () => {
  // All-day multi-day: DTEND is exclusive per RFC5545 (Mon-Wed -> DTEND Thu).
  const blob = ics(
    "BEGIN:VEVENT\r\nUID:3\r\nDTSTART;VALUE=DATE:20260713\r\nDTEND;VALUE=DATE:20260716\r\nSUMMARY:Conference\r\nEND:VEVENT"
  );
  const events = extractEvents([blob], WEEK_RANGE.start, WEEK_RANGE.end, 1, "UTC");
  assert.equal(events.length, 1);
  assert.equal(events[0].isBanner, true);
  assert.equal(events[0].dayKey, "2026-07-13");
  assert.equal(events[0].endDayKey, "2026-07-15"); // inclusive last day, not the exclusive DTEND
});

test("extractEvents flags a single-day all-day event as a banner too (iCal convention)", () => {
  const blob = ics(
    "BEGIN:VEVENT\r\nUID:4\r\nDTSTART;VALUE=DATE:20260715\r\nDTEND;VALUE=DATE:20260716\r\nSUMMARY:Public Holiday\r\nEND:VEVENT"
  );
  const events = extractEvents([blob], WEEK_RANGE.start, WEEK_RANGE.end, 1, "UTC");
  assert.equal(events[0].isBanner, true);
  assert.equal(events[0].dayKey, "2026-07-15");
  assert.equal(events[0].endDayKey, "2026-07-15");
});

test("buildPayload builds a Mon-Sun week, highlights today, and clips/positions banner bars", () => {
  const bannerEvents = extractEvents(
    [
      ics("BEGIN:VEVENT\r\nUID:5\r\nDTSTART;VALUE=DATE:20260710\r\nDTEND;VALUE=DATE:20260715\r\nSUMMARY:Trip\r\nEND:VEVENT"),
    ],
    WEEK_RANGE.start,
    WEEK_RANGE.end,
    1,
    "UTC"
  ); // Fri Jul 10 - Tue Jul 14 inclusive: starts before the visible week, should clip to Monday.
  const timedEvents = extractEvents(
    [ics("BEGIN:VEVENT\r\nUID:6\r\nDTSTART:20260715T130000Z\r\nDTEND:20260715T140000Z\r\nSUMMARY:Dentist\r\nEND:VEVENT")],
    WEEK_RANGE.start,
    WEEK_RANGE.end,
    2,
    "UTC"
  );

  const payload = buildPayload({
    year: 2026,
    month0: 6,
    day: 15,
    events: [...bannerEvents, ...timedEvents],
    calendars: [{ index: 1, name: "Trips" }, { index: 2, name: "Home" }],
    todayParts: { year: 2026, month0: 6, day: 15 },
  });

  assert.equal(payload.week_days.length, 7);
  assert.equal(payload.week_days[0].date, "2026-07-13"); // Monday first
  assert.equal(payload.weekday_labels[0], "Mon");

  const wednesday = payload.week_days.find((d) => d.date === "2026-07-15");
  assert.equal(wednesday.is_today, true);
  assert.equal(wednesday.events[0].title, "Dentist");

  assert.equal(payload.multiday_events.length, 1);
  assert.equal(payload.multiday_events[0].col, 1); // clipped to Monday, the visible week's first column
  assert.equal(payload.multiday_events[0].span, 2); // only Mon-Tue of the trip fall in this week
});

test("weekInstantRange pads a day on each side of the visible Mon-Sun week", () => {
  const { start, end } = weekInstantRange(2026, 6, 15); // Wed Jul 15 -> week of Jul 13-19
  assert.ok(start < new Date("2026-07-13T00:00:00Z"));
  assert.ok(end > new Date("2026-07-20T00:00:00Z"));
});

test("shadeFor gives each calendar a distinct grayscale class and wraps after 5", () => {
  const shades = [1, 2, 3, 4, 5].map(shadeFor);
  assert.equal(new Set(shades).size, 5); // all distinct
  assert.equal(shadeFor(6), shadeFor(1)); // wraps for a 6th calendar
});

test("zonedParts reads wall-clock components in the given IANA zone", () => {
  const p = zonedParts(new Date("2026-07-15T23:00:00Z"), "America/New_York");
  assert.equal(p.year, 2026);
  assert.equal(p.month0, 6);
  assert.equal(p.day, 15);
  assert.equal(p.hour, 19);
});
