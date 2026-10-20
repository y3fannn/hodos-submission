// Login mail only; never send financial data. design/2026-10-05-email-codes.md.
// Provider details (which may echo the message or API key) never escape this module.
const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "Hodos <no-reply@hodos.consulting>";
const SEND_TIMEOUT_MS = 8000;
const failed = () => Object.assign(new Error("We couldn't send a code. Try again in a minute, or use Google or a passkey."), { code: "EMAIL_FAILED" });

export function createEmailSender({ env = process.env, fetchImpl = fetch } = {}) {
  const mode = String(env.EMAIL_MODE || (env.NODE_ENV === "production" ? "off" : "log")).trim();
  if (!["off", "log", "resend"].includes(mode)) throw new Error("EMAIL_MODE must be off, log, or resend.");
  if (mode === "log" && env.NODE_ENV === "production") {
    throw new Error("EMAIL_MODE=log is refused in production: sign-in codes would be written to the log.");
  }
  const key = String(env.RESEND_API_KEY || "").trim();
  const from = String(env.EMAIL_FROM || DEFAULT_FROM).trim();
  if (mode === "resend" && !key) throw new Error("EMAIL_MODE=resend requires RESEND_API_KEY.");
  if (mode === "resend" && (!from || /[\r\n]/.test(from))) throw new Error("EMAIL_FROM must be a single sender address.");

  return {
    mode,
    async send(to, subject, text) {
      if (mode === "off") throw failed();
      if (mode === "log") {
        const masked = to.replace(/^(.).*(@.*)$/, "$1***$2");
        console.log(`[email not sent: local log mode] to ${masked}: ${subject}\n  ${text.split("\n")[0]}`);
        return;
      }
      try {
        const response = await fetchImpl(RESEND_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [to], subject, text }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          redirect: "error",
        });
        if (!response.ok) {
          // Do not parse provider error text: it may contain the code or recipient.
          await response.body?.cancel();
          throw failed();
        }
        const result = await response.json();
        if (typeof result?.id !== "string" || !result.id.trim()) throw failed();
      } catch {
        // Includes HTTP rejection, timeout, network error and malformed success JSON.
        throw failed();
      }
    },
  };
}
