// Separate Sign in / Create account entries. The server binds each verification to its purpose;
// only explicit signup can create an account. design/2026-10-05-auth-entry.md.
// Both entries offer isolated demo data. Passkey approval can authenticate and unlock at once;
// Google/email identity still needs approval from an enrolled encryption-capable device.
import * as account from "../lib/account.js";
import * as vault from "../lib/vault.js";
import { html, raw, esc, field, inp, toast } from "../lib/ui.js";
import { session } from "../lib/session.js";
import { icon } from "../lib/icons.js";

// The email step survives a redraw: which address the code went to, and whether "remember me" was on.
let pending = null; // {email, intent}
let remember = true, activeIntent = null, draftEmail = "";

const showError = (root, e) => { const b = root.querySelector("[data-error]"); if (b) b.textContent = e?.message || String(e || ""); };
const busy = (btn, on, label) => { if (!btn) return; btn.disabled = on; (btn.querySelector("[data-label]") || btn).textContent = on ? "Working…" : label; btn.setAttribute("aria-busy", String(on)); };
const cancelled = (e) => (e?.name === "NotAllowedError" ? new Error("Device approval was cancelled. Try again, or use Google or an email code followed by your enrolled device.") : e);

function emailStep(intent) {
  const signup = intent === "signup", s = account.state;
  const passkey = !signup && vault.passkeysPossible();
  return `
    <h1>${signup ? "Create an account" : "Sign in"}</h1>
    <p class="auth-lede">${signup ? "Your finances, on your terms. No password needed." : "Welcome back to Hodos."}</p>
    ${passkey ? `<button class="primary block auth-method" data-action="passkey">${icon("passkey", { size: 20 })}<span data-label>Sign in with a passkey</span></button>` : ""}
    ${s.google ? `<a class="btn block auth-method auth-google" data-action="google" href="${esc(account.googleUrl(remember, intent))}"><img src="google-g.png" width="20" height="20" alt="" aria-hidden="true" /><span>Continue with Google</span></a>` : ""}
    ${s.google || passkey ? '<div class="or">Or with your email</div>' : ""}
    <form data-form="email">
      ${field("Email", `<input name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="none" spellcheck="false" required placeholder="you@example.com" value="${esc(draftEmail)}" />`)}
      <button class="primary block auth-method">${icon("email", { size: 20 })}<span data-label>Email me a code</span></button>
    </form>
    <label class="check auth-remember"><input type="checkbox" data-remember ${remember ? "checked" : ""} /> Keep me signed in for 30 days</label>
    <p class="hint">${signup ? 'After verifying your identity, set up device access. No Hodos passphrase.' : 'A passkey opens local records with one device approval. Google or an email code needs your enrolled device next.'}</p>
    ${signup ? '' : `<details class="gate-recover"><summary>Use your recovery key</summary>
      <form data-form="recovery">
        ${field("Email", '<input name="email" type="email" autocomplete="email" autocapitalize="none" spellcheck="false" required />')}
        ${field("Your 12 words, in order", '<textarea name="words" rows="3" required autocomplete="off" autocapitalize="none" spellcheck="false"></textarea>', "The first four letters of each word are enough.")}
        <button class="block">Sign in with the recovery key</button>
      </form>
    </details>`}`;
}
function codeStep() {
  return `
    <h1>Check your email</h1>
    <p>We sent a 6-digit code to <b>${esc(pending.email)}</b>. It works for 10 minutes.</p>
    ${account.state.email === "log" ? '<p class="hint">No email service is connected to this server yet, so the code is printed in the server\'s own window instead.</p>' : ""}
    <form data-form="code">
      ${field("Code", '<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required placeholder="123456" />')}
      <button class="primary block">${pending.intent === "signup" ? "Create account" : "Sign in"}</button>
    </form>
    <div class="actions"><button class="small" data-action="resend">Send a new code</button><button class="small" data-action="change">Use a different email</button></div>`;
}

