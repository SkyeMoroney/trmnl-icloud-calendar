import ICAL from "ical.js";

const WEEKDAY_SUN_FIRST = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_LABELS_MON_FIRST = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// The visible time-grid window (Apple Calendar-style day view): 6am-10pm.
const DAY_START_MIN = 6 * 60;
const DAY_END_MIN = 22 * 60;
const DAY_WINDOW_MIN = DAY_END_MIN - DAY_START_MIN;
const MIN_BOX_HEIGHT_PCT = 4; // keeps very short events visible as a real box
const STAGGER_OFFSET_PCT = 14; // exactly-2-way overlaps cascade instead of splitting

// TRMNL screens render 16 real grayscale levels (not just 1-bit dithering),
// so calendars are told apart by a filled shade instead of a "[1]"/"[2]"
// text prefix. bg/text are paired TRMNL framework utility classes
// (trmnl.com/framework) chosen so the text stays readable on the fill.
const CAL_SHADES = [
  { bg: "bg--gray-15", text: "text--white" },
  { bg: "bg--gray-35", text: "text--black" },
  { bg: "bg--gray-50", text: "text--black" },
  { bg: "bg--gray-65", text: "text--black" },
  { bg: "bg--gray-75", text: "text--black" },
];
export function shadeFor(calIndex) {
  return CAL_SHADES[(calIndex - 1) % CAL_SHADES.length];
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function ymdKey(year, month0, day) {
  return `${year}-${pad(month0 + 1)}-${pad(day)}`;
}

function daysAdd(year, month0, day, n) {
  const d = new Date(Date.UTC(year, month0, day + n));
  return { year: d.getUTCFullYear(), month0: d.getUTCMonth(), day: d.getUTCDate() };
}

// Monday of the week containing (year, month0, day), per ISO week convention.
function mondayOfWeek(year, month0, day) {
  const weekday = new Date(Date.UTC(year, month0, day)).getUTCDay(); // 0=Sun..6=Sat
  const offset = weekday === 0 ? -6 : 1 - weekday;
  return daysAdd(year, month0, day, offset);
}

function weekDayKeys(year, month0, day) {
  const monday = mondayOfWeek(year, month0, day);
  return Array.from({ length: 7 }, (_, i) => {
    const cell = daysAdd(monday.year, monday.month0, monday.day, i);
    return ymdKey(cell.year, cell.month0, cell.day);
  });
}

// Reads a Date instant's Y/M/D/H/M as they appear in an IANA time zone.
export function zonedParts(date, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(get("year")),
    month0: Number(get("month")) - 1,
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
  };
}

export function zonedDateKey(date, tz) {
  const p = zonedParts(date, tz);
  return ymdKey(p.year, p.month0, p.day);
}

function zonedTimeLabel(date, tz) {
  const p = zonedParts(date, tz);
  const h12 = ((p.hour + 11) % 12) + 1;
  return `${h12}:${pad(p.minute)} ${p.hour < 12 ? "AM" : "PM"}`;
}

function formatHourLabel(hour24) {
  const h12 = ((hour24 + 11) % 12) + 1;
  return `${h12} ${hour24 < 12 ? "AM" : "PM"}`;
}

// One label per hour row, 6am through 9pm (the last of the 16 one-hour rows
// spans 9pm-10pm).
export const HOUR_LABELS = Array.from({ length: 16 }, (_, i) => formatHourLabel(6 + i));

// The UTC instant range that covers the visible Mon-Sun week for
// (year, month0, day), padded a day on each side to absorb time zone shifts.
export function weekInstantRange(year, month0, day) {
  const monday = mondayOfWeek(year, month0, day);
  const start = daysAdd(monday.year, monday.month0, monday.day, -1);
  const end = daysAdd(monday.year, monday.month0, monday.day, 8);
  return {
    start: new Date(Date.UTC(start.year, start.month0, start.day)),
    end: new Date(Date.UTC(end.year, end.month0, end.day)),
  };
}

