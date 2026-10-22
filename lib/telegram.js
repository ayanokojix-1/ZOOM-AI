// Minimal Telegram Bot API wrapper (plain fetch, no framework).

async function call(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!data.ok) console.error(`telegram ${method} failed:`, data.description);
  return data;
}

// Plain text on purpose: model output isn't guaranteed to be valid Markdown.
const sendMessage = (chat_id, text, extra = {}) =>
  call("sendMessage", { chat_id, text: text.slice(0, 4096), ...extra });

const sendTyping = (chat_id) => call("sendChatAction", { chat_id, action: "typing" });
const deleteMessage = (chat_id, message_id) => call("deleteMessage", { chat_id, message_id });
const answerCallback = (callback_query_id, text) =>
  call("answerCallbackQuery", { callback_query_id, text });
const editMessage = (chat_id, message_id, text) =>
  call("editMessageText", { chat_id, message_id, text, reply_markup: { inline_keyboard: [] } });

module.exports = { call, sendMessage, sendTyping, deleteMessage, answerCallback, editMessage };
