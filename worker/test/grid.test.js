import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractEvents,
  buildPayload,
  weekInstantRange,
  zonedParts,
  shadeFor,
  layoutTimedEvents,
  HOUR_LABELS,
} from "../src/grid.js";

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

test("layoutTimedEvents positions a 9am-5pm event correctly in the 7am-7pm grid", () => {
  const blob = ics(
    "BEGIN:VEVENT\r\nUID:7\r\nDTSTART:20260715T090000Z\r\nDTEND:20260715T170000Z\r\nSUMMARY:Interviews\r\nEND:VEVENT"
  );
  const events = extractEvents([blob], WEEK_RANGE.start, WEEK_RANGE.end, 1, "UTC");
  const [box] = layoutTimedEvents(events, "UTC");
  assert.equal(box.top, 16.7); // (9am-7am)/12h = 16.67%, rounded to 1dp
  assert.equal(box.height, 66.7); // 8h/12h = 66.67%
  assert.equal(box.left, 0);
  assert.equal(box.width, 98); // full width minus the gutter
});

test("layoutTimedEvents splits a same-start-time pair side by side, not staggered", () => {
  // Two haircuts booked for the same 10:50 slot read as parallel options.
  const blob = ics(
    "BEGIN:VEVENT\r\nUID:8\r\nDTSTART:20260715T105000Z\r\nDTEND:20260715T111500Z\r\nSUMMARY:Cut A\r\nEND:VEVENT\r\n" +
      "BEGIN:VEVENT\r\nUID:9\r\nDTSTART:20260715T105000Z\r\nDTEND:20260715T111500Z\r\nSUMMARY:Cut B\r\nEND:VEVENT"
  );
  const events = extractEvents([blob], WEEK_RANGE.start, WEEK_RANGE.end, 1, "UTC");
  const boxes = layoutTimedEvents(events, "UTC");
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes.map((b) => b.left).sort((a, b) => a - b), [0, 50]);
  assert.ok(boxes.every((b) => b.width < 50)); // narrower than full width since they share the row
});

test("layoutTimedEvents cascades a pair with different start times instead of splitting", () => {
  // A short meeting starting partway through a long one reads as "nested inside it".
  const blob = ics(
    "BEGIN:VEVENT\r\nUID:14\r\nDTSTART:20260713T090000Z\r\nDTEND:20260713T170000Z\r\nSUMMARY:Interviews\r\nEND:VEVENT\r\n" +
      "BEGIN:VEVENT\r\nUID:15\r\nDTSTART:20260713T130000Z\r\nDTEND:20260713T140000Z\r\nSUMMARY:Chat\r\nEND:VEVENT"
  );
  const events = extractEvents([blob], WEEK_RANGE.start, WEEK_RANGE.end, 1, "UTC");
  const boxes = layoutTimedEvents(events, "UTC");
  assert.equal(boxes.length, 2);
  const [first, second] = [...boxes].sort((a, b) => a.left - b.left);
  // Both cards extend to the right edge (left + width = 100); the underneath
  // card (first) is only *visually* reduced to its 14%-wide left sliver
  // because the front card (second, higher z) paints over the rest of it.
  assert.equal(first.left, 0);
  assert.equal(first.width, 100);
  assert.equal(second.left, 14); // STAGGER_OFFSET_PCT
  assert.equal(second.width, 86);
  assert.ok(second.z > first.z); // front card must paint on top to be the one fully readable
});

test("layoutTimedEvents falls back to an even column split for 3+-way overlaps", () => {
  const blob = ics(
    "BEGIN:VEVENT\r\nUID:11\r\nDTSTART:20260715T090000Z\r\nDTEND:20260715T100000Z\r\nSUMMARY:A\r\nEND:VEVENT\r\n" +
      "BEGIN:VEVENT\r\nUID:12\r\nDTSTART:20260715T090000Z\r\nDTEND:20260715T100000Z\r\nSUMMARY:B\r\nEND:VEVENT\r\n" +
      "BEGIN:VEVENT\r\nUID:13\r\nDTSTART:20260715T090000Z\r\nDTEND:20260715T100000Z\r\nSUMMARY:C\r\nEND:VEVENT"
  );
  const events = extractEvents([blob], WEEK_RANGE.start, WEEK_RANGE.end, 1, "UTC");
  const boxes = layoutTimedEvents(events, "UTC");
  assert.equal(boxes.length, 3);
  assert.deepEqual(boxes.map((b) => b.left).sort((a, b) => a - b), [0, 33.3, 66.7]);
  assert.ok(boxes.every((b) => b.width < 34)); // even split, not staggered
});