// firstRun is the account gate before About you. The same entries also live under Settings.
export function signinPage({ firstRun = false, onSignedIn, query = "", intent = "signin" } = {}) {
  intent = intent === "signup" ? "signup" : "signin";
  if (activeIntent !== intent) { pending = null; activeIntent = intent; }
  const q = new URLSearchParams(query || ""), s = account.state, signup = intent === "signup";
  let body;
  if (!s.server || !s.enabled) body = '<h1>Accounts are off here</h1><p class="muted">This copy has no sign-in server. Your data stays on this device and AI help is off.</p>';
  else if (s.signedIn) body = `<h1>You're signed in</h1><p>As <b>${esc(s.account?.email || "")}</b>.</p><a class="btn block" href="#/settings">Account settings</a>`;
  else body = pending?.intent === intent ? codeStep() : emailStep(intent);
  const error = q.get("error") === "google" ? "Google didn't finish. Try again, or use your email." : q.get("error") === "account_missing" ? "That Google sign-in has no Hodos account yet. Choose Create account to get started." : "";
  return {
    title: signup ? "Create account" : "Sign in",
    html: html`<section class="gate auth-entry" aria-label="${signup ? "Create account" : "Sign in"}">
      <div class="auth-brand"><img src="icon.svg?v=hvault1" width="64" height="64" alt="" aria-hidden="true" /><span class="wordmark">Hodos</span></div>
      <div class="card auth-card">${raw(body)}<div class="error" data-error role="alert">${error}</div></div>
      <p class="auth-switch">${signup ? "Already have an account?" : "New to Hodos?"} <a href="${signup ? "#/signin" : "#/signup"}" data-entry-switch>${signup ? "Sign in" : "Create an account"}</a></p>
      <p class="auth-privacy">Your real financial records stay encrypted on this device.</p>
      ${s.signedIn ? "" : raw('<p class="center"><button class="linkish" data-action="demo">Try it out first</button></p>')}
    </section>`,
    bind(root) {
      const done = async (r) => { pending = null; draftEmail = ""; if (!firstRun || signup) toast(account.state.deviceVerified ? "Device access approved" : "Identity checked. Set up or approve device access next."); await onSignedIn?.(r); };
      if (q.get("done") === "google" && s.signedIn && !firstRun) toast("Signed in with Google");
      root.querySelector("[data-remember]")?.addEventListener("change", (e) => { remember = e.target.checked; root.querySelector("[data-action=google]")?.setAttribute("href", account.googleUrl(remember, intent)); });
      root.querySelector("[data-entry-switch]")?.addEventListener("click", () => { draftEmail = root.querySelector("[data-form=email] input")?.value || pending?.email || draftEmail; pending = null; });
      root.querySelector("[data-action=demo]")?.addEventListener("click", () => { pending = null; session.startDemo().catch((e) => showError(root, e)); });
      root.querySelector("[data-action=passkey]")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        busy(btn, true, "Sign in with a passkey"); showError(root, "");
        try { await done(await account.passkeySignIn(remember)); } catch (ex) { showError(root, cancelled(ex)); busy(btn, false, "Sign in with a passkey"); }
      });
      root.querySelector("[data-form=email]")?.addEventListener("submit", async (e) => {
        e.preventDefault(); const form = e.currentTarget, btn = form.querySelector("button"), email = String(new FormData(form).get("email") || "").trim();
        draftEmail = email; busy(btn, true, "Email me a code"); showError(root, "");
        // The same intent may be revisited while mail is in flight; only the original live form owns its reply.
        try { await account.startEmail(email, intent); if (activeIntent === intent && form.isConnected) { pending = { email, intent }; session.render(); } }
        catch (ex) { if (form.isConnected) { showError(root, ex); busy(btn, false, "Email me a code"); } }
      });
      root.querySelector("[data-form=code]")?.addEventListener("submit", async (e) => {
        e.preventDefault(); const form = e.currentTarget, btn = form.querySelector("button"), attempt = pending;
        if (!attempt) return;
        const label = signup ? "Create account" : "Sign in";
        busy(btn, true, label); showError(root, "");
        try { await done(await account.verifyEmail(attempt.email, String(new FormData(form).get("code") || ""), remember, attempt.intent)); }
        catch (ex) { if (ex.code === "CODE_EXPIRED") form.reset(); showError(root, ex); busy(btn, false, label); }
      });
      root.querySelector("[data-action=resend]")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget, attempt = pending;
        if (!attempt) return;
        busy(btn, true, "Send a new code");
        try { await account.startEmail(attempt.email, attempt.intent); if (btn.isConnected) { showError(root, ""); toast("A new code is on its way"); } } catch (ex) { if (btn.isConnected) showError(root, ex); }
        finally { if (btn.isConnected) busy(btn, false, "Send a new code"); }
      });
      root.querySelector("[data-action=change]")?.addEventListener("click", () => { pending = null; session.render(); });
      root.querySelector("[data-form=recovery]")?.addEventListener("submit", async (e) => {
        e.preventDefault(); const form = e.currentTarget, f = new FormData(form), btn = form.querySelector("button");
        busy(btn, true, "Sign in with the recovery key"); showError(root, "");
        try { await done(await account.recoverySignIn(String(f.get("email") || "").trim(), String(f.get("words") || ""), remember)); }
        catch (ex) { showError(root, ex); busy(btn, false, "Sign in with the recovery key"); }
      });
      setTimeout(() => { if (root.isConnected) root.querySelector("[data-form=code] input, [data-form=email] input")?.focus(); }, 30);
    },
  };
}

