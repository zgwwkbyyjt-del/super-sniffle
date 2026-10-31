// Personal data the assistant can use: a notes file on disk and a read-only calendar feed.
// Zero dependencies: notes are a JSON file, the calendar is any private iCal (.ics) link.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const MAX_NOTE_LENGTH = 2000;
const MAX_NOTES = 5000;
const CALENDAR_CACHE_MS = 5 * 60 * 1000;
const DAY = 86_400_000;

// ---------- Notes ----------

export function createNotes(file) {
  let queue = Promise.resolve();
  // Serialize every read-modify-write so two requests can't overwrite each other.
  const locked = (fn) => (queue = queue.then(fn, fn));

  async function load() {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  }

  async function save(notes) {
    await mkdir(new URL(".", file), { recursive: true });
    const tmp = new URL(`${file.pathname.split("/").pop()}.tmp`, file);
    await writeFile(tmp, JSON.stringify(notes, null, 2));
    await rename(tmp, file);
  }

  return {
    add: (text) =>
      locked(async () => {
        const clean = String(text || "").trim();
        if (!clean) throw Object.assign(new Error("Note is empty"), { status: 400 });
        if (clean.length > MAX_NOTE_LENGTH) {
          throw Object.assign(new Error(`Note must be ${MAX_NOTE_LENGTH} characters or fewer`), { status: 400 });
        }
        const notes = await load();
        if (notes.length >= MAX_NOTES) throw Object.assign(new Error("Too many notes saved"), { status: 400 });
        const note = { id: randomUUID().slice(0, 8), text: clean, created: new Date().toISOString() };
        notes.push(note);
        await save(notes);
        return note;
      }),

    remove: (id) =>
      locked(async () => {
        const notes = await load();
        const kept = notes.filter((n) => n.id !== id);
        if (kept.length === notes.length) return false;
        await save(kept);
        return true;
      }),

    // Notes containing every word of the query, falling back to any word. Newest first.
    search: async (query = "", limit = 30) => {
      const notes = (await load()).reverse();
      const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return notes.slice(0, limit);
      const hay = (n) => n.text.toLowerCase();
      const all = notes.filter((n) => words.every((w) => hay(n).includes(w)));
      return (all.length ? all : notes.filter((n) => words.some((w) => hay(n).includes(w)))).slice(0, limit);
    },
  };
}

// ---------- Calendar (iCal feed) ----------

export function createCalendar(url, timeZone) {
  let cache = { at: 0, events: null };

  async function events() {
    if (cache.events && Date.now() - cache.at < CALENDAR_CACHE_MS) return cache.events;
    const res = await fetch(url.replace(/^webcal:/i, "https:"));
    if (!res.ok) throw Object.assign(new Error(`Calendar feed returned ${res.status}`), { status: 502 });
    cache = { at: Date.now(), events: parseIcs(await res.text(), timeZone) };
    return cache.events;
  }

  return {
    configured: Boolean(url),
    upcoming: async (days = 7) => {
      if (!url) throw Object.assign(new Error("No calendar connected (set CALENDAR_ICS_URL)"), { status: 503 });
      const from = Date.now();
      const to = from + Math.min(Math.max(Number(days) || 7, 1), 31) * DAY;
      return expand(await events(), from, to, timeZone)
        .slice(0, 60)
        .map((e) => ({
          title: e.summary || "(no title)",
          when: describeWhen(e, timeZone),
          start: new Date(e.start).toISOString(),
          end: new Date(e.end).toISOString(),
          allDay: e.allDay,
          ...(e.location && { location: e.location }),
        }));
    },
  };
}

function describeWhen(e, timeZone) {
  const fmt = (t, opts) => new Intl.DateTimeFormat("en-US", { timeZone, ...opts }).format(t);
  const day = { weekday: "short", month: "short", day: "numeric" };
  if (e.allDay) return `${fmt(e.start, day)} (all day)`;
  const start = fmt(e.start, { ...day, hour: "numeric", minute: "2-digit" });
  return e.end > e.start ? `${start} – ${fmt(e.end, { hour: "numeric", minute: "2-digit" })}` : start;
}

// Offset (ms) of a time zone from UTC at instant t.
function tzOffset(t, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(t).map((p) => [p.type, Number(p.value)]),
  );
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(t / 1000) * 1000;
}

// "Wall clock" times are stored as fake-UTC milliseconds; this converts one to a real instant in timeZone.
function wallToUtc(wall, timeZone) {
  if (timeZone === "UTC") return wall;
  const first = wall - tzOffset(wall, timeZone);
  const second = wall - tzOffset(first, timeZone);
  return second;
}

function validZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function parseLine(line) {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === ":" && !inQuotes) {
      const [name, ...params] = line.slice(0, i).split(";");
      return {
        name: name.toUpperCase(),
        params: Object.fromEntries(params.map((p) => {
          const [k, v = ""] = p.split("=");
          return [k.toUpperCase(), v.replace(/^"|"$/g, "")];
        })),
        value: line.slice(i + 1),
      };
    }
  }
  return null;
}

const unescapeText = (v) => v.replace(/\\([\\,;nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));

// Returns { wall, zone, allDay } for a DTSTART/DTEND/EXDATE-style value.
function parseDate(value, params, defaultZone) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", z] = m;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const allDay = params.VALUE === "DATE" || m[4] === undefined;
  const zone = z ? "UTC" : params.TZID && validZone(params.TZID) ? params.TZID : defaultZone;
  return { wall, zone, allDay };
}

