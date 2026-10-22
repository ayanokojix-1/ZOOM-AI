const { UserError } = require("./errors");

// Wall-clock times like "2026-10-05T14:30:00" paired with an IANA timezone like
// "Africa/Lagos". Uses only the built-in Intl API, no date library.

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function assertTimezone(timezone) {
  if (typeof timezone !== "string" || !timezone.includes("/")) {
    throw new UserError("timezone must be an IANA name like Africa/Lagos");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new UserError(`Unknown timezone "${timezone}". Use an IANA name like Africa/Lagos`);
  }
  return timezone;
}

// "2026-10-05T14:30" or "2026-10-05T14:30:00" -> parts. Rejects offsets/Z and impossible dates.
function parseLocalDateTime(value) {
  const match = typeof value === "string" && value.match(LOCAL_DATE_TIME);
  if (!match) {
    throw new UserError(
      "startTime must be a local date-time without offset, like 2026-10-05T14:30:00 (the timezone goes in `timezone`)"
    );
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map((v) => Number(v ?? 0));
  // Date.UTC rolls invalid values over (Feb 30 -> Mar 2), so compare after round-tripping.
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const valid =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day &&
    probe.getUTCHours() === hour &&
    probe.getUTCMinutes() === minute &&
    probe.getUTCSeconds() === second;
  if (!valid) throw new UserError(`${value} is not a real date/time`);
  return { year, month, day, hour, minute, second };
}

// Wall-clock parts of an instant as seen in `timezone`.
function partsInZone(epochMs, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

const asUtcMs = (p) => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
const offsetMs = (epochMs, timezone) => asUtcMs(partsInZone(epochMs, timezone)) - Math.floor(epochMs / 1000) * 1000;

// Local wall-clock time in `timezone` -> the real instant (Date).
function localToUtc(local, timezone) {
  const wallClock = asUtcMs(local);
  let epochMs = wallClock - offsetMs(wallClock, timezone);
  // Second pass in case the offset differs at the actual instant (near DST changes).
  epochMs = wallClock - offsetMs(epochMs, timezone);
  // If converting back doesn't give the same wall-clock time, it doesn't exist in
  // that zone (a clock skipped forward for daylight saving).
  if (asUtcMs(partsInZone(epochMs, timezone)) !== wallClock) {
    throw new UserError(`That time doesn't exist in ${timezone} (daylight-saving change)`);
  }
  return new Date(epochMs);
}

const pad = (n, width = 2) => String(n).padStart(width, "0");
const formatLocal = (p) =>
  `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;

// Instant (e.g. Zoom's "2026-10-05T13:30:00Z") -> "2026-10-05T14:30:00" in `timezone`.
function utcToLocal(isoString, timezone) {
  const epochMs = Date.parse(isoString);
  if (Number.isNaN(epochMs)) return null;
  try {
    return formatLocal(partsInZone(epochMs, timezone));
  } catch {
    return null; // unknown timezone from Zoom; caller still has the UTC value
  }
}

module.exports = { assertTimezone, parseLocalDateTime, localToUtc, utcToLocal, formatLocal };
