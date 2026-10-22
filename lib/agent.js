// Gemini agent: chat history in Postgres, tool loop, and the delete confirmation gate.
const crypto = require("crypto");
const { GoogleGenAI, Type } = require("@google/genai");
const db = require("./db");
const meetings = require("./meetings");
const telegram = require("./telegram");
const { UserError } = require("./errors");
const { utcToLocal } = require("./zonedTime");

const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const DEFAULT_TIMEZONE = process.env.TIMEZONE || "Africa/Tunis";
const HISTORY_LIMIT = 24; // contents entries kept per chat
const PENDING_TTL = 60 * 10;
const MAX_TOOL_ROUNDS = 5;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const meetingIdParam = {
  type: Type.STRING,
  description: "Zoom meeting ID exactly as returned by list_meetings or create_meeting. Never invent one.",
};
const startTimeParam = {
  type: Type.STRING,
  description: 'Local wall-clock start time in `timezone`, format YYYY-MM-DDTHH:mm:ss, e.g. "2026-10-23T15:00:00". No Z or offset.',
};
const timezoneParam = {
  type: Type.STRING,
  description: `IANA timezone such as "Europe/London". Leave it out to use the default (${DEFAULT_TIMEZONE}).`,
};

const tools = [
  {
    functionDeclarations: [
      {
        name: "create_meeting",
        description: "Schedules a new Zoom meeting and returns it with its join link and passcode.",
        parameters: {
          type: Type.OBJECT,
          required: ["title", "startTime"],
          properties: {
            title: { type: Type.STRING, description: "Meeting topic, up to 200 characters" },
            startTime: startTimeParam,
            timezone: timezoneParam,
            duration: { type: Type.INTEGER, description: "Length in minutes. Defaults to 60." },
            agenda: { type: Type.STRING, description: "Optional description, up to 2000 characters" },
            password: { type: Type.STRING, description: "Optional passcode, up to 10 chars of a-z A-Z 0-9 @ - _ *. Zoom generates one if left out." },
          },
        },
      },
      {
        name: "list_meetings",
        description: "Lists meetings on the Zoom account (up to 30 per page). Results have no passcode or host link; use get_meeting for those.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            type: {
              type: Type.STRING,
              enum: meetings.LIST_TYPES,
              description: "upcoming (default): scheduled meetings from now on; live: running now; previous_meetings: past ones; scheduled: all scheduled ones.",
            },
            nextPageToken: { type: Type.STRING, description: "From a previous list_meetings result, to get the next page" },
          },
        },
      },
      {
        name: "get_meeting",
        description: "Gets one meeting's full details: time, duration, agenda, join link, passcode and host start link.",
        parameters: { type: Type.OBJECT, required: ["meetingId"], properties: { meetingId: meetingIdParam } },
      },
      {
        name: "update_meeting",
        description:
          "Changes an existing meeting right away. Only include the fields that are changing; omitted fields stay as they are. Returns the updated meeting.",
        parameters: {
          type: Type.OBJECT,
          required: ["meetingId"],
          properties: {
            meetingId: meetingIdParam,
            title: { type: Type.STRING },
            startTime: { ...startTimeParam, description: `${startTimeParam.description} Only if the time is changing.` },
            timezone: { ...timezoneParam, description: "Only if the user names a different timezone. Leave it out to keep the meeting's current one." },
            duration: { type: Type.INTEGER, description: "New length in minutes" },
            agenda: { type: Type.STRING },
            password: { type: Type.STRING, description: "New passcode, up to 10 chars of a-z A-Z 0-9 @ - _ *" },
          },
        },
      },
      {
        name: "delete_meeting",
        description:
          "Asks the user to confirm deleting a meeting. This does NOT delete anything by itself: it shows the user a Confirm/Cancel button with the meeting's details.",
        parameters: {
          type: Type.OBJECT,
          required: ["meetingId"],
          properties: {
            meetingId: meetingIdParam,
            notify: { type: Type.BOOLEAN, description: "Email registrants a cancellation notice. Only true if the user asks for it." },
          },
        },
      },
    ],
  },
];

// Rebuilt per message so "today" is always correct.
function systemInstruction() {
  const now = new Date();
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: DEFAULT_TIMEZONE, weekday: "long" }).format(now);
  const localNow = utcToLocal(now.toISOString(), DEFAULT_TIMEZONE);

  return `You are a Zoom meeting assistant on Telegram. You schedule and manage meetings on the user's own Zoom account. You only help with Zoom meetings; politely decline anything else.

Current date and time: ${weekday} ${localNow} (${DEFAULT_TIMEZONE}).

Rules:
- Keep responses short — this is a chat interface. Plain text only: no Markdown, no asterisks, no bold. Use simple dashes or emoji for structure.
- Show dates and times in a friendly way, e.g. "Thu 23 Oct, 3:00 PM". Never show raw ISO strings.
- Work out relative dates ("tomorrow", "next Monday", "in 2 hours") from the current date and time above.
- Times are in ${DEFAULT_TIMEZONE} unless the user names another place or timezone (e.g. "3pm London time"). Then pass that IANA timezone for that meeting only, and mention the timezone in your reply.
- Never guess a date or time. If the user hasn't said when, ask. If it's ambiguous (e.g. "at 7" could be AM or PM), ask.
- If the user gives no title, ask for one in a few words. If they don't care, use "Meeting".
- If the user doesn't say how long, use 60 minutes and mention it.
- Never guess or invent a meeting ID. When the user refers to a meeting by its title, day or time ("the 3pm one", "tomorrow's call"), call list_meetings and match it. If more than one meeting matches, ask which one.
- After creating a meeting, reply with: title, date and time, duration, join link and passcode, ready to forward to guests.
- The host start link (startUrl) starts the meeting as the account owner. Only share it if the user asks for the host or start link, and warn them not to send it to guests.
- update_meeting changes the meeting immediately. Pass only the fields that are changing. For "move it 1 hour later" or "same time on Friday", work out the new start time from the meeting's current start time (call get_meeting first if you don't have it).
- delete_meeting does not delete anything. It shows the user a Confirm/Cancel button. After calling it, tell the user in one short line to tap Confirm. Never say a meeting was deleted — you will be told the result separately.
- Handle one deletion at a time.
- When listing meetings, show one line per meeting: title — date and time — duration. Say plainly if there are none.
- If a tool returns an error, tell the user plainly in your own words. If the error is something you can fix (e.g. a time in the past, an invalid passcode), ask the user or fix it. Don't make up meetings or links.`;
}

