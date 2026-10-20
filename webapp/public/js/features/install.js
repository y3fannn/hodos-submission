// "Add to Home Screen": putting the app's icon on the phone's home screen, so it opens like an app.
// On an iPhone this is what keeps its data: Safari deletes a website's stored data after 7 days
// unopened, and a home-screen app is exempt. Chrome on Android and computers offers a one-tap install.
import { esc } from "../lib/ui.js";

const HIDE_KEY = "pfa.install.hide_until"; // a device preference, like the theme; not user data
let deferred = null; // Chrome's install prompt, kept for the button
export function captureInstallPrompt() {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; });
  window.addEventListener("appinstalled", () => { deferred = null; });
}
export const installed = () => typeof window !== "undefined" && (window.matchMedia?.("(display-mode: standalone)").matches || window.navigator?.standalone === true);
const ua = () => (typeof navigator !== "undefined" ? navigator.userAgent : "");
export const platform = () => {
  if (/MicroMessenger|FBAN|FBAV|Instagram|Line\//i.test(ua())) return "in-app";
  if (/iPhone|iPad|iPod/.test(ua()) || (typeof navigator !== "undefined" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
  return deferred ? "prompt" : "other";
};
function hidden() { try { return Date.now() < Number(localStorage.getItem(HIDE_KEY) || 0); } catch { return false; } }

export function hintHtml() {
  if (installed() || hidden()) return "";
  const how = {
    ios: "Tap the Share button, then <b>Add to Home Screen</b>. Safari deletes data from websites left unopened for 7 days; an app on the home screen is kept.",
    prompt: "Install it, and it opens like any other app, with its data kept.",
    "in-app": "This is a browser inside another app, where the data may not be kept. Open the link in Safari or Chrome, then add it to your home screen.",
    other: "Use your browser's menu to add it to your home screen, or install it, so its data is kept.",
  }[platform()];
  return `<div class="card nudge"><div class="nudge-text"><b>Put this app on your home screen.</b> ${how}</div>
    <div class="actions">${platform() === "prompt" ? '<button class="primary small" data-install="now">Install</button>' : ""}<button class="small" data-install="later">Not now</button></div></div>`;
}
export function bindHint(root, rerender) {
  root.querySelector("[data-install=now]")?.addEventListener("click", async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice.catch(() => {}); deferred = null; rerender(); });
  root.querySelector("[data-install=later]")?.addEventListener("click", () => { try { localStorage.setItem(HIDE_KEY, String(Date.now() + 14 * 86400000)); } catch {} rerender(); });
}
