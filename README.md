# Zoom-AI (Telegram + Zoom + Gemini)

Telegram bot (webhook, deployable on Vercel) that schedules and manages Zoom meetings, driven by Gemini.
The customer chats in plain language ("book a team call tomorrow at 3pm", "move it to 5pm", "cancel Friday's meeting"); deleting a meeting only happens after they tap a Confirm button.

## Features
- **Create:** title, date/time, duration (default 60 min), optional agenda and passcode. Replies with the join link and passcode, ready to forward.
- **List:** upcoming (default), live, previous or all scheduled meetings.
- **Details:** one meeting's time, links and passcode. The host start link is only shown when asked for.
- **Update:** title, time, timezone, duration, agenda or passcode. Applied immediately.
- **Delete:** shows a Confirm/Cancel button first. Can email registrants a cancellation notice if asked.
- **Timezones:** times are in `TIMEZONE` unless the customer names another ("3pm London time"). Each meeting is shown in the timezone it was booked in.
- **Commands:** `/login <code>`, `/logout`, `/reset`, `/help`.

## How deployments work
- **One Vercel deployment and one Telegram bot per customer**, so each customer can have their own company-branded bot.
- **One shared Postgres database for all customers.** Every row is tagged with the bot's ID (the number before the `:` in `TELEGRAM_BOT_TOKEN`), so customers never see each other's data. Tables are created automatically on first use.
- Each deployment talks to **the customer's own Zoom account** through a Server-to-Server OAuth app they create. Nothing needs publishing on the Zoom Marketplace.

## One-time setup (you)
1. Create a Neon Postgres database -> `DATABASE_URL` (use the pooled string, host contains `-pooler`). All customers use this same value.
2. Get a Gemini key (aistudio.google.com) -> `GEMINI_API_KEY`.

## Setup per customer
1. **Zoom (the customer does this, signed in as an admin/owner of their Zoom account):**
   1. marketplace.zoom.us -> Develop -> Build App -> **Server-to-Server OAuth app**. Name it.
   2. Copy **Account ID, Client ID, Client Secret** -> `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`.
   3. Scopes -> add: `meeting:write:meeting:admin`, `meeting:read:meeting:admin`, `meeting:read:list_meetings:admin`, `meeting:update:meeting:admin`, `meeting:delete:meeting:admin`.
   4. Fill in the required app info (name, contact email), then click **Activate**. If this is skipped, the bot answers that its Zoom setup needs fixing.
2. **Telegram:** create a bot with @BotFather (the customer's company name/photo) -> `TELEGRAM_BOT_TOKEN`.
3. Pick `TELEGRAM_WEBHOOK_SECRET` (`openssl rand -hex 32`) and `ACCESS_CODE` (the passphrase the customer uses with `/login`).
4. Set `TIMEZONE` to the customer's IANA timezone (default `Africa/Tunis`).
5. Create a new Vercel project from this repo with those env vars plus the shared `DATABASE_URL` and `GEMINI_API_KEY` (see `.env.example`). Redeploy after adding any variable.
6. Register the webhook: `node scripts/set-webhook.js https://<customer-app>.vercel.app` (with that customer's `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` in your local `.env`).
7. In Telegram, the customer sends `/login <ACCESS_CODE>`.

## Where data lives (Postgres, per bot)
| Table | What | Retention |
|---|---|---|
| `chat_history` | conversation with Gemini | 24h |
| `authorized_users` | Telegram users who logged in | until `/logout` |
| `login_failures` | wrong `/login` attempts | 1h |
| `pending_actions` | delete confirmations waiting for a tap | 10 min |
| `processed_updates` | update de-dupe | 1 day |
| `meeting_zones` | timezone each meeting was booked in | until the meeting is deleted via the bot |

Expired rows are cleaned up automatically. Chat messages are also sent to Google (Gemini) to generate replies; check Google's data terms for your API key.

## Security model
- Webhook only accepts requests carrying `TELEGRAM_WEBHOOK_SECRET`.
- Users must `/login <code>`; the code message is deleted from the chat; 5 wrong tries locks that Telegram user for 1 hour.
- Gemini cannot delete anything: `delete_meeting` only creates a Confirm/Cancel prompt. A pending delete can be claimed once, only by the user it was created for. Telegram redeliveries are de-duplicated.
- The host start link starts meetings as the account owner; the bot only shows it when asked.
- **All customers share one database.** Isolation relies on every query filtering by bot ID, and anyone with `DATABASE_URL` can read every customer's data, so keep it only in your own Vercel projects.