test("layoutTimedEvents cascades a long appointment behind a same-start pair landing near its end", () => {
  // Exactly the real Wednesday case: one long interview block, plus two
  // podiatry appointments both starting at 4:30pm, overlapping its last
  // half hour. Two start times -> two chords -> cascade; the pair chord
  // should still split side by side within itself.
  const blob = ics(
    "BEGIN:VEVENT\r\nUID:16\r\nDTSTART:20260715T090000Z\r\nDTEND:20260715T170000Z\r\nSUMMARY:Interviews\r\nEND:VEVENT\r\n" +
      "BEGIN:VEVENT\r\nUID:17\r\nDTSTART:20260715T163000Z\r\nDTEND:20260715T170000Z\r\nSUMMARY:Podiatry A\r\nEND:VEVENT\r\n" +
      "BEGIN:VEVENT\r\nUID:18\r\nDTSTART:20260715T163000Z\r\nDTEND:20260715T170000Z\r\nSUMMARY:Podiatry B\r\nEND:VEVENT"
  );
  const events = extractEvents([blob], WEEK_RANGE.start, WEEK_RANGE.end, 1, "UTC");
  const boxes = layoutTimedEvents(events, "UTC");
  assert.equal(boxes.length, 3);

  const interviews = boxes.find((b) => b.title === "Interviews");
  const podiatryA = boxes.find((b) => b.title === "Podiatry A");
  const podiatryB = boxes.find((b) => b.title === "Podiatry B");

  // The long appointment is the full-width background.
  assert.equal(interviews.left, 0);
  assert.equal(interviews.width, 100);

  // The pair cascades on top of it (starts at the stagger offset)...
  assert.equal(podiatryA.left, 14);
  assert.equal(podiatryB.left, 57);
  assert.ok(podiatryA.z > interviews.z && podiatryB.z > interviews.z);

  // ...but sits side by side with itself, not on top of itself.
  assert.notEqual(podiatryA.left, podiatryB.left);
  assert.ok(podiatryA.width < 50 && podiatryB.width < 50);
});

test("layoutTimedEvents drops events entirely outside the 7am-7pm window", () => {
  const blob = ics("BEGIN:VEVENT\r\nUID:10\r\nDTSTART:20260715T023000Z\r\nDTEND:20260715T030000Z\r\nSUMMARY:Late night\r\nEND:VEVENT");
  const events = extractEvents([blob], WEEK_RANGE.start, WEEK_RANGE.end, 1, "UTC");
  assert.equal(layoutTimedEvents(events, "UTC").length, 0);
});

test("HOUR_LABELS covers 7am through 6pm (12 hourly rows)", () => {
  assert.equal(HOUR_LABELS.length, 12);
  assert.equal(HOUR_LABELS[0], "7 AM");
  assert.equal(HOUR_LABELS[11], "6 PM");
  assert.equal(HOUR_LABELS[5], "12 PM");
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
    todayParts: { year: 2026, month0: 6, day: 15, hour: 13, minute: 0 },
    tz: "UTC",
  });

  assert.equal(payload.week_days.length, 7);
  assert.equal(payload.week_days[0].date, "2026-07-13"); // Monday first
  assert.equal(payload.weekday_labels[0], "Mon");
  assert.equal(payload.hour_labels.length, 12);

  const wednesday = payload.week_days.find((d) => d.date === "2026-07-15");
  assert.equal(wednesday.is_today, true);
  assert.equal(wednesday.events[0].title, "Dentist");
  assert.ok(wednesday.events[0].bg_shade);

  assert.equal(payload.multiday_events.length, 1);
  assert.equal(payload.multiday_events[0].col, 1); // clipped to Monday, the visible week's first column
  assert.equal(payload.multiday_events[0].span, 2); // only Mon-Tue of the trip fall in this week
  assert.ok(payload.multiday_events[0].bg_shade);

  // 1:00pm -> (13*60 - 7*60) / (12*60) * 100 = 50
  assert.equal(wednesday.now_line_top, 50);
  const otherDay = payload.week_days.find((d) => d.date === "2026-07-13");
  assert.equal(otherDay.now_line_top, null);
});

test("now_line_top rounds to the nearest 15 minutes and hides outside the 7am-7pm window", () => {
  const base = {
    year: 2026,
    month0: 6,
    day: 15,
    events: [],
    calendars: [],
    tz: "UTC",
  };

  // 9:07am rounds to 9:00 -> (9*60-420)/720*100 = 16.67 -> 16.7
  const morning = buildPayload({ ...base, todayParts: { year: 2026, month0: 6, day: 15, hour: 9, minute: 7 } });
  assert.equal(morning.week_days.find((d) => d.is_today).now_line_top, 16.7);

  // 11:00pm is outside the visible 7am-7pm window
  const late = buildPayload({ ...base, todayParts: { year: 2026, month0: 6, day: 15, hour: 23, minute: 0 } });
  assert.equal(late.week_days.find((d) => d.is_today).now_line_top, null);
});

test("weekInstantRange pads a day on each side of the visible Mon-Sun week", () => {
  const { start, end } = weekInstantRange(2026, 6, 15); // Wed Jul 15 -> week of Jul 13-19
  assert.ok(start < new Date("2026-07-13T00:00:00Z"));
  assert.ok(end > new Date("2026-07-20T00:00:00Z"));
});

test("shadeFor gives each calendar a distinct grayscale bg and wraps after 5", () => {
  const shades = [1, 2, 3, 4, 5].map((i) => shadeFor(i).bg);
  assert.equal(new Set(shades).size, 5); // all distinct
  assert.equal(shadeFor(6).bg, shadeFor(1).bg); // wraps for a 6th calendar
});

test("zonedParts reads wall-clock components in the given IANA zone", () => {
  const p = zonedParts(new Date("2026-07-15T23:00:00Z"), "America/New_York");
  assert.equal(p.year, 2026);
  assert.equal(p.month0, 6);
  assert.equal(p.day, 15);
  assert.equal(p.hour, 19);
});
