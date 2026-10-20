// One drawn icon set for the whole app. Nothing renders as emoji: an emoji is somebody else's
// artwork, it changes shape on every platform, it cannot take the app's colour, and at tab-bar size
// it reads as a sticker rather than a control. These are plain strokes on a 24-unit grid that
// inherit currentColor, so they sit in the palette instead of fighting it.
//
// Adding one: keep the 24x24 box, draw with strokes rather than fills, leave about 2 units of air on
// every side, and give it the same visual weight as its neighbours.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const P = {
  // ---- the bar, the chrome, the features ----
  home: '<path d="M3.6 10.4 12 3.5l8.4 6.9"/><path d="M6 9.8V19a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.8"/>',
  records: '<path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4z"/><path d="M9 8.5h6"/><path d="M9 12.5h6"/>',
  add: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  assistant: '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4z"/><path d="m12 6.3.95 2.45L15.4 9.7l-2.45.95L12 13.1l-.95-2.45L8.6 9.7l2.45-.95z"/>',
  settings: '<circle cx="12" cy="12" r="7.2"/><circle cx="12" cy="12" r="2.8"/><path d="M19.2 12h2" stroke-width="2.4"/><path d="m17.1 17.1 1.4 1.4" stroke-width="2.4"/><path d="M12 19.2v2" stroke-width="2.4"/><path d="m6.9 17.1-1.4 1.4" stroke-width="2.4"/><path d="M4.8 12h-2" stroke-width="2.4"/><path d="m6.9 6.9-1.4-1.4" stroke-width="2.4"/><path d="M12 4.8v-2" stroke-width="2.4"/><path d="m17.1 6.9 1.4-1.4" stroke-width="2.4"/>',
  budgets: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.4"/>',
  accounts: '<path d="M4 10h16"/><path d="m5 10 7-5 7 5"/><path d="M6.5 10v7"/><path d="M12 10v7"/><path d="M17.5 10v7"/><path d="M4 19.5h16"/>',
  networth: '<path d="M3.5 20h17"/><path d="M6 20v-7"/><path d="M12 20V5.5"/><path d="M18 20v-4.5"/>',
  investments: '<path d="m4 16.5 5-5.5 3.5 3L20 6"/><path d="M15.5 6H20v4.5"/>',
  goals: '<path d="M6 20.5V4"/><path d="M6 4.8h9.5l-1.7 3.1 1.7 3.1H6"/>',
  debts: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10.5h18"/>',
  insurance: '<path d="M12 3.2 19 6v5.4c0 4.1-2.8 7.4-7 8.8-4.2-1.4-7-4.7-7-8.8V6z"/>',
  briefing: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7 9h6"/><path d="M7 12.5h6"/><path d="M7 16h4"/><path d="M16.5 9v7"/>',
  deepdive: '<circle cx="11" cy="11" r="6.3"/><path d="m15.6 15.6 4.4 4.4"/>',
  recurring: '<path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3L20 9"/><path d="M19.5 12a7.5 7.5 0 0 1-12.8 5.3L4 15"/><path d="M20 5v4h-4"/><path d="M4 19v-4h4"/>',
  categories: '<path d="M20 4v7.6L11.6 20 4 12.4 12.4 4z"/><circle cx="16.3" cy="7.7" r="1.2"/>',
  alerts: '<path d="M18 8.5a6 6 0 1 0-12 0c0 6.5-3 7.5-3 7.5h18s-3-1-3-7.5"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/>',
  // ---- the brand mark, and the chrome that is not a feature ----
  wallet: '<rect x="3" y="6.5" width="18" height="12" rx="2.5"/><path d="M3 10.5h18"/><circle cx="16.8" cy="14.5" r="1.3"/>',
  lock: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15" r="1.4"/>',
  passkey: '<circle cx="8" cy="8" r="4.2"/><path d="m11 11 8.7 8.7m-3.2-3.2 2.3-2.3m-5 0 2.2-2.2"/>',
  email: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
  faceid: '<path d="M4 8V6.5A2.5 2.5 0 0 1 6.5 4H8"/><path d="M16 4h1.5A2.5 2.5 0 0 1 20 6.5V8"/><path d="M20 16v1.5a2.5 2.5 0 0 1-2.5 2.5H16"/><path d="M8 20H6.5A2.5 2.5 0 0 1 4 17.5V16"/><path d="M9 10v1.5"/><path d="M15 10v1.5"/><path d="M9.5 15c1.6 1.2 3.4 1.2 5 0"/>',
  transfer: '<path d="M4 8.5h13l-3-3"/><path d="M20 15.5H7l3 3"/>',
  close: '<path d="m6 6 12 12"/><path d="M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  warning: '<path d="m12 4.5 8.5 15h-17z"/><path d="M12 10v4"/><path d="M12 17v.01"/>',
  camera: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8.5 7 10 4.5h4L15.5 7"/><circle cx="12" cy="13.5" r="3.2"/>',
  overseas: '<path d="M3 12 21 5l-7 18-2.6-8.4z"/>',
  upload: '<path d="M12 16V4"/><path d="M7.5 8.5 12 4l4.5 4.5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  // ---- category groups: one per group, as ruled on 2026-09-17 ----
  food: '<path d="M3.5 11h17a8.5 8.5 0 0 1-17 0z"/><path d="M8 8c0-1.5 1-2 1-3"/><path d="M12 8c0-1.5 1-2 1-3"/><path d="M16 8c0-1.5 1-2 1-3"/>',
  transport: '<rect x="4" y="4.5" width="16" height="12" rx="2"/><path d="M4 11h16"/><path d="M7.5 20v-3"/><path d="M16.5 20v-3"/><circle cx="8" cy="14" r="1"/><circle cx="16" cy="14" r="1"/>',
  housing: '<path d="M3.6 10.4 12 3.5l8.4 6.9"/><path d="M6 9.8V19a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.8"/><path d="M10.5 20v-5h3v5"/>',
  bills: '<path d="M9.5 18h5"/><path d="M10 21h4"/><path d="M12 3a5.5 5.5 0 0 0-3.2 10c.6.5 1 1.2 1.1 2h4.2c.1-.8.5-1.5 1.1-2A5.5 5.5 0 0 0 12 3z"/>',
  health: '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M12 8.2v7.6"/><path d="M8.2 12h7.6"/>',
  shopping: '<path d="M6 8h12l-1 12H7z"/><path d="M9.5 8V6.5a2.5 2.5 0 0 1 5 0V8"/>',
  entertainment: '<circle cx="12" cy="12" r="8.5"/><path d="m10.2 9 4.8 3-4.8 3z"/>',
  travel: '<path d="M3 12 21 5l-7 18-2.6-8.4z"/>',
  education: '<path d="M12 6.6C10.5 5.1 8 4.5 4.5 4.5V18c3.5 0 6 .6 7.5 2.1 1.5-1.5 4-2.1 7.5-2.1V4.5c-3.5 0-6 .6-7.5 2.1z"/><path d="M12 6.6v13.5"/>',
  family: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19.5c0-3 2.5-5.5 5.5-5.5s5.5 2.5 5.5 5.5"/><path d="M16 6.6a3 3 0 0 1 0 5.8"/><path d="M17 14.4c2 .7 3.5 2.6 3.5 5.1"/>',
  giving: '<path d="M3.5 9h17v4h-17z"/><path d="M5 13v7h14v-7"/><path d="M12 9v11"/><path d="M12 9S10.6 5 8.6 5a2 2 0 0 0 0 4"/><path d="M12 9s1.4-4 3.4-4a2 2 0 0 1 0 4"/>',
  fees: '<circle cx="8" cy="8" r="2.8"/><circle cx="16" cy="16" r="2.8"/><path d="M19 5 5 19"/>',
  salary: '<rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5"/><path d="M3.5 13h17"/>',
  business: '<rect x="5" y="5.5" width="14" height="10" rx="1.5"/><path d="M3 19h18"/>',
  refunds: '<path d="M20 11a8 8 0 1 0-2.4 5.7"/><path d="M20 5v6h-6"/>',
  otherincome: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7"/><path d="M8.5 12h7"/>',
  ai: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="m18.4 15.4.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  dot: '<circle cx="12" cy="12" r="3"/>',
};

// `label` gives the icon a name for a screen reader; without one it is decorative and hidden, which
// is right whenever a visible word already sits beside it.
export function icon(name, { size = 22, label = "", cls = "" } = {}) {
  const d = P[name] || P.dot;
  const a = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
  return `<svg class="ic-svg${cls ? ` ${cls}` : ""}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${a}>${d}</svg>`;
}

export const has = (name) => Object.prototype.hasOwnProperty.call(P, name);
export const names = () => Object.keys(P);
