// Usage: node scripts/set-webhook.js https://your-app.vercel.app
require("dotenv").config();
const { call } = require("../lib/telegram");

(async () => {
  const base = process.argv[2];
  if (!base) throw new Error("Pass your deployment URL, e.g. https://your-app.vercel.app");
  const out = await call("setWebhook", {
    url: `${base.replace(/\/$/, "")}/api/webhook`,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  console.log(out);
})();
