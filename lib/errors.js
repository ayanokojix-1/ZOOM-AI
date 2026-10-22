// A problem the user can fix (bad date, unknown meeting, Zoom refused). Its message is
// safe to pass to Gemini so it can explain it or ask again. Anything else is a bug or outage.
class UserError extends Error {}

module.exports = { UserError };
