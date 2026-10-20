// Device approval opens encrypted local records. No Hodos passphrase or legacy migration.
// Recovery words remain a temporary separate path while the backup architecture is open.
import * as vault from "../lib/vault.js";
import * as account from "../lib/account.js";
import { html, raw, esc, modal, field, inp, toast } from "../lib/ui.js";
import { icon } from "../lib/icons.js";

const showError = (root, e) => { const b = root.querySelector("[data-error]"); if (b) b.textContent = e?.message || String(e || ""); };
const busy = (btn, on, label) => { btn.disabled = on; btn.textContent = on ? "Working…" : label; };
const deviceError = (e) => e?.name === "NotAllowedError" ? new Error("Device approval was cancelled. Try again when you are ready.") : e;
const supportHint = "Use a supported browser, device or security key. Your device may ask for its PIN, fingerprint or face. Hodos never receives these.";

export function setupPage({ onCreated, onBack = null }) {
  const canPasskey = vault.passkeysPossible();
  const mustApprove = account.state.signedIn && account.state.account?.passkeys > 0 && !account.state.deviceVerified;
  const label = mustApprove ? "Approve with an existing device" : "Set up device access";
  return {
    title: "Device access",
    html: html`<div class="gate card">
      <h2>Protect your records with a passkey</h2>
      <p>Your records stay encrypted in this browser.</p>
      ${canPasskey ? raw(`<button class="primary block" data-action="passkey">${label}</button>`) : raw('<p class="error">This browser cannot use passkeys. Open Hodos in a supported browser or use another device.</p>')}
      <p class="hint">${supportHint}</p><div class="error" data-error role="alert"></div>
      ${account.state.signedIn ? raw('<button class="linkish" data-action="switch-account">Use another account</button>') : ""}
    </div>${onBack ? raw('<p class="center"><button class="linkish" data-action="back">‹ Back to About you</button></p>') : ""}`,
    bind(root) {
      root.querySelector("[data-action=back]")?.addEventListener("click", onBack);
      root.querySelector("[data-action=switch-account]")?.addEventListener("click", () => account.signOut().catch((e) => showError(root, e)));
      root.querySelector("[data-action=passkey]")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget; busy(btn, true, label);
        try {
          if (mustApprove) { await account.approveDevice(); location.reload(); return; }
          const owner = vault.ownerId(), { pk } = await account.newPasskey();
          try {
            if (account.state.signedIn && owner !== account.state.account?.id) throw new Error("The account changed. Sign in again before setting up device access.");
            const created = await vault.create({ passkey: pk });
            await onCreated(created.words);
          } finally { pk.secret.fill(0); }
        } catch (ex) { showError(root, deviceError(ex)); busy(btn, false, label); }
      });
    },
  };
}

const asked = new WeakMap();
export function recoveryPage({ words, onConfirmed, replacing = false }) {
  if (!asked.has(words)) asked.set(words, pickTwo());
  const [a, b] = asked.get(words);
  return {
    title: "Your recovery key",
    html: html`<div class="gate card">
      <h2>${replacing ? "Your new recovery key" : "Keep your recovery key safe"}</h2>
      <p>These 12 words are a spare key to your encrypted records. Keep them offline and separate from this device. Anyone with the words and your encrypted records can open them.</p>
      <p class="hint">A key cannot restore deleted records. You also need an encrypted records backup. Cloud backup and the new recovery document are not available yet.</p>
      <ol class="words">${raw(words.map((w) => `<li>${esc(w)}</li>`).join(""))}</ol>
      <form data-form="confirm"><p>To check, type word ${a + 1} and word ${b + 1}.</p>
        <div class="inline">${raw(field(`Word ${a + 1}`, inp("wa", { required: true })))}${raw(field(`Word ${b + 1}`, inp("wb", { required: true })))}</div>
        <button class="primary block">I have kept them safe</button>
      </form><div class="error" data-error role="alert"></div>
    </div>`,
    bind(root) {
      root.querySelector("[data-form=confirm]").onsubmit = async (e) => {
        e.preventDefault(); const f = new FormData(e.target), btn = e.target.querySelector("button");
        const ok = (i, v) => { const t = String(v || "").trim().toLowerCase(); return t === words[i] || (t.length >= 4 && words[i].startsWith(t.slice(0, 4))); };
        if (!ok(a, f.get("wa")) || !ok(b, f.get("wb"))) return showError(root, new Error("Those words do not match. Check your saved words."));
        busy(btn, true, "I have kept them safe");
        try { await onConfirmed(); }
        catch (ex) { showError(root, ex); busy(btn, false, "I have kept them safe"); }
      };
    },
  };
}
function pickTwo() {
  const r = crypto.getRandomValues(new Uint32Array(2));
  const a = r[0] % 12; let b = r[1] % 11; if (b >= a) b++;
  return a < b ? [a, b] : [b, a];
}

