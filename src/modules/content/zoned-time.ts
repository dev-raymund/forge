/**
 * Times in a site's time zone (M7-2): what a person types in the schedule dialog is a wall-clock time where the site
 * is (`sites.timezone`, an IANA name, M4-2), never where the server is. It is stored as an instant (UTC) and shown
 * back in that zone, with the zone named. Pure and client-safe: only `Intl`, which knows every zone and its rules.
 *
 * A wall-clock time can fail to name exactly one instant: it does not exist when the clocks jump forward over it, and
 * it happens twice when they go back over it. Both are refused, never guessed.
 */

/** `YYYY-MM-DDTHH:mm`, the value of an `<input type="datetime-local">` without seconds. */
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export type ZonedResult = { ok: true; at: Date } | { ok: false; reason: "malformed" | "nonexistent" | "ambiguous" };

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock time at `instant` in the zone, as milliseconds of a UTC date with those fields. */
function wallClockOf(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(partsFormatter(timeZone).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

/** The zone's offset from UTC at `instant`, in milliseconds (positive east of Greenwich). */
export const offsetAt = (instant: number, timeZone: string): number => wallClockOf(instant, timeZone) - Math.floor(instant / 1000) * 1000;

/** Is this an IANA zone `Intl` knows? */
export function isTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || !timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** A wall-clock time in the zone → the one instant it names, or why there is not exactly one. */
export function zonedToUtc(local: unknown, timeZone: string): ZonedResult {
  const match = typeof local === "string" ? LOCAL.exec(local) : null;
  if (!match || !isTimeZone(timeZone)) return { ok: false, reason: "malformed" };
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wall);
  // Date.UTC rolls 31 February over into March: a date that does not exist is malformed, not March.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || check.getUTCHours() !== hour || year < 1970) {
    return { ok: false, reason: "malformed" };
  }
  // Every offset the zone has within a day either side; any clock change is among them. Each gives a candidate instant,
  // which counts only if the zone really shows this wall-clock time at it.
  const offsets = new Set([-86_400_000, 0, 86_400_000].map((shift) => offsetAt(wall + shift, timeZone)));
  const instants = [...new Set([...offsets].map((offset) => wall - offset))].filter((instant) => wallClockOf(instant, timeZone) === wall);
  if (instants.length === 0) return { ok: false, reason: "nonexistent" };
  if (instants.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, at: new Date(instants[0]!) };
}

/** An instant as `YYYY-MM-DDTHH:mm` in the zone: the value to put back in a datetime-local input. */
export function toLocalInput(at: Date, timeZone: string): string {
  return new Date(wallClockOf(at.getTime(), timeZone)).toISOString().slice(0, 16);
}

/** `UTC+08:00`, `UTC−03:30`, `UTC`: the zone's offset at that instant. */
export function offsetLabel(at: Date, timeZone: string): string {
  const minutes = Math.round(offsetAt(at.getTime(), timeZone) / 60_000);
  if (minutes === 0) return "UTC";
  const abs = Math.abs(minutes);
  return `UTC${minutes < 0 ? "−" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** "Tue, 20 Oct 2026, 09:30 (Asia/Manila, UTC+08:00)": an instant as the site's people read it, its zone named. */
export function formatInZone(at: Date, timeZone: string, locale = "en-GB"): string {
  const text = new Intl.DateTimeFormat(locale, { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  return `${text} (${timeZone}, ${offsetLabel(at, timeZone)})`;
}
