// Meeting create / list / read / update / delete against the deployment's Zoom account.
// Validates everything before calling Zoom; problems throw UserError with a message
// Gemini can relay or act on.
const db = require("./db");
const { zoomRequest } = require("./zoom");
const { UserError } = require("./errors");
const { assertTimezone, parseLocalDateTime, localToUtc, utcToLocal } = require("./zonedTime");

const SCHEDULED_MEETING = 2;
const LIST_TYPES = ["scheduled", "live", "upcoming", "upcoming_meetings", "previous_meetings"];

const DEFAULT_DURATION_MINUTES = 60;
const MEETING_FIELDS = ["title", "startTime", "timezone", "duration", "agenda", "password"];

// ---- Field validation ----------------------------------------------------------

// Rejects anything we don't handle, e.g. Zoom's own "start_time", so typos fail loudly
// instead of being silently ignored.
function assertKnownFields(fields) {
  const unknown = Object.keys(fields).filter((key) => !MEETING_FIELDS.includes(key));
  if (unknown.length) {
    throw new UserError(`Unknown field(s): ${unknown.join(", ")}. Allowed: ${MEETING_FIELDS.join(", ")}`);
  }
}

function validTitle(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new UserError("title must be a non-empty string of up to 200 characters");
  }
  return value.trim();
}

function validDuration(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new UserError("duration must be a positive whole number of minutes");
  }
  return value;
}

function validAgenda(value) {
  if (typeof value !== "string" || value.length > 2000) {
    throw new UserError("agenda must be a string of up to 2000 characters");
  }
  return value;
}

function validPassword(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9@\-_*]{1,10}$/.test(value)) {
    throw new UserError("password: up to 10 chars of a-z A-Z 0-9 @ - _ *");
  }
  return value;
}

// startTime is a local wall-clock time ("2026-10-05T14:30:00") and timezone says where
// ("Africa/Lagos"). They must be sent together: either one alone is ambiguous, and
// changing only one on an update would silently move the meeting.
//
// Returns Zoom's { start_time, timezone } with start_time converted to UTC
// ("2026-10-05T13:30:00Z", no milliseconds). Zoom can parse a local start_time in the
// host's profile timezone instead of `timezone`, which schedules the meeting at the
// wrong moment; a UTC instant can't be misread.
function validSchedule(fields) {
  const hasStart = fields.startTime !== undefined;
  const hasZone = fields.timezone !== undefined;
  if (hasStart !== hasZone) {
    throw new UserError("startTime and timezone must be sent together");
  }
  const timezone = assertTimezone(fields.timezone);
  const instant = localToUtc(parseLocalDateTime(fields.startTime), timezone);
  if (instant.getTime() <= Date.now()) {
    throw new UserError(`${fields.startTime} in ${timezone} is in the past`);
  }
  return { start_time: instant.toISOString().replace(/\.\d{3}Z$/, "Z"), timezone };
}

// Zoom shows meeting IDs with spaces ("812 3456 7890").
function validMeetingId(value) {
  const id = String(value ?? "").replace(/\s/g, "");
  if (!/^\d+$/.test(id)) throw new UserError("Meeting ID must be numeric");
  return id;
}

// ---- Zoom request bodies ---------------------------------------------------------

function buildCreateBody(fields) {
  assertKnownFields(fields);
  if (fields.title === undefined) throw new UserError("title is required");
  if (fields.startTime === undefined || fields.timezone === undefined) {
    throw new UserError("startTime and timezone are required");
  }
  const { start_time, timezone } = validSchedule(fields);

  const zoomBody = {
    topic: validTitle(fields.title),
    type: SCHEDULED_MEETING,
    start_time,
    timezone,
    duration: fields.duration === undefined ? DEFAULT_DURATION_MINUTES : validDuration(fields.duration),
  };
  if (fields.agenda !== undefined) zoomBody.agenda = validAgenda(fields.agenda);
  if (fields.password !== undefined) zoomBody.password = validPassword(fields.password);
  return zoomBody;
}