// Parses one calendar's ICS blobs into flat events within [rangeStart, rangeEnd),
// expanding recurrences. All-day events (single or multi-day) and any event
// spanning more than one calendar day are flagged `isBanner` so callers can
// render them as a top banner row, like iCal's week view.
export function extractEvents(icsBlobs, rangeStart, rangeEnd, calIndex, tz) {
  const rangeStartT = ICAL.Time.fromJSDate(rangeStart, true);
  const rangeEndT = ICAL.Time.fromJSDate(rangeEnd, true);
  const events = [];

  for (const icsText of icsBlobs) {
    let comp;
    try {
      comp = new ICAL.Component(ICAL.parse(icsText));
    } catch {
      continue; // skip a malformed blob rather than fail the whole calendar
    }
    for (const vevent of comp.getAllSubcomponents("vevent")) {
      let event;
      try {
        event = new ICAL.Event(vevent);
      } catch {
        continue;
      }
      const title = event.summary || "(untitled)";
      const allDay = event.startDate?.isDate ?? false;
      let durationSeconds = event.duration ? event.duration.toSeconds() : 0;
      if (allDay) durationSeconds = Math.max(durationSeconds, 86400); // guard malformed all-day events with no/zero DTEND

      const pushOccurrence = (icalTime) => {
        let date, end, dayKey, endDayKey, timeLabel;
        if (allDay) {
          // VALUE=DATE times are "floating" (no zone) — ICAL.Time#toJSDate would
          // silently reinterpret them in the runtime's local timezone, shifting
          // the day. Read year/month/day directly instead; they need no zone math.
          dayKey = ymdKey(icalTime.year, icalTime.month - 1, icalTime.day);
          const durationDays = Math.round(durationSeconds / 86400) || 1;
          // DTEND for all-day events is exclusive per RFC5545 (e.g. Mon-Wed -> DTEND Thu).
          const endInclusive = daysAdd(icalTime.year, icalTime.month - 1, icalTime.day, durationDays - 1);
          endDayKey = ymdKey(endInclusive.year, endInclusive.month0, endInclusive.day);
          timeLabel = "All day";
          date = new Date(Date.UTC(icalTime.year, icalTime.month - 1, icalTime.day));
          end = null;
        } else {
          date = icalTime.toJSDate();
          end = new Date(date.getTime() + durationSeconds * 1000);
          // Exclusive-end boundary: an event ending exactly at midnight
          // (e.g. 11pm-12am) shouldn't count as touching the next day.
          dayKey = zonedDateKey(date, tz);
          endDayKey = zonedDateKey(new Date(end.getTime() - 1), tz);
          timeLabel = zonedTimeLabel(date, tz);
        }
        events.push({
          date,
          end,
          dayKey,
          endDayKey,
          timeLabel,
          allDay,
          isBanner: allDay || endDayKey > dayKey,
          title,
          calIndex,
        });
      };

      if (event.isRecurring()) {
        const iterator = event.iterator();
        let occurrence;
        // ponytail: caps expansion at 500 occurrences to bound worst-case CPU on pathological RRULEs
        for (let i = 0; i < 500 && (occurrence = iterator.next()); i++) {
          if (occurrence.compare(rangeEndT) >= 0) break;
          if (occurrence.compare(rangeStartT) >= 0) pushOccurrence(occurrence);
        }
      } else if (event.startDate) {
        if (event.startDate.compare(rangeStartT) >= 0 && event.startDate.compare(rangeEndT) < 0) {
          pushOccurrence(event.startDate);
        }
      }
    }
  }
  return events;
}

