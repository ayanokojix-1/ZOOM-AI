// Postgres holds all state. One database is shared by every customer's deployment, so
// every row carries bot_id (the numeric part of TELEGRAM_BOT_TOKEN, unique per bot) and
// every query filters on it. Use a *pooled* connection string (Neon: host contains "-pooler").
const { Pool, types } = require("pg");

// Telegram IDs fit safely in a JS number; don't return BIGINT as strings.
types.setTypeParser(20, Number);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 3,
});

const BOT_ID = Number(String(process.env.TELEGRAM_BOT_TOKEN || "").split(":")[0]) || null;

const HISTORY_TTL = "24 hours";
const PROCESSED_UPDATE_TTL = "1 day";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_history (
    bot_id     BIGINT NOT NULL,
    chat_id    BIGINT NOT NULL,
    contents   JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (bot_id, chat_id)
  );

  -- Telegram users who unlocked the bot with /login <ACCESS_CODE>.
  CREATE TABLE IF NOT EXISTS authorized_users (
    bot_id     BIGINT NOT NULL,
    user_id    BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (bot_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS login_failures (
    bot_id     BIGINT NOT NULL,
    user_id    BIGINT NOT NULL,
    count      INTEGER NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (bot_id, user_id)
  );

  -- Actions waiting for a Confirm/Cancel tap (e.g. deleting a meeting).
  CREATE TABLE IF NOT EXISTS pending_actions (
    id         TEXT PRIMARY KEY,
    bot_id     BIGINT NOT NULL,
    user_id    BIGINT NOT NULL,
    data       JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
  );

  -- Telegram redelivers updates it thinks failed; each one is handled once.
  CREATE TABLE IF NOT EXISTS processed_updates (
    bot_id     BIGINT NOT NULL,
    update_id  BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (bot_id, update_id)
  );

  -- The timezone each meeting was scheduled in. Zoom may label meetings with the host's
  -- profile timezone instead, so this is used to show times the way the user set them.
  CREATE TABLE IF NOT EXISTS meeting_zones (
    bot_id     BIGINT NOT NULL,
    meeting_id BIGINT NOT NULL,
    timezone   TEXT NOT NULL,
    PRIMARY KEY (bot_id, meeting_id)
  );
`;

// Idempotent; runs once per cold start. Retried on the next query if it fails.
let ready = null;
function ensureSchema() {
  ready ??= pool.query(SCHEMA).catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

async function q(text, params) {
  if (!BOT_ID) throw new Error("TELEGRAM_BOT_TOKEN is missing or malformed");
  await ensureSchema();
  return pool.query(text, params);
}

// --- chat history -----------------------------------------------------------------------

async function loadHistory(chatId) {
  const { rows } = await q(
    `SELECT contents FROM chat_history
     WHERE bot_id = $1 AND chat_id = $2 AND updated_at > now() - interval '${HISTORY_TTL}'`,
    [BOT_ID, chatId]
  );
  return rows[0]?.contents || [];
}

async function saveHistory(chatId, contents) {
  await q(
    `INSERT INTO chat_history (bot_id, chat_id, contents, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (bot_id, chat_id) DO UPDATE SET contents = EXCLUDED.contents, updated_at = now()`,
    [BOT_ID, chatId, JSON.stringify(contents)]
  );
}

async function clearHistory(chatId) {
  await q("DELETE FROM chat_history WHERE bot_id = $1 AND chat_id = $2", [BOT_ID, chatId]);
}

// --- logins -------------------------------------------------------------------------------

async function isAuthorized(userId) {
  const { rowCount } = await q("SELECT 1 FROM authorized_users WHERE bot_id = $1 AND user_id = $2", [BOT_ID, userId]);
  return rowCount > 0;
}

async function authorize(userId) {
  await q("INSERT INTO authorized_users (bot_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [BOT_ID, userId]);
  await q("DELETE FROM login_failures WHERE bot_id = $1 AND user_id = $2", [BOT_ID, userId]);
}

async function deauthorize(userId) {
  await q("DELETE FROM authorized_users WHERE bot_id = $1 AND user_id = $2", [BOT_ID, userId]);
}

async function loginFailures(userId) {
  const { rows } = await q(
    "SELECT count FROM login_failures WHERE bot_id = $1 AND user_id = $2 AND expires_at > now()",
    [BOT_ID, userId]
  );
  return rows[0]?.count || 0;
}

// The lockout window restarts on every failure (like a Redis INCR + EXPIRE).
async function recordLoginFailure(userId, lockoutSeconds) {
  await q(
    `INSERT INTO login_failures (bot_id, user_id, count, expires_at)
     VALUES ($1, $2, 1, now() + make_interval(secs => $3))
     ON CONFLICT (bot_id, user_id) DO UPDATE SET
       count = CASE WHEN login_failures.expires_at > now() THEN login_failures.count + 1 ELSE 1 END,
       expires_at = EXCLUDED.expires_at`,
    [BOT_ID, userId, lockoutSeconds]
  );
}

// --- pending confirmations ----------------------------------------------------------------

async function createPending(id, userId, data, ttlSeconds) {
  await q(
    `INSERT INTO pending_actions (id, bot_id, user_id, data, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
    [id, BOT_ID, userId, JSON.stringify(data), ttlSeconds]
  );
}

// Atomic: a double-tap or Telegram retry gets null. Only the user it was created for can claim it.
async function claimPending(id, userId) {
  const { rows } = await q(
    `DELETE FROM pending_actions
     WHERE id = $1 AND bot_id = $2 AND user_id = $3 AND expires_at > now()
     RETURNING data`,
    [id, BOT_ID, userId]
  );
  return rows[0]?.data || null;
}

// --- update de-dupe -------------------------------------------------------------------------

// True the first time an update is seen. Occasionally clears out expired rows of every bot.
async function markUpdateProcessed(updateId) {
  const { rowCount } = await q(
    "INSERT INTO processed_updates (bot_id, update_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [BOT_ID, updateId]
  );
  if (Math.random() < 0.02) cleanup().catch((e) => console.error("db cleanup failed:", e.message));
  return rowCount === 1;
}

async function cleanup() {
  await q(`DELETE FROM processed_updates WHERE created_at < now() - interval '${PROCESSED_UPDATE_TTL}'`);
  await q(`DELETE FROM chat_history WHERE updated_at < now() - interval '${HISTORY_TTL}'`);
  await q("DELETE FROM pending_actions WHERE expires_at < now()");
  await q("DELETE FROM login_failures WHERE expires_at < now()");
}

// --- meeting timezones ----------------------------------------------------------------------

async function rememberTimezone(meetingId, timezone) {
  await q(
    `INSERT INTO meeting_zones (bot_id, meeting_id, timezone) VALUES ($1, $2, $3)
     ON CONFLICT (bot_id, meeting_id) DO UPDATE SET timezone = EXCLUDED.timezone`,
    [BOT_ID, meetingId, timezone]
  );
}

// meetingId -> timezone the user scheduled it in
async function rememberedTimezones(meetingIds) {
  if (!meetingIds.length) return {};
  const { rows } = await q(
    "SELECT meeting_id, timezone FROM meeting_zones WHERE bot_id = $1 AND meeting_id = ANY($2::bigint[])",
    [BOT_ID, meetingIds.map(String)]
  );
  return Object.fromEntries(rows.map((r) => [r.meeting_id, r.timezone]));
}

async function forgetTimezone(meetingId) {
  await q("DELETE FROM meeting_zones WHERE bot_id = $1 AND meeting_id = $2", [BOT_ID, meetingId]);
}

module.exports = {
  loadHistory,
  saveHistory,
  clearHistory,
  isAuthorized,
  authorize,
  deauthorize,
  loginFailures,
  recordLoginFailure,
  createPending,
  claimPending,
  markUpdateProcessed,
  rememberTimezone,
  rememberedTimezones,
  forgetTimezone,
};