export function lockPage({ status, onUnlocked }) {
  const canPasskey = status.passkey && vault.passkeysPossible();
  return {
    title: "Unlock",
    html: html`<div class="gate card">
      <div class="gate-mark">${raw(icon("lock", { size: 40 }))}</div><h2>Approve access on your device</h2>
      <p>Your records are locked. Use the passkey already enrolled for this account.</p>
      ${canPasskey ? raw('<button class="primary block" data-action="passkey">Unlock with your device</button>') : raw('<p class="error">This setup cannot unlock these records here. Try a supported browser, device or security key.</p>')}
      <p class="hint">${supportHint}</p>
      <details class="gate-recover"><summary>Use your recovery key</summary><form data-form="words">
        ${raw(field("Your 12 words, in order", '<textarea name="words" rows="3" required autocomplete="off" autocapitalize="none" spellcheck="false"></textarea>'))}
        <button class="block">Unlock with the recovery key</button>
      </form></details><div class="error" data-error role="alert"></div>
      <button class="linkish" data-action="switch-account">Sign in to another account</button>
      <a href="#/signup" data-action="signup">Create an account</a>
    </div>`,
    bind(root) {
      const attempt = async (btn, label, open) => {
        busy(btn, true, label);
        try { const { data, factor } = await open(); await onUnlocked(data, factor); }
        catch (ex) { showError(root, deviceError(ex)); busy(btn, false, label); }
      };
      root.querySelector("[data-action=passkey]")?.addEventListener("click", (e) => attempt(e.currentTarget, "Unlock with your device", () => account.unlockDevice()));
      root.querySelector("[data-form=words]").onsubmit = (e) => {
        e.preventDefault(); const words = String(new FormData(e.target).get("words"));
        attempt(e.target.querySelector("button"), "Unlock with the recovery key", async () => {
          if (account.state.signedIn) await account.recoverySignIn(account.state.account.email, words, true);
          const factor = { words }; return { data: await vault.unlock(factor), factor };
        });
      };
      const leave = async (hash) => {
        try { if (account.state.signedIn) await account.signOut(); location.hash = hash; }
        catch (e) { showError(root, e); }
      };
      root.querySelector("[data-action=switch-account]").onclick = () => leave("#/signin");
      root.querySelector("[data-action=signup]").onclick = (e) => { e.preventDefault(); leave("#/signup"); };
    },
  };
}

export async function askFactor({ title, body = "", submitLabel, onFactor }) {
  const s = await vault.status();
  return modal({ title, submitLabel,
    body: `${body}<p>Approve with your enrolled device, or enter your recovery words.</p><details><summary>Use the recovery key</summary>${field("Your 12 words", '<textarea name="curwords" rows="3" autocomplete="off" autocapitalize="none" spellcheck="false"></textarea>')}</details>`,
    onSubmit: async (f) => {
      const words = String(f.get("curwords") || "").trim();
      let factor;
      if (words) factor = { words };
      else if (s.passkey) { const approved = await account.unlockDevice(); factor = approved.factor; }
      else throw new Error("Use an enrolled device or your recovery key.");
      try { return await onFactor(factor, f); }
      finally { factor.passkeySecret?.fill(0); }
    } });
}
export function lockCard() {
  return `<div class="card"><h2>Device access</h2><p class="muted">Records are encrypted locally. The app locks after 5 minutes idle or in the background. No Hodos passphrase.</p>
    <div class="actions"><button class="primary" data-lock="now">Lock now</button><button data-lock="passkey">Replace this device's passkey</button><button data-lock="recovery">New recovery key</button></div></div>`;
}
export function bindLockCard(root, { lockNow, showRecovery }) {
  root.querySelector("[data-lock=now]")?.addEventListener("click", lockNow);
  root.querySelector("[data-lock=passkey]")?.addEventListener("click", () => askFactor({ title: "Replace this device's passkey", body: "<p>The old passkey will no longer open this browser's vault. This does not enroll a backup device.</p>", submitLabel: "Set up passkey",
    onFactor: async (factor) => { const { pk } = await account.newPasskey(); try { await vault.addPasskey(factor, pk); } finally { pk.secret.fill(0); } toast("Device access set up"); } }));
  root.querySelector("[data-lock=recovery]")?.addEventListener("click", () => askFactor({ title: "New recovery key", body: "<p>The old words will no longer open this vault. Old exported backups may still use them.</p>", submitLabel: "Make a new one",
    onFactor: async (factor) => { const words = await vault.replaceRecovery(factor); showRecovery(words); } }));
}
