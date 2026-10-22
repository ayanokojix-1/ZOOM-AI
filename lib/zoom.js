// Zoom REST API with Server-to-Server OAuth (plain fetch, no SDK).
// One access token for the whole Zoom account, requested with the account credentials.
// There is no refresh token: when it expires we just request a new one. Cached in memory,
// so a warm serverless instance reuses it and a cold one requests its own.
const { UserError } = require("./errors");

const TOKEN_URL = "https://zoom.us/oauth/token";
const API_BASE_URL = "https://api.zoom.us/v2";
const RENEW_SKEW_MS = 5 * 60 * 1000; // get a new token if it expires within this window

let cached = null; // { token, expiresAt }
let pending = null;

async function requestToken() {
  const auth = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body: new URLSearchParams({ grant_type: "account_credentials", account_id: process.env.ZOOM_ACCOUNT_ID }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // Wrong Account ID / Client ID / Client Secret, or the Zoom app isn't activated.
    console.error("Zoom token request failed:", res.status, data);
    throw new UserError("Couldn't sign in to Zoom. The bot's Zoom setup needs fixing; tell the user to contact the admin.");
  }
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cached.token;
}

// staleToken: Zoom rejected this token, so get a new one unless another request already did.
// Concurrent callers share one in-flight request.
async function getAccessToken(staleToken) {
  const fresh = cached && cached.expiresAt - Date.now() > RENEW_SKEW_MS;
  if (fresh && cached.token !== staleToken) return cached.token;
  pending ??= requestToken().finally(() => {
    pending = null;
  });
  return pending;
}

// Returns the parsed JSON body (null for 204). Gets a new token and retries once on 401.
async function zoomRequest({ method, path, query, body }) {
  const url = new URL(API_BASE_URL + path);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const send = (token) =>
    fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body && { "Content-Type": "application/json" }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

  let token = await getAccessToken();
  let res = await send(token);
  if (res.status === 401) res = await send(await getAccessToken(token));

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text.slice(0, 200) };
  }
  if (!res.ok) {
    console.error(`Zoom ${method} ${path} failed:`, res.status, data);
    throw new UserError(`Zoom error: ${data?.message || `HTTP ${res.status}`}`);
  }
  return data;
}

module.exports = { zoomRequest };
