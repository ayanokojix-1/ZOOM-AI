// Access control. Knowing the bot's username is not enough: a Telegram user ID
// must be activated with the secret ACCESS_CODE (/login <code>).
const crypto = require("crypto");
const db = require("./db");

const MAX_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 60 * 60;

const safeEqual = (a, b) => {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const isAuthorized = (userId) => db.isAuthorized(userId);

// Returns { ok, reason }. reason: "locked" | "wrong" | "no-code-configured"
async function login(userId, code) {
  if (!process.env.ACCESS_CODE) return { ok: false, reason: "no-code-configured" };

  if ((await db.loginFailures(userId)) >= MAX_ATTEMPTS) return { ok: false, reason: "locked" };

  if (code && safeEqual(code, process.env.ACCESS_CODE)) {
    await db.authorize(userId);
    return { ok: true };
  }

  await db.recordLoginFailure(userId, LOCKOUT_SECONDS);
  return { ok: false, reason: "wrong" };
}

const logout = (userId) => db.deauthorize(userId);

module.exports = { isAuthorized, login, logout };
