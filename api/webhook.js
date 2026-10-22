// Telegram webhook entry point (Vercel serverless function).
const db = require("../lib/db");
const telegram = require("../lib/telegram");
const { isAuthorized, login, logout } = require("../lib/auth");
const { chat, noteEvent, clearHistory } = require("../lib/agent");
const { deleteMeeting } = require("../lib/meetings");
const { UserError } = require("../lib/errors");

const LOGIN_HINT = "🔒 This bot is private. Send /login followed by your access code.";
const HELP_TEXT = `Hi! I manage your Zoom meetings. Just tell me what you need, e.g.:

- "Book a team call tomorrow at 3pm for 45 minutes"
- "What meetings do I have this week?"
- "Move the team call to 5pm"
- "Send me the link for Friday's meeting"
- "Cancel tomorrow's meeting"

/reset — start a new conversation
/logout — remove your access`;

async function handleLogin(msg, code) {
  const { id: chatId } = msg.chat;
  // Remove the message holding the secret from the chat.
  await telegram.deleteMessage(chatId, msg.message_id);

  if (await isAuthorized(msg.from.id)) {
    return telegram.sendMessage(chatId, "You're already logged in. How can I help?");
  }
  if (!code) return telegram.sendMessage(chatId, LOGIN_HINT);

  const result = await login(msg.from.id, code);
  if (result.ok) {
    return telegram.sendMessage(chatId, `✅ Access granted.\n\n${HELP_TEXT}`);
  }
  const reasons = {
    locked: "Too many failed attempts. Try again in an hour.",
    "no-code-configured": "This bot hasn't been configured yet.",
    wrong: "❌ Wrong access code.",
  };
  return telegram.sendMessage(chatId, reasons[result.reason]);
}

async function handleMessage(msg) {
  if (msg.chat.type !== "private" || !msg.from || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // /login <code> and the /start <code> deep link
  const m = text.match(/^\/(login|start)(?:@\w+)?(?:\s+(.+))?$/i);
  if (m && (m[1].toLowerCase() === "login" || m[2])) return handleLogin(msg, m[2]?.trim());

  if (!(await isAuthorized(msg.from.id))) return telegram.sendMessage(chatId, LOGIN_HINT);

  if (/^\/start(@\w+)?$/i.test(text) || /^\/help(@\w+)?$/i.test(text)) {
    return telegram.sendMessage(chatId, HELP_TEXT);
  }
  if (/^\/reset(@\w+)?$/i.test(text)) {
    await clearHistory(chatId);
    return telegram.sendMessage(chatId, "Conversation cleared.");
  }
  if (/^\/logout(@\w+)?$/i.test(text)) {
    await logout(msg.from.id);
    await clearHistory(chatId);
    return telegram.sendMessage(chatId, "Logged out.");
  }

  await telegram.sendTyping(chatId);
  const reply = await chat(chatId, msg.from.id, text);
  if (reply) await telegram.sendMessage(chatId, reply);
}

async function handleCallback(cb) {
  const [action, id] = String(cb.data || "").split(":");
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;
  if (!chatId || !id || !["c", "x"].includes(action)) return telegram.answerCallback(cb.id);

  if (!(await isAuthorized(cb.from.id))) return telegram.answerCallback(cb.id, "Not authorized.");

  // Atomic claim: a double-tap or Telegram retry gets null.
  const pending = await db.claimPending(id, cb.from.id);
  if (!pending) {
    await telegram.answerCallback(cb.id, "This request expired or was already handled.");
    return telegram.editMessage(chatId, messageId, "⌛ This confirmation is no longer valid.");
  }

  if (action === "x") {
    await telegram.answerCallback(cb.id, "Cancelled");
    await telegram.editMessage(chatId, messageId, `❌ Kept: ${pending.summary}`);
    return noteEvent(chatId, `User cancelled deleting the meeting ${pending.summary} (ID ${pending.meetingId}). It was not deleted.`);
  }

  await telegram.answerCallback(cb.id, "Deleting…");
  await telegram.editMessage(chatId, messageId, `⏳ Deleting: ${pending.summary}`);

  let text;
  try {
    await deleteMeeting(pending.meetingId, { notify: pending.notify });
    text = `🗑 Deleted: ${pending.summary}`;
  } catch (err) {
    if (!(err instanceof UserError)) console.error("delete failed", pending.meetingId, err);
    text = `❌ Couldn't delete: ${pending.summary}\n${err instanceof UserError ? err.message : "Please try again."}`;
  }
  await telegram.editMessage(chatId, messageId, text);
  return noteEvent(chatId, `Delete result for meeting ID ${pending.meetingId}: ${text.split("\n").join(" ")}`);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  // Only Telegram knows this secret (set via setWebhook).
  if (req.headers["x-telegram-bot-api-secret-token"] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).end();
  }

  const update = req.body || {};
  try {
    // Telegram redelivers updates it thinks failed; never process one twice.
    if (!(await db.markUpdateProcessed(update.update_id))) return res.status(200).end();

    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    console.error("webhook error:", err);
    const chatId = update.message?.chat.id || update.callback_query?.message?.chat.id;
    if (chatId) await telegram.sendMessage(chatId, "Something went wrong. Please try again.").catch(() => {});
  }
  // Always 200 so Telegram doesn't hammer us with retries.
  return res.status(200).end();
};