// Positions one day's timed events as boxes in the 6am-10pm grid: top/height
// from start/end time, left/width/z from a greedy column-packing pass so
// overlapping events don't stack illegibly. A genuine pair (exactly 2 events)
// starting at different times cascades (nearly full width, later one layered
// on top) since that reads as "one nests inside the other"; a pair starting
// at the same time splits side by side instead, reading as parallel options.
// 3+-way overlaps always fall back to an even column split, since staggered
// peeks of 2-3 chars each get visually ambiguous once there's more than one
// seam to spot.
// ponytail: this exists — approximates each overlap cluster with one shared
// column count rather than a fully optimal skyline packing; fine for the
// handful of concurrent events a family calendar actually has.
export function layoutTimedEvents(dayEvents, tz) {
  const withMinutes = dayEvents
    .map((ev) => {
      const startP = zonedParts(ev.date, tz);
      const endP = zonedParts(ev.end, tz);
      const startMin = startP.hour * 60 + startP.minute;
      const endMin = Math.max(endP.hour * 60 + endP.minute, startMin + 15); // guard zero/negative-duration entries
      return { ...ev, startMin, endMin };
    })
    .map((ev) => ({
      ...ev,
      clampedStart: Math.max(ev.startMin, DAY_START_MIN),
      clampedEnd: Math.min(ev.endMin, DAY_END_MIN),
    }))
    .filter((ev) => ev.clampedStart < ev.clampedEnd) // drop events entirely outside the visible window
    .sort((a, b) => a.clampedStart - b.clampedStart || a.clampedEnd - b.clampedEnd);

  const laidOut = [];
  let cluster = [];
  let clusterEnd = -Infinity;
  let columnEnds = [];

  const finalizeCluster = () => {
    const numCols = columnEnds.length || 1;
    // Cascading only makes sense for a genuine pair: two events that start
    // at the same time read as parallel options (split side by side), while
    // two starting at different times read as one nesting inside the other
    // (cascade). 3+-way overlaps always fall back to an even split.
    const pairwise = cluster.length === 2;
    const sameStart = pairwise && cluster[0].clampedStart === cluster[1].clampedStart;
    for (const ev of cluster) laidOut.push({ ...ev, numCols, pairwise, sameStart });
    cluster = [];
    columnEnds = [];
  };

  for (const ev of withMinutes) {
    if (ev.clampedStart >= clusterEnd) {
      finalizeCluster();
      clusterEnd = -Infinity;
    }
    let col = columnEnds.findIndex((end) => end <= ev.clampedStart);
    if (col === -1) {
      col = columnEnds.length;
      columnEnds.push(ev.clampedEnd);
    } else {
      columnEnds[col] = ev.clampedEnd;
    }
    cluster.push({ ...ev, col });
    clusterEnd = Math.max(clusterEnd, ev.clampedEnd);
  }
  finalizeCluster();

  return laidOut.map((ev) => {
    const shade = shadeFor(ev.calIndex);
    let left, width;
    if (ev.pairwise && !ev.sameStart) {
      left = ev.col * STAGGER_OFFSET_PCT;
      width = 100 - left;
    } else {
      const colWidth = 100 / ev.numCols;
      left = ev.col * colWidth;
      width = Math.max(colWidth - 2, 4); // small gutter between adjacent columns
    }
    return {
      title: ev.title,
      cal: ev.calIndex,
      bg_shade: shade.bg,
      text_shade: shade.text,
      time: ev.timeLabel,
      top: round1(((ev.clampedStart - DAY_START_MIN) / DAY_WINDOW_MIN) * 100),
      height: round1(Math.max(((ev.clampedEnd - ev.clampedStart) / DAY_WINDOW_MIN) * 100, MIN_BOX_HEIGHT_PCT)),
      left: round1(left),
      width: round1(width),
      z: ev.col,
    };
  });
}

// Position of the "now" line within the 6am-10pm grid, rounded to the
// nearest 15 minutes since that's how often the plugin actually refreshes —
// showing it to exact-minute precision would just look stale between polls.
// Returns null when "now" falls outside the visible window.
function nowLineTop(todayParts) {
  const rawMin = todayParts.hour * 60 + todayParts.minute;
  const rounded = Math.round(rawMin / 15) * 15;
  if (rounded < DAY_START_MIN || rounded > DAY_END_MIN) return null;
  return round1(((rounded - DAY_START_MIN) / DAY_WINDOW_MIN) * 100);
}

function buildWeekDays(year, month0, day, timedEventsByDay, todayKey, tz, todayParts) {
  const monday = mondayOfWeek(year, month0, day);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const cell = daysAdd(monday.year, monday.month0, monday.day, i);
    const key = ymdKey(cell.year, cell.month0, cell.day);
    const isToday = key === todayKey;
    days.push({
      date: key,
      day: cell.day,
      weekday: WEEKDAY_LABELS_MON_FIRST[i],
      is_today: isToday,
      now_line_top: isToday ? nowLineTop(todayParts) : null,
      events: layoutTimedEvents(timedEventsByDay.get(key) || [], tz),
    });
  }
  return days;
}

