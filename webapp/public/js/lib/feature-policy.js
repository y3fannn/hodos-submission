// Temporary UI/UX closeout limits. Re-enabling requires approval and the checks in PRD-UIUX §5.
// These are app availability controls, not a replacement for server authorisation.
export const PAUSED_FEATURES = Object.freeze(["briefings", "deepDive", "chartInspection"]);
export const featurePaused = (key) => PAUSED_FEATURES.includes(key);

const TITLES = Object.freeze({ assistant: "Assistant", briefings: "Briefing", deepDive: "Deep dive" });
export function pausedPage(key) {
  if (!Object.hasOwn(TITLES, key)) throw new Error("Unknown paused page.");
  const title = TITLES[key];
  return {
    title,
    html: `<section class="card" data-feature-paused="${key}"><h1>${title} is temporarily unavailable</h1>
      <p>This feature is paused while known problems are checked. Your saved data has not been deleted.</p>
      <p>Use the manual forms and Records instead.</p>
      <div class="actions"><a class="btn" href="#/transactions">Open Records</a><a class="btn" href="#/home">Home</a></div></section>`,
    bind() {},
  };
}