// Only the fields sent are changed.
function buildUpdateBody(fields) {
  assertKnownFields(fields);
  const zoomBody = {};
  if (fields.title !== undefined) zoomBody.topic = validTitle(fields.title);
  if (fields.startTime !== undefined || fields.timezone !== undefined) {
    const { start_time, timezone } = validSchedule(fields);
    zoomBody.start_time = start_time;
    zoomBody.timezone = timezone;
  }
  if (fields.duration !== undefined) zoomBody.duration = validDuration(fields.duration);
  if (fields.agenda !== undefined) zoomBody.agenda = validAgenda(fields.agenda);
  if (fields.password !== undefined) zoomBody.password = validPassword(fields.password);
  if (!Object.keys(zoomBody).length) throw new UserError("No updatable fields provided");
  return zoomBody;
}

// Zoom meeting -> camelCase. Zoom returns start_time in UTC; startTime is converted to
// the timezone the user scheduled it in (from meeting_zones), since Zoom may label the
// meeting with the host's profile timezone instead.
const fromZoomMeeting = (m, requestedTimezone) => {
  const timezone = requestedTimezone || m.timezone;
  return {
    id: m.id,
    title: m.topic,
    startTime: m.start_time ? utcToLocal(m.start_time, timezone) ?? m.start_time : null,
    timezone,
    duration: m.duration,
    agenda: m.agenda,
    joinUrl: m.join_url,
    startUrl: m.start_url, // host-only link, don't share with invitees
    password: m.password,
    status: m.status,
  };
};

// ---- Operations ------------------------------------------------------------------

// Create: POST /users/me/meetings
async function createMeeting(fields) {
  const zoomBody = buildCreateBody(fields);
  const meeting = await zoomRequest({ method: "POST", path: "/users/me/meetings", body: zoomBody });
  await db.rememberTimezone(meeting.id, zoomBody.timezone);
  return fromZoomMeeting(meeting, zoomBody.timezone);
}

// List: GET /users/me/meetings
async function listMeetings({ type = "upcoming", nextPageToken } = {}) {
  if (!LIST_TYPES.includes(type)) {
    throw new UserError(`type must be one of: ${LIST_TYPES.join(", ")}`);
  }
  const data = await zoomRequest({
    method: "GET",
    path: "/users/me/meetings",
    query: { type, page_size: 30, next_page_token: nextPageToken || undefined },
  });
  const meetings = data.meetings || [];
  const zones = await db.rememberedTimezones(meetings.map((m) => m.id));
  return {
    // Lists leave out the host link and passcode; get_meeting has them.
    meetings: meetings.map((m) => {
      const { startUrl, password, ...rest } = fromZoomMeeting(m, zones[m.id]);
      return rest;
    }),
    totalRecords: data.total_records,
    nextPageToken: data.next_page_token || null,
  };
}

// Read: GET /meetings/{meetingId}
async function getMeeting(meetingId) {
  const meeting = await zoomRequest({ method: "GET", path: `/meetings/${validMeetingId(meetingId)}` });
  const zones = await db.rememberedTimezones([meeting.id]);
  return fromZoomMeeting(meeting, zones[meeting.id]);
}

// Update: PATCH /meetings/{meetingId} (Zoom returns 204, so fetch the updated meeting)
async function updateMeeting(meetingId, fields) {
  const id = validMeetingId(meetingId);
  const zoomBody = buildUpdateBody(fields);
  await zoomRequest({ method: "PATCH", path: `/meetings/${id}`, body: zoomBody });
  if (zoomBody.timezone) await db.rememberTimezone(id, zoomBody.timezone);
  return getMeeting(id);
}

// Delete: DELETE /meetings/{meetingId}
// notify emails registrants/alternative hosts that the meeting was cancelled.
async function deleteMeeting(meetingId, { notify = false } = {}) {
  const id = validMeetingId(meetingId);
  await zoomRequest({
    method: "DELETE",
    path: `/meetings/${id}`,
    query: { cancel_meeting_reminder: notify, schedule_for_reminder: notify },
  });
  await db.forgetTimezone(id);
}

module.exports = { LIST_TYPES, createMeeting, listMeetings, getMeeting, updateMeeting, deleteMeeting };