// Multi-day/all-day events as horizontal bars, clipped to the visible week
// and positioned via CSS grid-column so overlapping bars stack automatically.
function buildMultidayBars(events, weekKeys) {
  const weekStartKey = weekKeys[0];
  const weekEndKey = weekKeys[6];
  const bars = [];
  for (const ev of events) {
    if (!ev.isBanner) continue;
    if (ev.endDayKey < weekStartKey || ev.dayKey > weekEndKey) continue; // no overlap with visible week
    const clippedStart = ev.dayKey < weekStartKey ? weekStartKey : ev.dayKey;
    const clippedEnd = ev.endDayKey > weekEndKey ? weekEndKey : ev.endDayKey;
    const startCol = weekKeys.indexOf(clippedStart) + 1;
    const endCol = weekKeys.indexOf(clippedEnd) + 1;
    const shade = shadeFor(ev.calIndex);
    bars.push({
      title: ev.title,
      cal: ev.calIndex,
      bg_shade: shade.bg,
      text_shade: shade.text,
      col: startCol,
      span: endCol - startCol + 1,
    });
  }
  bars.sort((a, b) => a.col - b.col || b.span - a.span);
  return bars;
}

function formatWeekLabel(weekKeys) {
  const [y1, m1, d1] = weekKeys[0].split("-").map(Number);
  const [y2, m2, d2] = weekKeys[6].split("-").map(Number);
  const start = `${MONTH_ABBR[m1 - 1]} ${d1}`;
  if (y1 === y2 && m1 === m2) return `${start} – ${d2}, ${y2}`;
  if (y1 === y2) return `${start} – ${MONTH_ABBR[m2 - 1]} ${d2}, ${y2}`;
  return `${start}, ${y1} – ${MONTH_ABBR[m2 - 1]} ${d2}, ${y2}`;
}

function dayLabel(dayKey, todayKey, tomorrowKey) {
  if (dayKey === todayKey) return "Today";
  if (dayKey === tomorrowKey) return "Tomorrow";
  const [y, m, d] = dayKey.split("-").map(Number);
  const weekday = WEEKDAY_SUN_FIRST[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday} ${d}`;
}

export function buildPayload({ year, month0, day, events, calendars, todayParts, tz }) {
  const todayKey = ymdKey(todayParts.year, todayParts.month0, todayParts.day);
  const tomorrow = daysAdd(todayParts.year, todayParts.month0, todayParts.day, 1);
  const tomorrowKey = ymdKey(tomorrow.year, tomorrow.month0, tomorrow.day);

  const timedEventsByDay = new Map();
  for (const ev of events) {
    if (ev.isBanner) continue;
    if (!timedEventsByDay.has(ev.dayKey)) timedEventsByDay.set(ev.dayKey, []);
    timedEventsByDay.get(ev.dayKey).push(ev);
  }

  const weekKeys = weekDayKeys(year, month0, day);
  const week_days = buildWeekDays(year, month0, day, timedEventsByDay, todayKey, tz, todayParts);
  const multiday_events = buildMultidayBars(events, weekKeys);

  const next_events = [...events]
    .filter((ev) => ev.dayKey >= todayKey)
    .sort((a, b) => a.date - b.date)
    .slice(0, 8)
    .map((ev) => {
      const shade = shadeFor(ev.calIndex);
      return {
        label: dayLabel(ev.dayKey, todayKey, tomorrowKey),
        time: ev.timeLabel,
        title: ev.title,
        cal: ev.calIndex,
        bg_shade: shade.bg,
        text_shade: shade.text,
      };
    });

  return {
    has_data: true,
    period_label: formatWeekLabel(weekKeys),
    weekday_labels: WEEKDAY_LABELS_MON_FIRST,
    hour_labels: HOUR_LABELS,
    calendars: calendars.map((c) => {
      const shade = shadeFor(c.index);
      return { ...c, bg_shade: shade.bg, text_shade: shade.text };
    }),
    week_days,
    multiday_events,
    next_events,
  };
}