// ---- history ---------------------------------------------------------------

async function saveHistory(chatId, contents) {
  let trimmed = contents.slice(-HISTORY_LIMIT);
  // Must start on a plain user text turn, never on an orphaned tool result.
  const start = trimmed.findIndex((c) => c.role === "user" && c.parts.some((p) => p.text));
  trimmed = start === -1 ? [] : trimmed.slice(start);
  await db.saveHistory(chatId, trimmed);
}

// Lets non-model events (e.g. a delete result) show up in the conversation.
async function noteEvent(chatId, text) {
  const history = await db.loadHistory(chatId);
  history.push({ role: "user", parts: [{ text: `[system notice] ${text}` }] });
  await saveHistory(chatId, history);
}

const clearHistory = (chatId) => db.clearHistory(chatId);

// ---- tools -----------------------------------------------------------------

// "Thu 23 Oct, 3:00 PM (Africa/Tunis)" for confirmation messages.
function friendlyTime(meeting) {
  if (!meeting.startTime) return "no fixed time";
  const [date, time] = meeting.startTime.split("T");
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const asUtc = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(asUtc);
  return `${formatted} (${meeting.timezone})`;
}

// Drops fields Gemini left empty, so "not changing" never reaches validation as "".
const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));

async function runTool(call, ctx) {
  const { name, args = {} } = call;

  if (name === "create_meeting") {
    return meetings.createMeeting(defined({ ...args, timezone: args.timezone || DEFAULT_TIMEZONE }));
  }

  if (name === "list_meetings") return meetings.listMeetings(defined(args));
  if (name === "get_meeting") return meetings.getMeeting(args.meetingId);

  if (name === "update_meeting") {
    const { meetingId, ...fields } = defined(args);
    // A new time without a timezone keeps the timezone the meeting was booked in.
    if (fields.startTime && !fields.timezone) {
      const zones = await db.rememberedTimezones([String(meetingId).replace(/\s/g, "")]);
      fields.timezone = Object.values(zones)[0] || DEFAULT_TIMEZONE;
    }
    return meetings.updateMeeting(meetingId, fields);
  }

  if (name === "delete_meeting") {
    if (ctx.pendingCreated) {
      return { error: "A confirmation is already waiting for the user. Handle one deletion at a time." };
    }
    // Also checks the meeting exists before offering to delete it.
    const meeting = await meetings.getMeeting(args.meetingId);
    const notify = args.notify === true;
    const summary = `"${meeting.title}" — ${friendlyTime(meeting)}`;

    const id = crypto.randomUUID();
    await db.createPending(id, ctx.userId, { type: "delete_meeting", meetingId: String(meeting.id), notify, summary }, PENDING_TTL);
    await telegram.sendMessage(
      ctx.chatId,
      `Delete this meeting?\n\n${summary}\nMeeting ID: ${meeting.id}${notify ? "\nRegistrants will be emailed a cancellation notice." : ""}`,
      { reply_markup: { inline_keyboard: [[{ text: "🗑 Confirm delete", callback_data: `c:${id}` }, { text: "❌ Cancel", callback_data: `x:${id}` }]] } }
    );
    ctx.pendingCreated = true;
    return { status: "awaiting_user_confirmation", note: "Confirmation buttons were sent. Tell the user to tap Confirm." };
  }

  return { error: `Unknown tool ${name}` };
}

// ---- main entry ------------------------------------------------------------

async function chat(chatId, userId, text) {
  const contents = await db.loadHistory(chatId);
  contents.push({ role: "user", parts: [{ text }] });

  const ctx = { chatId, userId, pendingCreated: false };
  const config = { tools, systemInstruction: systemInstruction() };
  let reply = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await ai.models.generateContent({ model: MODEL, contents, config });

    const content = response.candidates?.[0]?.content;
    if (!content?.parts?.length) {
      reply = "Sorry, I couldn't process that. Please try again.";
      break;
    }
    contents.push(content); // keep as-is (thought signatures matter)

    const calls = content.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    if (!calls.length) {
      reply = content.parts.map((p) => p.text || "").join("").trim();
      break;
    }

    const responses = [];
    for (const call of calls) {
      let result;
      try {
        result = await runTool(call, ctx);
      } catch (err) {
        if (err instanceof UserError) {
          result = { error: err.message };
        } else {
          console.error(`tool ${call.name} threw:`, err);
          result = { error: "Tool failed. Tell the user to try again shortly." };
        }
      }
      responses.push({ functionResponse: { name: call.name, response: result } });
    }
    contents.push({ role: "user", parts: responses });
  }

  await saveHistory(chatId, contents);
  return reply || "Sorry, that took too long. Please try again.";
}

module.exports = { chat, noteEvent, clearHistory };
