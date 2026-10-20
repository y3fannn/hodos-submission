// Light or dark is a property of this device, not of the data, so it lives in its own key rather
// than in the store: a backup restored on another device leaves that device's own choice alone,
// and index.html can read it before the first paint so the app never flashes the wrong colours.
const KEY = "pfa.theme";
export const MODES = ["system", "light", "dark"];
export function theme() {
  try { const v = localStorage.getItem(KEY); return MODES.includes(v) ? v : "system"; } catch { return "system"; }
}
export function apply(mode = theme()) {
  const el = document.documentElement;
  if (mode === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", mode);
  // The browser paints its own chrome from this, so it has to follow the choice too.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", getComputedStyle(el).getPropertyValue("--surface").trim() || "#16307a");
}
export function setTheme(mode) {
  try { localStorage.setItem(KEY, MODES.includes(mode) ? mode : "system"); } catch {}
  apply(mode);
}