export function parseIcs(text, defaultZone) {
  const events = [];
  let current = null;
  for (const raw of text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    if (raw === "BEGIN:VEVENT") current = { exdates: new Set() };
    else if (raw === "END:VEVENT" && current) {
      if (current.startDate && current.status !== "CANCELLED") {
        const s = current.startDate;
        const start = wallToUtc(s.wall, s.zone);
        let end;
        if (current.endDate) end = wallToUtc(current.endDate.wall, current.endDate.zone);
        else if (current.duration) end = start + current.duration;
        else end = s.allDay ? wallToUtc(s.wall + DAY, s.zone) : start;
        events.push({
          uid: current.uid, summary: current.summary, location: current.location, rrule: current.rrule,
          exdates: current.exdates, recurrenceId: current.recurrenceId ?? null,
          allDay: s.allDay, zone: s.zone, wallStart: s.wall, start, length: Math.max(end - start, 0),
        });
      }
      current = null;
    } else if (current) {
      const line = parseLine(raw);
      if (!line) continue;
      const { name, params, value } = line;
      if (name === "UID") current.uid = value;
      else if (name === "SUMMARY") current.summary = unescapeText(value);
      else if (name === "LOCATION") current.location = unescapeText(value);
      else if (name === "STATUS") current.status = value.toUpperCase();
      else if (name === "RRULE") current.rrule = value;
      else if (name === "DTSTART") current.startDate = parseDate(value, params, defaultZone);
      else if (name === "DTEND") current.endDate = parseDate(value, params, defaultZone);
      else if (name === "DURATION") current.duration = parseDuration(value);
      else if (name === "RECURRENCE-ID") {
        const r = parseDate(value, params, defaultZone);
        if (r) current.recurrenceId = wallToUtc(r.wall, r.zone);
      } else if (name === "EXDATE") {
        for (const v of value.split(",")) {
          const r = parseDate(v, params, defaultZone);
          if (r) current.exdates.add(wallToUtc(r.wall, r.zone));
        }
      }
    }
  }
  return events;
}

function parseDuration(value) {
  const m = value.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [, sign, w = 0, d = 0, h = 0, mi = 0, s = 0] = m;
  return (sign === "-" ? -1 : 1) * (((+w * 7 + +d) * 24 + +h) * 3600 + +mi * 60 + +s) * 1000;
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// Wall-clock start times of a recurring event, in order, from its first occurrence.
// Supports FREQ DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL and weekly BYDAY.
function* occurrences(event) {
  const rule = Object.fromEntries(event.rrule.split(";").map((p) => p.split("=")).map(([k, v]) => [k.toUpperCase(), v]));
  const interval = Math.max(parseInt(rule.INTERVAL, 10) || 1, 1);
  const count = parseInt(rule.COUNT, 10) || Infinity;
  const until = rule.UNTIL ? parseDate(rule.UNTIL, {}, event.zone) : null;
  const untilUtc = until ? wallToUtc(until.allDay ? until.wall + DAY - 1 : until.wall, until.zone) : Infinity;
  const start = event.wallStart;
  const byDay = (rule.BYDAY || "").split(",").map((d) => WEEKDAYS.indexOf(d.slice(-2))).filter((d) => d >= 0);

  let produced = 0;
  for (let step = 0; step < 5000 && produced < count; step++) {
    let candidates;
    if (rule.FREQ === "DAILY") candidates = [start + step * interval * DAY];
    else if (rule.FREQ === "WEEKLY") {
      const weekStart = start + step * interval * 7 * DAY - new Date(start).getUTCDay() * DAY;
      const days = byDay.length ? [...byDay].sort() : [new Date(start).getUTCDay()];
      candidates = days.map((d) => weekStart + d * DAY).filter((t) => t >= start);
    } else if (rule.FREQ === "MONTHLY" || rule.FREQ === "YEARLY") {
      const s = new Date(start);
      const months = step * interval * (rule.FREQ === "YEARLY" ? 12 : 1);
      const t = Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + months, s.getUTCDate(), s.getUTCHours(), s.getUTCMinutes());
      // Skip months that don't have this day (e.g. the 31st).
      candidates = new Date(t).getUTCDate() === s.getUTCDate() ? [t] : [];
    } else {
      yield start;
      return;
    }
    for (const wall of candidates) {
      if (produced >= count || wallToUtc(wall, event.zone) > untilUtc) return;
      produced++;
      yield wall;
    }
  }
}

function expand(events, from, to) {
  const overridden = new Set(events.filter((e) => e.recurrenceId != null).map((e) => `${e.uid}|${e.recurrenceId}`));
  const out = [];
  for (const e of events) {
    if (!e.rrule || e.recurrenceId != null) {
      if (e.start < to && e.start + e.length > from) out.push({ ...e, end: e.start + e.length });
      continue;
    }
    for (const wall of occurrences(e)) {
      const start = wallToUtc(wall, e.zone);
      if (start >= to) break;
      if (start + e.length <= from || e.exdates.has(start) || overridden.has(`${e.uid}|${start}`)) continue;
      out.push({ ...e, start, end: start + e.length });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