// ---------- Settings → Account ----------
const money = (n) => `US$${(Math.round(n * 100) / 100).toFixed(2)}`;
export function accountCard() {
  const s = account.state;
  if (!s.server || !s.enabled) return `<div class="card"><h2>Account</h2><p class="muted">This copy of the app has no server that signs people in, so there is no account. Everything stays on this device.</p></div>`;
  if (!s.signedIn) return `<div class="card"><h2>Account</h2><p class="muted">Not signed in. Sign in and approve device access to use your records and AI help.</p><div class="actions"><a class="btn primary" href="#/signin">Sign in</a></div></div>`;
  const a = s.account, ways = ["Email code", a.passkeys ? `Passkey${a.passkeys > 1 ? ` (${a.passkeys})` : ""}` : null, a.google ? "Google" : null, a.recovery ? "Recovery key" : null].filter(Boolean);
  return `<div class="card"><h2>Account</h2>
    <div class="kv"><span>Email</span><b>${esc(a.email)}</b></div>
    <div class="kv"><span>Ways to sign in</span><b>${esc(ways.join(" · "))}</b></div>
    ${s.ai ? `<div class="kv"><span>Estimated AI cost · ${esc(s.ai.month)}</span><b>${s.ai.estimated_usd == null ? "Unavailable" : money(s.ai.estimated_usd)}</b></div><p class="hint">Estimate from reported token usage, not your provider invoice.${s.ai.unavailable_calls ? ` Usage unavailable for ${s.ai.unavailable_calls} attempt(s); any shown amount is only the known subtotal.` : ""} Spending controls stay in Claude Platform.</p>` : ""}
    <div class="kv"><span>Signed in on</span><b>${a.sessions} ${a.sessions === 1 ? "device" : "devices"}</b></div>
    <p class="hint">Signing out locks your records immediately and stops AI help here. Your encrypted records stay on this device.</p>
    <div class="actions"><button data-account="signout">Sign out</button>${a.sessions > 1 ? '<button data-account="everywhere">Sign out everywhere</button>' : ""}<button class="danger" data-account="delete">Delete account</button></div></div>`;
}
export function bindAccountCard(root, { modal }) {
  const after = (msg) => { toast(msg); session.render(); };
  root.querySelector("[data-account=signout]")?.addEventListener("click", async () => { try { await account.signOut(); after("Signed out. Your data stays on this device."); } catch (e) { toast(e.message); } });
  root.querySelector("[data-account=everywhere]")?.addEventListener("click", () => modal({ title: "Sign out everywhere?", submitLabel: "Sign out everywhere",
    body: "<p>Every device signed in to your account is signed out, this one too. Data on each device stays there.</p>",
    onSubmit: async () => { await account.signOutEverywhere(); after("Signed out everywhere"); } }));
  root.querySelector("[data-account=delete]")?.addEventListener("click", () => modal({ title: "Delete your account?", submitLabel: "Delete account", danger: true,
    body: `<p>This deletes everything our server holds about you: your email address, your passkeys' public halves, your recovery key's fingerprint, your sessions and your AI usage.</p><p>Your money data on this device is not touched. To delete that too, use <b>Wipe everything</b> under Your data.</p>${field("Type your email to confirm", inp("confirm", { type: "email", required: true }))}`,
    onSubmit: async (f) => { await account.deleteAccount(String(f.get("confirm") || "")); after("Account deleted"); } }));
}
